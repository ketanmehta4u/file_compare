import Decimal from "decimal.js";
import { normaliseCell } from "./normalise";
import type { CellValue, CompareSettings } from "./types";
import { enforcedFor } from "./types";

/**
 * Port of comparison.py's `_row_key`, shared between compareRecords and the
 * annotated-file export so both compute the identical key for a given row.
 * With no key columns configured, the key is the full normalised row in
 * sorted-column order (deterministic whole-row match).
 */
export function computeRowKey(
  row: Record<string, unknown>,
  keyColumns: readonly string[],
  settings: CompareSettings,
  allColumns?: readonly string[]
): CellValue[] {
  const cols = keyColumns.length > 0 ? keyColumns : [...(allColumns ?? Object.keys(row))].sort();
  return cols.map((c) => normaliseCell(row[c], settings, enforcedFor(settings, c)).value);
}

/**
 * Canonical, collision-free string encoding of a normalised key tuple, for
 * use as a Map key -- JS Maps compare object/array keys by reference, not
 * structurally, so a tuple of CellValues can't be used as a Map key
 * directly the way Python's hashable tuples can.
 */
export function encodeKey(key: readonly CellValue[]): string {
  return JSON.stringify(
    key.map((v) => {
      if (v === null) return ["n"];
      if (v instanceof Decimal) return ["d", v.toString()];
      if (v instanceof Date) return ["t", v.getTime()];
      return ["s", v];
    })
  );
}
