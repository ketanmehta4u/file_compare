import ExcelJS from "exceljs";
import { toDecimal } from "./decimal";
import { inferColumnDtype } from "./fileLoad/csv";
import { decodeWithFallback, sniffDelimiter, loadCsv } from "./fileLoad/csv";
import { sha256Hex } from "./fileLoad/hash";
import type { ColumnMapping, DatasetCatalog, DatasetEntry, FileMeta, MappingEntry, Table } from "./types";

const TRUTHY_TOKENS = new Set(["y", "yes", "true", "t", "1", "key", "k"]);
const FALSY_TOKENS = new Set(["n", "no", "false", "f", "0"]);

function parseIsKey(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  return TRUTHY_TOKENS.has(String(raw).trim().toLowerCase());
}

function parseOptionalBool(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "") return null;
  if (TRUTHY_TOKENS.has(s)) return true;
  if (FALSY_TOKENS.has(s)) return false;
  return null;
}

function parseOptionalDecimal(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  return toDecimal(s);
}

/** Port of comparison.py's `mapping_from_pairs`: builds a ColumnMapping
 * from an explicit source->target column pairing (the UI's inline
 * mapping). Empty target values (a source column the user chose to
 * ignore) are dropped. */
export function mappingFromPairs(pairs: ReadonlyMap<string, string>): ColumnMapping {
  const entries: MappingEntry[] = [];
  for (const [source, target] of pairs) {
    if (!target) continue;
    entries.push({
      canonicalName: target,
      sourceColumn: source,
      isKey: false,
      keyRole: "",
      dtype: null,
      description: "",
    });
  }
  return { entries, sha256: "", sourceName: "(inline column mapping)", dataset: null };
}

/** Port of ColumnMapping.source_rename_map: {file-side name -> canonical
 * name} for the source file only. */
export function sourceRenameMap(mapping: ColumnMapping): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of mapping.entries) m.set(e.sourceColumn || e.canonicalName, e.canonicalName);
  return m;
}

export function canonicalNames(mapping: ColumnMapping): string[] {
  return mapping.entries.map((e) => e.canonicalName);
}

const KEY_ROLE_PRECEDENCE = ["surrogate", "composite", "primary"] as const;

/** Port of ColumnMapping.key_canonical_names: surrogate beats composite
 * beats primary; falls back to plain isKey when no roles are set. */
export function keyCanonicalNames(mapping: ColumnMapping): string[] {
  for (const role of KEY_ROLE_PRECEDENCE) {
    const cols = mapping.entries.filter((e) => e.keyRole === role).map((e) => e.canonicalName);
    if (cols.length > 0) return cols;
  }
  return mapping.entries.filter((e) => e.isKey).map((e) => e.canonicalName);
}

/** Port of DatasetCatalog.get_mapping_for: projects the catalogue down to
 * a single-dataset ColumnMapping. */
export function getMappingFor(catalog: DatasetCatalog, datasetId: string): ColumnMapping {
  const dataset = catalog.datasets.find((d) => d.datasetId === datasetId) ?? null;
  const entries = catalog.columns.filter(([did]) => did === datasetId).map(([, e]) => e);
  return {
    entries,
    sha256: catalog.sha256,
    sourceName: catalog.sourceName ? `${catalog.sourceName}#${datasetId}` : datasetId,
    dataset,
  };
}

function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/ /g, "_");
}

async function readSheetAsRows(
  data: Buffer,
  fileName: string
): Promise<{ datasetsRows: Array<Record<string, string>> | null; columnsRows: Array<Record<string, string>> }> {
  const ext = fileName.toLowerCase().split(".").pop();

  if (ext === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
    const sheetByLower = new Map(wb.worksheets.map((ws) => [ws.name.toLowerCase(), ws]));

    const readSheet = (ws: ExcelJS.Worksheet): Array<Record<string, string>> => {
      const width = ws.actualColumnCount;
      const raw: string[][] = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= width; c++) {
          const v = row.getCell(c).value;
          cells.push(v === null || v === undefined ? "" : String(v));
        }
        raw.push(cells);
      });
      if (raw.length === 0) return [];
      const header = raw[0].map(normaliseHeader);
      return raw.slice(1).map((r) => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => (obj[h] = r[i] ?? ""));
        return obj;
      });
    };

    const datasetsWs = sheetByLower.get("datasets");
    const columnsWs = sheetByLower.get("columns");
    if (!columnsWs) {
      throw new Error(`${fileName}: catalogue workbook must contain a 'Columns' sheet.`);
    }
    return {
      datasetsRows: datasetsWs ? readSheet(datasetsWs) : null,
      columnsRows: readSheet(columnsWs),
    };
  }

  if (ext === "xls") {
    throw new Error(`${fileName}: legacy .xls format is not supported in this port -- please re-save as .xlsx or .csv.`);
  }

  // CSV path: the file IS the Columns sheet.
  const { table } = loadCsv(data, fileName);
  const columnsRows = table.rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const c of table.columns) obj[normaliseHeader(c)] = String(r[c] ?? "");
    return obj;
  });
  return { datasetsRows: null, columnsRows };
}

