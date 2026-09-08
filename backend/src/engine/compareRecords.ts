import { normaliseCell } from "./normalise";
import { valuesEqual } from "./equality";
import { encodeKey } from "./rowKey";
import type {
  CellValue,
  CompareSettings,
  DuplicateStats,
  RowStatus,
  Table,
  ValueDifference,
} from "./types";
import { enforcedFor } from "./types";

export interface CompareRecordsResult {
  sourceOnlyRows: Array<Record<string, unknown>>;
  targetOnlyRows: Array<Record<string, unknown>>;
  valueDifferences: ValueDifference[];
  matchedEqual: number;
  matchedDiff: number;
  matchedTol: number;
  warnings: string[];
  /** keyed by encodeKey(rowKey) */
  sourceStatus: Map<string, RowStatus>;
  targetStatus: Map<string, RowStatus>;
  dupStats: DuplicateStats;
}

interface KeyEntry {
  key: CellValue[];
  indices: number[];
}

function buildIndex(
  table: Table,
  keyColNames: readonly string[],
  settings: CompareSettings
): Map<string, KeyEntry> {
  const index = new Map<string, KeyEntry>();
  const enforced = keyColNames.map((c) => enforcedFor(settings, c));
  table.rows.forEach((row, i) => {
    const key = keyColNames.map((c, ci) => normaliseCell(row[c], settings, enforced[ci]).value);
    const encoded = encodeKey(key);
    const entry = index.get(encoded);
    if (entry) entry.indices.push(i);
    else index.set(encoded, { key, indices: [i] });
  });
  return index;
}

/** Lexicographic comparator over stringified key tuples, matching Python's
 * `sorted(keys, key=lambda t: tuple(str(x) for x in t))`. */
