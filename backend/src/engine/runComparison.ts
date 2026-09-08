import { compareColumns } from "./columnDiff";
import { compareRecords } from "./compareRecords";
import { controlTotals as computeControlTotals } from "./controlTotals";
import type { ColumnMapping, CompareReport, CompareSettings, FileMeta, ReconciliationOutcome, Table } from "./types";

/** Port of comparison.py's `_file_notice_warnings`. Surfaces a file's
 * load-time notices (hidden Excel data, uncalculated formulas) as run
 * warnings so they land in the audit report rather than only a transient
 * upload hint. */
function fileNoticeWarnings(label: string, meta: FileMeta): string[] {
  const out: string[] = [];
  const hiddenColumns = meta.hiddenColumns ?? [];
  const hiddenRowCount = meta.hiddenRowCount ?? 0;
  if (hiddenColumns.length > 0 || hiddenRowCount > 0) {
    const parts: string[] = [];
    if (hiddenColumns.length > 0) {
      parts.push(`${hiddenColumns.length} hidden column(s) (${hiddenColumns.join(", ")})`);
    }
    if (hiddenRowCount > 0) parts.push(`${hiddenRowCount} hidden row(s)`);
    out.push(
      `${label} file contains ${parts.join(" and ")} — hidden cells are ` +
        "included in the comparison, not skipped."
    );
  }
  const formulaBlankCount = meta.formulaBlankCount ?? 0;
  if (formulaBlankCount > 0) {
    const cols = meta.formulaBlankColumns ?? [];
    out.push(
      `${label} file has ${formulaBlankCount} uncalculated formula cell(s) ` +
        `read as blank in column(s): ${cols.join(", ")}. Recompute in Excel and ` +
        "re-upload if those blanks are unexpected."
    );
  }
  return out;
}

/** Port of comparison.py's ReconciliationOutcome.from_counts. */
function outcomeFromCounts(counts: {
  sourceOnlyRows: number;
  targetOnlyRows: number;
  matchedWithDifferences: number;
  matchedWithinTolerance: number;
  cellDifferences: number;
  controlTotalsNotTiedOut: number;
}): ReconciliationOutcome {
  const hardBreaks =
    counts.sourceOnlyRows +
    counts.targetOnlyRows +
    counts.matchedWithDifferences +
    counts.controlTotalsNotTiedOut;

  let verdict: string;
  let reconciled: boolean;
  if (hardBreaks === 0 && counts.matchedWithinTolerance === 0) {
    verdict = "RECONCILED — no differences found";
    reconciled = true;
  } else if (hardBreaks === 0) {
    verdict =
      `RECONCILED WITHIN TOLERANCE — ${counts.matchedWithinTolerance} ` +
      "row(s) differ but stay within the numeric tolerance";
    reconciled = true;
  } else {
    verdict = `DIFFERENCES FOUND — ${hardBreaks} break(s) require review`;
    reconciled = false;
  }

  return { verdict, reconciled, ...counts };
}

/**
 * Port of comparison.py's `run_comparison` (lines 2338-2409). End-to-end
 * comparison: structural diff, record diff, control totals, verdict.
 *
 * The optional `mapping` is only used for audit/reporting -- callers are
 * expected to have already applied it before calling this function, so
 * `source`/`target` already use canonical column names.
 */
export function runComparison(
  source: Table,
  sourceMeta: FileMeta,
  target: Table,
  targetMeta: FileMeta,
  settings: CompareSettings,
  mapping: ColumnMapping | null = null,
  user = ""
): CompareReport {
  const columnDiff = compareColumns(sourceMeta, targetMeta, settings);

  const srcRowOffset = sourceMeta.hasHeader !== false ? 2 : 1;
  const tgtRowOffset = targetMeta.hasHeader !== false ? 2 : 1;

  const records = compareRecords(source, target, columnDiff.common, settings, srcRowOffset, tgtRowOffset);
  const totals = computeControlTotals(source, target, columnDiff.common, settings);

  const warnings = [
    ...fileNoticeWarnings("Source", sourceMeta),
    ...fileNoticeWarnings("Target", targetMeta),
    ...records.warnings,
  ];

  const outcome = outcomeFromCounts({
    sourceOnlyRows: records.sourceOnlyRows.length,
    targetOnlyRows: records.targetOnlyRows.length,
    matchedWithDifferences: records.matchedDiff,
    matchedWithinTolerance: records.matchedTol,
    cellDifferences: records.valueDifferences.length,
    controlTotalsNotTiedOut: totals.filter((t) => !t.tiesOut).length,
  });

  return {
    audit: {
      generatedAtUtc: new Date().toISOString().replace("T", " ").slice(0, 19),
      source: sourceMeta,
      target: targetMeta,
      settings,
      mapping,
      user,
      outcome,
    },
    columnDiff,
    sourceOnlyRows: records.sourceOnlyRows,
    targetOnlyRows: records.targetOnlyRows,
    matchedEqualCount: records.matchedEqual,
    matchedWithDifferencesCount: records.matchedDiff,
    matchedWithToleranceCount: records.matchedTol,
    valueDifferences: records.valueDifferences,
    controlTotals: totals,
    warnings,
    sourceRowStatus: records.sourceStatus,
    targetRowStatus: records.targetStatus,
    duplicates: records.dupStats,
  };
}
