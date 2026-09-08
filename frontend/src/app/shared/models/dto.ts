/**
 * Wire-format DTOs -- the JSON contract exposed over HTTP by the backend.
 *
 * This file is a HAND-KEPT MIRROR of backend/src/api/dto.ts, not an
 * imported shared package -- deliberate choice (see the project's
 * implementation plan): an npm workspace linking a local `file:`
 * dependency into `ng build` under Angular 14 + Node 25 was one more
 * untested combination not worth the risk for a DTO surface this small
 * and stable. Keep the two files in sync by hand when the contract
 * changes; field names stay snake_case to match the wire format exactly.
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
  source_duplicate_rows: number;
  target_duplicate_rows: number;
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
}

export interface WriteToBlobResponse {
  written: string[];
  failed: Array<[string, string]>;
}
