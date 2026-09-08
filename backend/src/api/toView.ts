import Decimal from "decimal.js";
import { auditHeaderToRows } from "../engine/report/auditRows";
import { maxResponseRows } from "../config/env";
import type {
  CellValue,
  ColumnDifferences,
  CompareReport,
  ControlTotal,
  DatasetEntry,
  FileMeta,
  MappingEntry,
  ValueDifference,
} from "../engine/types";
import type {
  AuditView,
  ResponseTruncation,
  SectionTruncation,
  CatalogUploadResponse,
  ColumnDifferencesView,
  CompareResultResponse,
  CompareSummary,
  ControlTotalView,
  DatasetView,
  FileMetaView,
  MappingEntryView,
  ValueDifferenceView,
} from "./dto";

/** Coerce a single normalised cell value into something JSON-serialisable.
 * Port of models.py's `_jsonable`. */
export function jsonable(value: unknown): unknown {
  if (value instanceof Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function datasetToView(ds: DatasetEntry): DatasetView {
  return {
    dataset_id: ds.datasetId,
    dataset_name: ds.datasetName,
    owner: ds.owner,
    source_system: ds.sourceSystem,
    frequency: ds.frequency,
    numeric_tolerance: ds.numericTolerance === null ? null : ds.numericTolerance.toString(),
    case_sensitive: ds.caseSensitive,
    trim_whitespace: ds.trimWhitespace,
    treat_blank_as_zero: ds.treatBlankAsZero,
    description: ds.description,
  };
}

export function mappingEntryToView(e: MappingEntry): MappingEntryView {
  return {
    canonical_name: e.canonicalName,
    source_column: e.sourceColumn ?? "",
    is_key: e.isKey,
    key_role: e.keyRole,
    dtype: e.dtype ?? "",
    description: e.description,
  };
}

export function fileMetaToView(meta: FileMeta, fileId: string, blobUrl = ""): FileMetaView {
  return {
    file_id: fileId,
    filename: meta.name,
    sha256: meta.sha256,
    size_bytes: meta.sizeBytes,
    row_count: meta.rowCount,
    column_count: meta.columnCount,
    columns: [...meta.columns],
    dtypes: meta.dtypes.map(([c, d]) => [c, d]),
    sheet_name: meta.sheetName ?? null,
    encoding: meta.encoding ?? null,
    delimiter: meta.delimiter ?? null,
    hidden_columns: [...(meta.hiddenColumns ?? [])],
    hidden_row_count: meta.hiddenRowCount ?? 0,
    formula_blank_columns: [...(meta.formulaBlankColumns ?? [])],
    formula_blank_count: meta.formulaBlankCount ?? 0,
    blob_url: blobUrl,
  };
}

export function columnDiffToView(cd: ColumnDifferences): ColumnDifferencesView {
  return {
    source_only: [...cd.sourceOnly],
    target_only: [...cd.targetOnly],
    common: [...cd.common],
    sequence_mismatches: cd.sequenceMismatches.map((m) => ({
      column: m.column,
      source_index: m.sourceIndex,
      target_index: m.targetIndex,
    })),
    dtype_mismatches: cd.dtypeMismatches.map((m) => ({
      column: m.column,
      source_dtype: m.sourceDtype,
      target_dtype: m.targetDtype,
    })),
  };
}

export function valueDiffToView(vd: ValueDifference): ValueDifferenceView {
  const key: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vd.key)) key[k] = jsonable(v as CellValue | string);
  return {
    key,
    column: vd.column,
    source_value: jsonable(vd.sourceValue),
    target_value: jsonable(vd.targetValue),
    delta: vd.delta === null ? null : vd.delta.toString(),
    within_tolerance: vd.withinTolerance,
    source_row: vd.sourceRow,
    target_row: vd.targetRow,
  };
}

export function controlTotalToView(ct: ControlTotal): ControlTotalView {
  return {
    column: ct.column,
    source_total: ct.sourceTotal.toString(),
    target_total: ct.targetTotal.toString(),
    delta: ct.delta.toString(),
    ties_out: ct.tiesOut,
  };
}

export function rowsToJsonable(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = jsonable(v);
    return out;
  });
}