/**
 * Port of comparison.py's `load_catalog`. Parses a catalogue workbook
 * (Columns sheet required, optional Datasets sheet) or a CSV (treated as
 * the Columns sheet directly) into a DatasetCatalog.
 */
export async function loadCatalog(data: Buffer, fileName: string): Promise<DatasetCatalog> {
  if (data.length === 0) throw new Error(`${fileName}: catalogue is empty.`);

  const { datasetsRows, columnsRows } = await readSheetAsRows(data, fileName);

  const columnsHasDatasetId = columnsRows.length === 0 ? true : "dataset_id" in columnsRows[0];
  const columnsHasCanonical = columnsRows.length === 0 ? true : "canonical_name" in columnsRows[0];
  if (columnsRows.length > 0 && !columnsHasDatasetId) {
    throw new Error(`${fileName}: Columns sheet must include a 'dataset_id' column.`);
  }
  if (columnsRows.length > 0 && !columnsHasCanonical) {
    throw new Error(`${fileName}: Columns sheet must include a 'canonical_name' column.`);
  }

  const datasets: DatasetEntry[] = [];
  const seenDatasetIds = new Set<string>();
  if (datasetsRows !== null && datasetsRows.length > 0) {
    if (!("dataset_id" in datasetsRows[0])) {
      throw new Error(`${fileName}: Datasets sheet must include a 'dataset_id' column.`);
    }
    for (const r of datasetsRows) {
      const did = (r.dataset_id ?? "").trim();
      if (!did) continue;
      if (seenDatasetIds.has(did)) {
        throw new Error(`${fileName}: duplicate dataset_id '${did}' in Datasets sheet.`);
      }
      seenDatasetIds.add(did);
      datasets.push({
        datasetId: did,
        datasetName: (r.dataset_name ?? "").trim(),
        owner: (r.owner ?? "").trim(),
        sourceSystem: (r.source_system ?? "").trim(),
        frequency: (r.frequency ?? "").trim(),
        numericTolerance: parseOptionalDecimal(r.numeric_tolerance),
        caseSensitive: parseOptionalBool(r.case_sensitive),
        trimWhitespace: parseOptionalBool(r.trim_whitespace),
        treatBlankAsZero: parseOptionalBool(r.treat_blank_as_zero),
        description: (r.description ?? "").trim(),
      });
    }
  }

  const columnEntries: Array<[string, MappingEntry]> = [];
  const seenCanonical = new Map<string, Set<string>>();
  const seenSource = new Map<string, Map<string, string>>();
  const referencedDatasets = new Set<string>();

  for (const r of columnsRows) {
    const did = (r.dataset_id ?? "").trim();
    const canonical = (r.canonical_name ?? "").trim();
    if (!did || !canonical) continue;
    referencedDatasets.add(did);

    if (!seenCanonical.has(did)) seenCanonical.set(did, new Set());
    if (!seenSource.has(did)) seenSource.set(did, new Map());
    const canonicalSet = seenCanonical.get(did)!;
    const sourceMap = seenSource.get(did)!;

    if (canonicalSet.has(canonical)) {
      throw new Error(`${fileName}: duplicate canonical_name '${canonical}' within dataset '${did}'.`);
    }
    canonicalSet.add(canonical);

    const srcCol = (r.source_column ?? "").trim() || null;
    if (srcCol && sourceMap.has(srcCol)) {
      throw new Error(
        `${fileName}: source_column '${srcCol}' mapped twice within dataset '${did}' ` +
          `(to '${sourceMap.get(srcCol)}' and '${canonical}').`
      );
    }
    if (srcCol) sourceMap.set(srcCol, canonical);

    const role = (r.key_role ?? "").trim().toLowerCase();
    if (!["", "primary", "composite", "surrogate"].includes(role)) {
      throw new Error(
        `${fileName}: unrecognised key_role '${role}' in dataset '${did}' for canonical ` +
          `'${canonical}'. Allowed: primary, composite, surrogate.`
      );
    }
    const isKey = Boolean(role) || parseIsKey(r.is_key);

    columnEntries.push([
      did,
      {
        canonicalName: canonical,
        sourceColumn: srcCol,
        isKey,
        keyRole: role,
        dtype: (r.dtype ?? "").trim() || null,
        description: (r.description ?? "").trim(),
      },
    ]);
  }

  for (const did of referencedDatasets) {
    if (!seenDatasetIds.has(did)) {
      datasets.push({
        datasetId: did,
        datasetName: "",
        owner: "",
        sourceSystem: "",
        frequency: "",
        numericTolerance: null,
        caseSensitive: null,
        trimWhitespace: null,
        treatBlankAsZero: null,
        description: "",
      });
    }
  }

  if (datasets.length === 0) throw new Error(`${fileName}: catalogue contains no datasets.`);
  if (columnEntries.length === 0) throw new Error(`${fileName}: catalogue contains no column entries.`);

  return { datasets, columns: columnEntries, sha256: sha256Hex(data), sourceName: fileName };
}

