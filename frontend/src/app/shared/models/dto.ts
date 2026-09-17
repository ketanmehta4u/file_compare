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

export interface ConfigInfo {
  excel_max_rows: number;
  max_upload_bytes: number;
  /** Rows per detail section the server puts in a compare response.
   * Downloads are not capped. */
  max_response_rows: number;
}

/** One catalogue column: what it is called canonically, which source
 * column feeds it, and whether it identifies a row. */
export interface MappingEntryView {
  canonical_name: string;
  source_column: string;
  is_key: boolean;
  key_role: string;
  dtype: string;
  description: string;
}

/** One dataset a catalogue describes, with the comparison defaults it
 * suggests. */
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

/** A dataset's full column mapping, plus the key columns and settings it
 * pre-fills. */
export interface MappingView {
  dataset_id: string;
  dataset: DatasetView | null;
  entries: MappingEntryView[];
  canonical_names: string[];
  default_key_columns: string[];
  sha256: string;
}

/** What an uploaded catalogue offers: its id and the datasets inside. */
export interface CatalogUploadResponse {
  catalog_id: string;
  sha256: string;
  filename: string;
  datasets: DatasetView[];
}

/** An uploaded file as the page describes it: identity, shape, and the
 * warnings worth showing (hidden data, uncalculated formulas). */
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
}

/** One sheet offered for selection, with the size that tells it apart
 * from the workbook's other sheets. */
export interface ExcelSheetView {
  name: string;
  row_count: number;
  column_count: number;
}

/** The sheets a workbook holds, for the picker. */
export interface ExcelSheetsResponse {
  sheets: ExcelSheetView[];
}

/** Everything one comparison needs, as sent to the server. Validated
 * there against a schema, so a wrong type is refused rather than
 * silently ignored. */
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
  /** Whether to keep what the annotated source/target downloads need. */
  annotated_outputs?: boolean;
}

/** Structural differences: columns on one side only, in a different
 * position, or holding different kinds of value. */
export interface ColumnDifferencesView {
  source_only: string[];
  target_only: string[];
  common: string[];
  sequence_mismatches: Array<{ column: string; source_index: number; target_index: number }>;
  dtype_mismatches: Array<{ column: string; source_dtype: string; target_dtype: string }>;
}

/** One differing cell in a row that matched. Decimals arrive as strings,
 * so no precision is lost in JSON. */
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

/** One column's totals on both sides, and whether they tie out. */
export interface ControlTotalView {
  column: string;
  source_total: string;
  target_total: string;
  delta: string;
  ties_out: boolean;
}

/** The verdict and the counts behind it. */
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

/** The audit header: who ran it, when, and the verdict. */
export interface AuditView {
  rows: Array<[string, string]>;
  user: string;
  generated_at_utc: string;
  outcome: ReconciliationOutcomeView | null;
}

/** The headline counts. Always the true totals, even when the detail
 * sections below them were capped for the wire. */
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
   * values were duplicated. Only the first row of each duplicated key is
   * compared, so both numbers describe what the run did not check. */
  source_duplicate_rows: number;
  source_duplicate_keys: number;
  target_duplicate_rows: number;
  target_duplicate_keys: number;
}

/** How much of one detail section made it into the response, and how much
 * there really is. */
export interface SectionTruncation {
  returned: number;
  total: number;
  truncated: boolean;
}

/** Says how much of each detail section the response actually carries.
 * The summary counts are always the true totals, and the downloads always
 * contain every row -- this only describes the on-screen preview. */
export interface ResponseTruncation {
  limit: number;
  any_truncated: boolean;
  source_only_rows: SectionTruncation;
  target_only_rows: SectionTruncation;
  value_differences: SectionTruncation;
}

/** A finished comparison as the page receives it. The detail arrays may
 * be a preview; `truncation` says so, and the downloads are complete. */
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
  /** Whether the annotated downloads exist for this run. Decided by the
   * run, not by the current form state, so the links shown always match
   * what the server will actually serve. */
  annotated_outputs: boolean;
}

/** Live progress for a background comparison. `percent` is null while a
 * phase has no countable total (the tail phases). */
export interface JobProgress {
  phase: string;
  label: string;
  done: number;
  total: number;
  percent: number | null;
}

/** Where a background comparison has got to. */
export type CompareJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** The acknowledgement that a comparison has been queued. */
export interface CompareJobStarted {
  job_id: string;
  status: CompareJobStatus;
}

/** A job while it runs and once it finishes: progress, then either the
 * result or the reason it failed. */
export interface CompareJobView {
  job_id: string;
  status: CompareJobStatus;
  progress: JobProgress | null;
  /** Populated only once the status is "done". */
  result: CompareResultResponse | null;
  /** Failure message when the status is "error". */
  detail: string | null;
}

/** The answer to a cancel request -- `cancelled` is false when the job had
 * already finished. */
export interface CompareJobCancelled {
  job_id: string;
  status: CompareJobStatus;
  cancelled: boolean;
}
