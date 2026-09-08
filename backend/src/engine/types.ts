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

/** Port of comparison.py's FileMeta dataclass. */
export interface FileMeta {
  name: string;
  sha256: string;
  sizeBytes: number;
  rowCount: number;
  columnCount: number;
  columns: readonly string[];
  /** (column, inferred dtype label) */
  dtypes: ReadonlyArray<readonly [string, string]>;
  sheetName?: string | null;
  encoding?: string | null;
  delimiter?: string | null;
  originalColumns?: readonly string[];
  hiddenColumns?: readonly string[];
  hiddenRowCount?: number;
  formulaBlankColumns?: readonly string[];
  formulaBlankCount?: number;
  hasHeader?: boolean;
}

export interface SequenceMismatch {
  column: string;
  sourceIndex: number;
  targetIndex: number;
}

export interface DtypeMismatch {
  column: string;
  sourceDtype: string;
  targetDtype: string;
}

/** Port of comparison.py's ColumnDifferences dataclass. */
export interface ColumnDifferences {
  sourceOnly: string[];
  targetOnly: string[];
  common: string[];
  sequenceMismatches: SequenceMismatch[];
  dtypeMismatches: DtypeMismatch[];
}

/** Port of comparison.py's ControlTotal dataclass. */
export interface ControlTotal {
  column: string;
  sourceTotal: Decimal;
  targetTotal: Decimal;
  delta: Decimal;
  tiesOut: boolean;
}

/** Port of comparison.py's ReconciliationOutcome dataclass +
 * from_counts classmethod. */
export interface ReconciliationOutcome {
  verdict: string;
  reconciled: boolean;
  sourceOnlyRows: number;
  targetOnlyRows: number;
  matchedWithDifferences: number;
  matchedWithinTolerance: number;
  cellDifferences: number;
  controlTotalsNotTiedOut: number;
}

/** Port of comparison.py's MappingEntry dataclass: one row of the
 * catalogue's Columns sheet. */
export interface MappingEntry {
  canonicalName: string;
  sourceColumn: string | null;
  isKey: boolean;
  /** "" | "primary" | "composite" | "surrogate" */
  keyRole: string;
  dtype: string | null;
  description: string;
}

/** Port of comparison.py's DatasetEntry dataclass: one row of the
 * catalogue's Datasets sheet. All settings fields are optional defaults
 * for the UI -- the user can still override them. */
export interface DatasetEntry {
  datasetId: string;
  datasetName: string;
  owner: string;
  sourceSystem: string;
  frequency: string;
  numericTolerance: Decimal | null;
  caseSensitive: boolean | null;
  trimWhitespace: boolean | null;
  treatBlankAsZero: boolean | null;
  description: string;
}

/** Port of comparison.py's ColumnMapping dataclass -- the engine-facing
 * view of a mapping, source-centric (target is expected to already use
 * canonical names). */
export interface ColumnMapping {
  entries: readonly MappingEntry[];
  sha256: string;
  sourceName: string;
  dataset: DatasetEntry | null;
}

/** Port of comparison.py's DatasetCatalog dataclass -- a parsed catalogue
 * workbook holding many datasets, each with its own metadata and column
 * list. */
export interface DatasetCatalog {
  datasets: readonly DatasetEntry[];
  /** Each entry: (datasetId, MappingEntry). Flat, not grouped, so workbook
   * order is preserved (relevant for composite-key ordering). */
  columns: ReadonlyArray<readonly [string, MappingEntry]>;
  sha256: string;
  sourceName: string;
}

/** Port of comparison.py's AuditHeader dataclass. */
export interface AuditHeader {
  generatedAtUtc: string;
  source: FileMeta;
  target: FileMeta;
  settings: CompareSettings;
  mapping: ColumnMapping | null;
  user: string;
  outcome: ReconciliationOutcome;
}

/** Port of comparison.py's CompareReport dataclass -- the single object the
 * API/report layers consume. */
export interface CompareReport {
  audit: AuditHeader;
  columnDiff: ColumnDifferences;
  sourceOnlyRows: Array<Record<string, unknown>>;
  targetOnlyRows: Array<Record<string, unknown>>;
  matchedEqualCount: number;
  matchedWithDifferencesCount: number;
  matchedWithToleranceCount: number;
  valueDifferences: ValueDifference[];
  controlTotals: ControlTotal[];
  warnings: string[];
  sourceRowStatus: Map<string, RowStatus>;
  targetRowStatus: Map<string, RowStatus>;
  duplicates: DuplicateStats;
}