/**
 * Port of comparison.py's `validate_columns_against_mapping`. Never
 * throws, never blocks -- surfacing the mismatch as a warning is the
 * whole point. Run before applyMapping so warnings reference the file's
 * original column names.
 */
export function validateColumnsAgainstMapping(
  meta: FileMeta,
  mapping: ColumnMapping,
  side: "source" | "target"
): string[] {
  if (mapping.entries.length === 0) return [];
  const fileCols = new Set(meta.columns);

  const expected =
    side === "source"
      ? new Set(mapping.entries.map((e) => e.sourceColumn || e.canonicalName))
      : new Set(mapping.entries.map((e) => e.canonicalName));
  const label = side === "source" ? "Source" : "Target";

  const missing = [...expected].filter((c) => !fileCols.has(c)).sort();
  const extra = [...fileCols].filter((c) => !expected.has(c)).sort();

  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(`${label} file is missing ${missing.length} column(s) the catalogue expected: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    warnings.push(`${label} file has ${extra.length} column(s) not declared in the catalogue: ${extra.join(", ")}`);
  }
  return warnings;
}

/**
 * Port of comparison.py's `apply_mapping`. Source-centric: source columns
 * are renamed to canonical names; target columns are never renamed
 * (target is expected to already use canonical names -- mismatches
 * surface as "target-only" in the column diff by design).
 */
export function applyMapping(
  table: Table,
  meta: FileMeta,
  side: "source" | "target",
  mapping: ColumnMapping,
  dropUnmapped = false
): { table: Table; meta: FileMeta } {
  if (mapping.entries.length === 0) return { table, meta };

  const rename = side === "source" ? sourceRenameMap(mapping) : new Map<string, string>();

  let newColumns = table.columns.map((c) => rename.get(c) ?? c);
  let newRows = table.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of table.columns) out[rename.get(c) ?? c] = row[c];
    return out;
  });

  if (dropUnmapped) {
    const canonical = new Set(canonicalNames(mapping));
    const keep = newColumns.filter((c) => canonical.has(c));
    newColumns = keep;
    newRows = newRows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const c of keep) out[c] = row[c];
      return out;
    });
  }

  const surviving = new Set(newColumns);
  const keepMeta = (cols: readonly string[]) => cols.filter((c) => surviving.has(rename.get(c) ?? c));

  const dtypes: Array<readonly [string, string]> = newColumns.map((c) => [
    c,
    inferColumnDtype(newRows.map((r) => String(r[c] ?? ""))),
  ]);

  const newMeta: FileMeta = {
    name: meta.name,
    sha256: meta.sha256,
    sizeBytes: meta.sizeBytes,
    rowCount: newRows.length,
    columnCount: newColumns.length,
    columns: newColumns,
    dtypes,
    sheetName: meta.sheetName,
    encoding: meta.encoding,
    delimiter: meta.delimiter,
    originalColumns: meta.columns,
    hiddenColumns: keepMeta(meta.hiddenColumns ?? []),
    hiddenRowCount: meta.hiddenRowCount ?? 0,
    formulaBlankColumns: keepMeta(meta.formulaBlankColumns ?? []),
    formulaBlankCount: meta.formulaBlankCount ?? 0,
    hasHeader: meta.hasHeader,
  };

  return { table: { columns: newColumns, rows: newRows }, meta: newMeta };
}

// Re-exported for convenience so callers of catalog.ts don't need to
// separately import the CSV loader's lower-level helpers.
export { decodeWithFallback, sniffDelimiter };
