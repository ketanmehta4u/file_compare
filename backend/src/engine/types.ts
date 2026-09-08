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
