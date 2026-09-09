/**
 * Wire-format DTOs -- the JSON contract exposed over HTTP. Port of
 * backend/models.py's Pydantic schemas, field names kept in snake_case to
 * match the original wire format exactly (the frontend consumes these
 * verbatim; no naming-convention translation layer). Decimals are
 * strings, dates are ISO strings -- never raw Decimal.js/Date objects
 * cross this boundary.
 */

export interface AuthMe {
  user: string;
}

export interface ConfigInfo {
  blob_read_enabled: boolean;
  blob_write_enabled: boolean;
  blob_output_container_url: string;
  excel_max_rows: number;
  max_upload_bytes: number;
  /** Rows per detail section carried in a compare response; the downloads
   * are not capped. */
  max_response_rows: number;
}

export interface MappingEntryView {
  canonical_name: string;
  source_column: string;
  is_key: boolean;
  key_role: string;
  dtype: string;
  description: string;
}

export interface DatasetView {
  dataset_id: string;
  dataset_name: string;
  owner: string;
  source_system: string;
  frequency: string;
  numeric_tolerance: string | null;
  case_sensitive: boolean | null;
  trim_whitespace: boolean | null;
  treat_blank_as_zero: boolean | null;
  description: string;
}

export interface MappingView {
  dataset_id: string;
  dataset: DatasetView | null;
  entries: MappingEntryView[];
  canonical_names: string[];
  default_key_columns: string[];
  sha256: string;
}

export interface CatalogUploadResponse {
  catalog_id: string;
  sha256: string;
  filename: string;
  datasets: DatasetView[];
}

export interface FileMetaView {
  file_id: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  row_count: number;
  column_count: number;
  columns: string[];
  dtypes: Array<[string, string]>;
  sheet_name: string | null;
  encoding: string | null;
  delimiter: string | null;
  hidden_columns: string[];
  hidden_row_count: number;
  formula_blank_columns: string[];
  formula_blank_count: number;
  blob_url: string;
}

export interface BlobReadRequest {
  url: string;
  sheet_name?: string | null;
  has_header?: boolean;
  delimiter?: string | null;
}

export interface ExcelSheetsResponse {
  sheets: string[];
}

export interface CompareRequest {
  source_file_id: string;
  target_file_id: string;
  catalog_id?: string | null;
  dataset_id?: string | null;
  column_map?: Record<string, string>;
  drop_unmapped?: boolean;
  key_columns?: string[];
  case_sensitive?: boolean;
  trim_whitespace?: boolean;
  numeric_tolerance?: string;
  decimal_precision?: number | null;
  treat_blank_as_zero?: boolean;
  fuzzy_column_names?: boolean;
  control_total_columns?: string[];
  enforced_dtypes?: Record<string, string>;
  /** Whether this run should keep what the annotated source/target
   * downloads need. Defaults to true. Turning it off frees the per-row
   * status maps, which exist for no other purpose and are proportional to
   * the number of distinct keys. */
  annotated_outputs?: boolean;
}

export interface ColumnDifferencesView {
  source_only: string[];
  target_only: string[];
  common: string[];
  sequence_mismatches: Array<{ column: string; source_index: number; target_index: number }>;
  dtype_mismatches: Array<{ column: string; source_dtype: string; target_dtype: string }>;
}

export interface ValueDifferenceView {
  key: Record<string, unknown>;
  column: string;
  source_value: unknown;
  target_value: unknown;
  delta: string | null;
  within_tolerance: boolean;
  source_row: number;
  target_row: number;
}

export interface ControlTotalView {
  column: string;
  source_total: string;
  target_total: string;
  delta: string;
  ties_out: boolean;
}

export interface ReconciliationOutcomeView {
  verdict: string;
  reconciled: boolean;
  source_only_rows: number;
  target_only_rows: number;
  matched_with_differences: number;
  matched_within_tolerance: number;
  cell_differences: number;
  control_totals_not_tied_out: number;
}

export interface AuditView {
  rows: Array<[string, string]>;
  user: string;
  generated_at_utc: string;
  outcome: ReconciliationOutcomeView | null;
}

export interface CompareSummary {
  source_rows: number;
  target_rows: number;
  source_columns: number;
  target_columns: number;
  matched_equal: number;
  matched_with_differences: number;
  matched_with_tolerance: number;
  source_only_rows: number;
  target_only_rows: number;
  cell_diffs: number;
  control_totals_tied_out: number;
  control_totals_not_tied_out: number;
  /** Rows sharing a key with an earlier row, and how many distinct key
   * values were duplicated. Both matter: "4 rows across 1 key" and "4 rows
   * across 4 keys" are very different situations, and only the first row
   * of each duplicated key is compared. */
  source_duplicate_rows: number;
  source_duplicate_keys: number;
  target_duplicate_rows: number;
  target_duplicate_keys: number;
}

/** How much of one detail section made it into the response. */
export interface SectionTruncation {
  returned: number;
  total: number;
  truncated: boolean;
}

/**
 * Tells the client that the on-screen detail is a preview. The counts in
 * `summary` are always the true totals; these say how much of each
 * section was actually shipped, so the UI can say so plainly and point at
 * the downloads, which always contain everything.
 */
export interface ResponseTruncation {
  limit: number;
  any_truncated: boolean;
  source_only_rows: SectionTruncation;
  target_only_rows: SectionTruncation;
  value_differences: SectionTruncation;
}

export interface CompareResultResponse {
  run_id: string;
  summary: CompareSummary;
  column_diff: ColumnDifferencesView;
  source_only_rows: Array<Record<string, unknown>>;
  target_only_rows: Array<Record<string, unknown>>;
  value_differences: ValueDifferenceView[];
  control_totals: ControlTotalView[];
  warnings: string[];
  audit: AuditView;
  catalog_compliance_warnings: string[];
  truncation: ResponseTruncation;
  /** Whether the annotated source/target downloads are available for this
   * run. The run decides, not the client, so a reloaded or shared result
   * cannot offer a download the server will refuse. */
  annotated_outputs: boolean;
}

export interface WriteToBlobResponse {
  written: string[];
  failed: Array<[string, string]>;
}
