import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { computeRowKey, encodeKey } from "../rowKey";
import type { CompareReport, CompareSettings, RowStatus, Table } from "../types";

/** Port of comparison.py's _STATUS_FILL, mirroring the on-screen status
 * palette: green = clean match, amber = matched-but-differing,
 * red = a break. [fillHex, fontHex]. */
const STATUS_FILL: Record<string, readonly [string, string]> = {
  matched_equal: ["C6EFCE", "006100"],
  matched_with_tolerance: ["FFEB9C", "9C6500"],
  matched_with_differences: ["FFEB9C", "9C6500"],
  source_only: ["FFC7CE", "9C0006"],
  target_only: ["FFC7CE", "9C0006"],
};
const FILL_CELL_DIFF_HEX = "FFC000";

/**
 * Port of comparison.py's `_record_id_for_row`. Same business key -> same
 * id on both sides by design (what makes VLOOKUP/XLOOKUP across the two
 * downloaded files work). Single-column key -> the value verbatim;
 * composite key -> pipe-joined; no key -> a short hash of the normalised
 * row. Unlike the Python original this hashes via encodeKey's canonical
 * JSON encoding rather than Python's repr() -- the two apps never compare
 * hashes against each other, so only internal determinism matters, not
 * byte-for-byte parity with the original's hash algorithm.
 */
export function recordIdForRow(
  row: Record<string, unknown>,
  keyColumns: readonly string[],
  settings: CompareSettings,
  allColumns: readonly string[]
): string {
  if (keyColumns.length === 0) {
    const key = computeRowKey(row, [], settings, allColumns);
    return createHash("sha256").update(encodeKey(key)).digest("hex").slice(0, 12);
  }
  const key = computeRowKey(row, keyColumns, settings);
  const parts = key.map((v) => {
    if (v === null) return "";
    if (v instanceof Date) return v.toISOString();
    return String(v);
  });
  return parts.length === 1 ? parts[0] : parts.join("|");
}

/** Port of comparison.py's `_record_content_hash`: a content fingerprint
 * over EVERY column (not just the key), so identical rows share a hash
 * regardless of whether a key column uniquely identifies them. */
export function recordContentHash(
  row: Record<string, unknown>,
  settings: CompareSettings,
  allColumns: readonly string[]
): string {
  const key = computeRowKey(row, [], settings, allColumns);
  return createHash("sha256").update(encodeKey(key)).digest("hex").slice(0, 16);
}

/**
 * Port of comparison.py's `annotate_for_excel`. Returns a copy of the
 * table with `_record_id`, `_record_status`, `_record_hash` prepended.
 * The row key is recomputed with the same logic used during comparison
 * (not stashed from the run) so the status lookup is consistent
 * regardless of row order.
 */
export function annotateForExcel(
  table: Table,
  side: "source" | "target",
  report: CompareReport,
  settings: CompareSettings
): Table {
  const statusMap = side === "source" ? report.sourceRowStatus : report.targetRowStatus;
  const onlyStatus: RowStatus = side === "source" ? "source_only" : "target_only";
  const keyColumns = settings.keyColumns;

  const rows = table.rows.map((row) => {
    const key = computeRowKey(row, keyColumns, settings, table.columns);
    const encoded = encodeKey(key);
    const status = statusMap.get(encoded) ?? onlyStatus;
    return {
      _record_id: recordIdForRow(row, keyColumns, settings, table.columns),
      _record_status: status,
      _record_hash: recordContentHash(row, settings, table.columns),
      ...row,
    };
  });

  return { columns: ["_record_id", "_record_status", "_record_hash", ...table.columns], rows };
}

/**
 * Port of comparison.py's `diff_cells_for_annotated`. Locates the exact
 * (row, col) cells that differ, 0-based into the annotated table -- only
 * meaningful with a comparison key (value differences are keyed by it).
 */
export function diffCellsForAnnotated(
  annotated: Table,
  report: CompareReport,
  settings: CompareSettings
): Array<[number, number]> {
  const keyColumns = settings.keyColumns;
  if (keyColumns.length === 0 || report.valueDifferences.length === 0) return [];

  const colIndex = new Map(annotated.columns.map((c, i) => [c, i]));
  const posByKey = new Map<string, number>();
  annotated.rows.forEach((row, i) => {
    const key = computeRowKey(row, keyColumns, settings);
    const encoded = encodeKey(key);
    if (!posByKey.has(encoded)) posByKey.set(encoded, i);
  });

  const cells: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const vd of report.valueDifferences) {
    // vd.key holds one entry per key column name -> normalised value; encode
    // the same way computeRowKey's values are encoded so the two match.
    const keyTuple = keyColumns.map((c) => vd.key[c] ?? null);
    const encoded = encodeKey(keyTuple);
    const pos = posByKey.get(encoded);
    const ci = colIndex.get(vd.column);
    if (pos !== undefined && ci !== undefined) {
      const cellKey = `${pos},${ci}`;
      if (!seen.has(cellKey)) {
        seen.add(cellKey);
        cells.push([pos, ci]);
      }
    }
  }
  return cells;
}

/**
 * Port of comparison.py's `build_annotated_excel`. Single-sheet .xlsx with
 * the `_record_status` column colour-coded per status, plus optional
 * per-cell highlighting of the exact mismatched values. Uses per-cell
 * fills rather than openpyxl's O(1) conditional-formatting rules -- exceljs
 * has no equivalent conditional-formatting API as convenient as openpyxl's,
 * and this workbook's row count is already bounded by EXCEL_MAX_ROWS by
 * the caller, so per-cell styling is an acceptable, simpler trade-off here.
 */
export async function buildAnnotatedExcel(
  table: Table,
  sheetName = "data",
  highlightCells: ReadonlyArray<[number, number]> = []
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(table.columns);
  for (const row of table.rows) {
    ws.addRow(table.columns.map((c) => row[c] ?? ""));
  }

  const statusColIdx = table.columns.indexOf("_record_status");
  if (statusColIdx >= 0) {
    table.rows.forEach((row, i) => {
      const status = String(row._record_status ?? "");
      const fill = STATUS_FILL[status];
      if (!fill) return;
      const [fillHex, fontHex] = fill;
      const isBreak = status === "source_only" || status === "target_only";
      const cell = ws.getRow(i + 2).getCell(statusColIdx + 1);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fillHex}` } };
      cell.font = { color: { argb: `FF${fontHex}` }, bold: isBreak };
    });
  }

  const highlightFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: `FF${FILL_CELL_DIFF_HEX}` },
  };
  for (const [rowIdx, colIdx] of highlightCells) {
    ws.getRow(rowIdx + 2).getCell(colIdx + 1).fill = highlightFill;
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
