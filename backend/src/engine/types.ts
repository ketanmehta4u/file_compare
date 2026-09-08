import Decimal from "decimal.js";

/** Port of comparison.py's CompareSettings dataclass. */
export interface CompareSettings {
  keyColumns: readonly string[];
  caseSensitive: boolean;
  trimWhitespace: boolean;
  numericTolerance: Decimal;
  decimalPrecision: number | null;
  treatBlankAsZero: boolean;
  fuzzyColumnNames: boolean;
  controlTotalColumns: readonly string[];
  /** column name -> "id" | "timestamp" */
  enforcedDtypes: ReadonlyMap<string, "id" | "timestamp">;
}

export function defaultSettings(overrides: Partial<CompareSettings> = {}): CompareSettings {
  return {
    keyColumns: [],
    caseSensitive: true,
    trimWhitespace: true,
    numericTolerance: new Decimal(0),
    decimalPrecision: null,
    treatBlankAsZero: false,
    fuzzyColumnNames: false,
    controlTotalColumns: [],
    enforcedDtypes: new Map(),
    ...overrides,
  };
}

export type CellKind = "null" | "numeric" | "date" | "timestamp" | "text";

export type CellValue = null | Decimal | Date | string;

export interface NormalisedCell {
  kind: CellKind;
  value: CellValue;
}

/** A minimal row-oriented table: array of row objects plus a stable column
 * list (needed because a row may not carry every column present, and
 * column order matters for whole-row-key fallback determinism). */
export interface Table {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
}

export function enforcedFor(
  settings: CompareSettings,
  column: string
): "id" | "timestamp" | undefined {
  return settings.enforcedDtypes.get(column);
}

/** Port of comparison.py's ValueDifference dataclass. When key columns are
 * configured, `key` holds the raw normalised value per key column name
 * (Decimal/Date/string/null, same as the source engine's `dict[str, Any]`)
 * -- stringification is deferred to the API/DTO layer. In the whole-row
 * fallback case (no key columns), Python pre-stringifies the whole tuple
 * as a debug label (`{"_row": str(k)}`); ported the same way here. */
export interface ValueDifference {
  key: Record<string, CellValue | string>;
  column: string;
  sourceValue: unknown;
  targetValue: unknown;
  delta: Decimal | null;
  withinTolerance: boolean;
  sourceRow: number;
  targetRow: number;
}

/** Port of comparison.py's DuplicateStats dataclass. */
export interface DuplicateStats {
  sourceDuplicateKeys: number;
  sourceDuplicateRows: number;
  targetDuplicateKeys: number;
  targetDuplicateRows: number;
  keyed: boolean;
}

export type RowStatus =
  | "source_only"
  | "target_only"
  | "matched_equal"
  | "matched_with_differences"
  | "matched_with_tolerance";