export interface CatalogDatasetsResult {
  catalogId: string;
  sha256: string;
  filename: string;
  datasets: DatasetEntry[];
}

export function catalogUploadToView(r: CatalogDatasetsResult): CatalogUploadResponse {
  return {
    catalog_id: r.catalogId,
    sha256: r.sha256,
    filename: r.filename,
    datasets: r.datasets.map(datasetToView),
  };
}

/** Port of models.py's `compare_to_response` -- assembles the full
 * CompareResultResponse from an engine CompareReport. */
/** Caps one detail section, recording what was left behind. */
function capSection<T>(rows: readonly T[], limit: number): { rows: T[]; info: SectionTruncation } {
  const returned = Math.min(rows.length, limit);
  return {
    rows: rows.length > limit ? rows.slice(0, limit) : [...rows],
    info: { returned, total: rows.length, truncated: rows.length > limit },
  };
}

export function compareToResponse(
  report: CompareReport,
  runId: string,
  catalogComplianceWarnings: string[]
): CompareResultResponse {
  const cd = report.columnDiff;
  const srcOnly = report.sourceOnlyRows.length;
  const tgtOnly = report.targetOnlyRows.length;
  const ties = report.controlTotals.filter((c) => c.tiesOut).length;
  const notTies = report.controlTotals.filter((c) => !c.tiesOut).length;

  const summary: CompareSummary = {
    source_rows: report.audit.source.rowCount,
    target_rows: report.audit.target.rowCount,
    source_columns: report.audit.source.columnCount,
    target_columns: report.audit.target.columnCount,
    matched_equal: report.matchedEqualCount,
    matched_with_differences: report.matchedWithDifferencesCount,
    matched_with_tolerance: report.matchedWithToleranceCount,
    source_only_rows: srcOnly,
    target_only_rows: tgtOnly,
    cell_diffs: report.valueDifferences.length,
    control_totals_tied_out: ties,
    control_totals_not_tied_out: notTies,
    source_duplicate_rows: report.duplicates.sourceDuplicateRows,
    target_duplicate_rows: report.duplicates.targetDuplicateRows,
  };

  const audit: AuditView = {
    rows: auditHeaderToRows(report.audit).map(([label, value]) => [label, value]),
    user: report.audit.user,
    generated_at_utc: report.audit.generatedAtUtc,
    outcome: report.audit.outcome
      ? {
          verdict: report.audit.outcome.verdict,
          reconciled: report.audit.outcome.reconciled,
          source_only_rows: report.audit.outcome.sourceOnlyRows,
          target_only_rows: report.audit.outcome.targetOnlyRows,
          matched_with_differences: report.audit.outcome.matchedWithDifferences,
          matched_within_tolerance: report.audit.outcome.matchedWithinTolerance,
          cell_differences: report.audit.outcome.cellDifferences,
          control_totals_not_tied_out: report.audit.outcome.controlTotalsNotTiedOut,
        }
      : null,
  };

  // Only the detail sections are capped, and only for the wire: the full
  // report stays in the run cache, so report.xlsx and the annotated files
  // still contain every row. `summary` keeps the true totals either way.
  const limit = maxResponseRows();
  const sourceOnly = capSection(report.sourceOnlyRows, limit);
  const targetOnly = capSection(report.targetOnlyRows, limit);
  const differences = capSection(report.valueDifferences, limit);

  const truncation: ResponseTruncation = {
    limit,
    any_truncated: sourceOnly.info.truncated || targetOnly.info.truncated || differences.info.truncated,
    source_only_rows: sourceOnly.info,
    target_only_rows: targetOnly.info,
    value_differences: differences.info,
  };

  return {
    run_id: runId,
    summary,
    column_diff: columnDiffToView(cd),
    source_only_rows: rowsToJsonable(sourceOnly.rows),
    target_only_rows: rowsToJsonable(targetOnly.rows),
    value_differences: differences.rows.map(valueDiffToView),
    control_totals: report.controlTotals.map(controlTotalToView),
    warnings: [...report.warnings],
    audit,
    catalog_compliance_warnings: catalogComplianceWarnings,
    truncation,
  };
}