function compareKeyEntries(a: KeyEntry, b: KeyEntry): number {
  const len = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < len; i++) {
    const sa = stringifyKeyPart(a.key[i]);
    const sb = stringifyKeyPart(b.key[i]);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

function stringifyKeyPart(v: CellValue | undefined): string {
  if (v === undefined || v === null) return "None";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Matches Python's `tuple(str(r.get(c, "")) for c in sorted(r) if not
 * c.startswith("_"))` -- an array of per-column strings compared
 * element-wise, NOT joined into one string (joining would let two
 * different rows produce the same sort key, e.g. ["a b","c"] and
 * ["a","b c"] would both join to "a b c"). */
function contentSortKey(row: Record<string, unknown>): string[] {
  const cols = Object.keys(row)
    .filter((c) => !c.startsWith("_"))
    .sort();
  return cols.map((c) => String(row[c] ?? ""));
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const sa = a[i] ?? "";
    const sb = b[i] ?? "";
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

/**
 * Port of comparison.py's `compare_records` (lines 2072-2286). Hash/key-based
 * join: builds a normalised-key -> row-indices map per side, then set
 * algebra over the keys. Only the first row-index per key participates in
 * cell-level matching -- duplicate keys are counted and warned about, not
 * silently overwritten or dropped from the file.
 */
export function compareRecords(
  source: Table,
  target: Table,
  commonColumns: readonly string[],
  settings: CompareSettings,
  sourceRowOffset = 1,
  targetRowOffset = 1
): CompareRecordsResult {
  const warnings: string[] = [];
  let keyCols = [...settings.keyColumns];

  const missingInSrc = keyCols.filter((c) => !source.columns.includes(c));
  const missingInTgt = keyCols.filter((c) => !target.columns.includes(c));
  if (missingInSrc.length > 0 || missingInTgt.length > 0) {
    const missing = [...new Set([...missingInSrc, ...missingInTgt])].sort();
    warnings.push(
      `Key column(s) not present in both files — ${missing.join(", ")}. ` +
        "Falling back to full-row matching."
    );
    keyCols = [];
  }

  const srcKeyColNames = keyCols.length > 0 ? keyCols : [...source.columns].sort();
  const tgtKeyColNames = keyCols.length > 0 ? keyCols : [...target.columns].sort();

  const srcIndex = buildIndex(source, srcKeyColNames, settings);
  const tgtIndex = buildIndex(target, tgtKeyColNames, settings);

  const srcDups = [...srcIndex.values()].filter((e) => e.indices.length > 1);
  const tgtDups = [...tgtIndex.values()].filter((e) => e.indices.length > 1);
  const dupStats: DuplicateStats = {
    sourceDuplicateKeys: srcDups.length,
    sourceDuplicateRows: srcDups.reduce((n, e) => n + e.indices.length, 0),
    targetDuplicateKeys: tgtDups.length,
    targetDuplicateRows: tgtDups.reduce((n, e) => n + e.indices.length, 0),
    keyed: keyCols.length > 0,
  };
  const dupNoun = keyCols.length > 0 ? "duplicated key value(s)" : "exact-duplicate row group(s)";
  const dupTail =
    keyCols.length > 0
      ? "only the first row per key is compared; the rest are NOT matched — " +
        "use a composite key to make the identifier unique, or the _record_hash " +
        "column in the annotated download."
      : "identical rows appear more than once.";
  if (srcDups.length > 0) {
    warnings.push(
      `Source has ${dupStats.sourceDuplicateKeys} ${dupNoun} across ` +
        `${dupStats.sourceDuplicateRows} rows — ${dupTail}`
    );
  }
  if (tgtDups.length > 0) {
    warnings.push(
      `Target has ${dupStats.targetDuplicateKeys} ${dupNoun} across ` +
        `${dupStats.targetDuplicateRows} rows — ${dupTail}`
    );
  }

  const srcKeys = new Set(srcIndex.keys());
  const tgtKeys = new Set(tgtIndex.keys());
  const onlySrcKeys = [...srcKeys].filter((k) => !tgtKeys.has(k));
  const onlyTgtKeys = [...tgtKeys].filter((k) => !srcKeys.has(k));
  const commonKeys = [...srcKeys].filter((k) => tgtKeys.has(k));

  function materialise(
    table: Table,
    keys: string[],
    index: Map<string, KeyEntry>,
    rowOffset: number
  ): Array<Record<string, unknown>> {
    const indices = keys.flatMap((k) => index.get(k)!.indices).sort((a, b) => a - b);
    const rows = indices.map((i) => ({ _row: i + rowOffset, ...table.rows[i] }));
    rows.sort((a, b) => compareStringArrays(contentSortKey(a), contentSortKey(b)));
    return rows;
  }

  const sourceOnlyRows = materialise(source, onlySrcKeys, srcIndex, sourceRowOffset);
  const targetOnlyRows = materialise(target, onlyTgtKeys, tgtIndex, targetRowOffset);

  const enforcedByCol = new Map(commonColumns.map((c) => [c, enforcedFor(settings, c)]));
  const valueDifferences: ValueDifference[] = [];
  let matchedEqual = 0;
  let matchedDiff = 0;
  let matchedTol = 0;

  const sourceStatus = new Map<string, RowStatus>();
  const targetStatus = new Map<string, RowStatus>();
  for (const k of onlySrcKeys) sourceStatus.set(k, "source_only");
  for (const k of onlyTgtKeys) targetStatus.set(k, "target_only");

  const sortedCommon = commonKeys
    .map((k) => ({ encoded: k, entry: srcIndex.get(k)! }))
    .sort((a, b) => compareKeyEntries(a.entry, b.entry));

  for (const { encoded: k, entry } of sortedCommon) {
    const sIdx = entry.indices[0];
    const tIdx = tgtIndex.get(k)!.indices[0];
    const sRow = source.rows[sIdx];
    const tRow = target.rows[tIdx];
    let rowDiffers = false;
    let rowOnlyTol = true;
    const rowDiffs: ValueDifference[] = [];

    for (const col of commonColumns) {
      const sRaw = sRow[col];
      const tRaw = tRow[col];
      const enf = enforcedByCol.get(col);
      const s = normaliseCell(sRaw, settings, enf);
      const t = normaliseCell(tRaw, settings, enf);
      const { equal, withinTolerance, delta } = valuesEqual(s.kind, s.value, t.kind, t.value, settings);
      if (equal) continue;
      rowDiffers = true;
      if (!withinTolerance) rowOnlyTol = false;
      rowDiffs.push({
        key:
          keyCols.length > 0
            ? Object.fromEntries(keyCols.map((c, i) => [c, entry.key[i]]))
            : { _row: entry.key.map(stringifyKeyPart).join(", ") },
        column: col,
        sourceValue: sRaw,
        targetValue: tRaw,
        delta,
        withinTolerance,
        sourceRow: sIdx + sourceRowOffset,
        targetRow: tIdx + targetRowOffset,
      });
    }

    let status: RowStatus;
    if (!rowDiffers) {
      matchedEqual++;
      status = "matched_equal";
    } else {
      valueDifferences.push(...rowDiffs);
      if (rowOnlyTol) {
        matchedTol++;
        status = "matched_with_tolerance";
      } else {
        matchedDiff++;
        status = "matched_with_differences";
      }
    }
    sourceStatus.set(k, status);
    targetStatus.set(k, status);
  }

  return {
    sourceOnlyRows,
    targetOnlyRows,
    valueDifferences,
    matchedEqual,
    matchedDiff,
    matchedTol,
    warnings,
    sourceStatus,
    targetStatus,
    dupStats,
  };
}
