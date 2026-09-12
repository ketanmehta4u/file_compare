import ExcelJS from "exceljs";
import type { CompareReport, ValueDifference } from "../types";
import { auditHeaderToRows, type Row } from "./auditRows";

export const EXCEL_MAX_ROWS = 1_048_576;

const FILL_BREAK_HEX = "FFC7CE"; // red -- source_only/target_only
const FILL_DIFF_HEX = "FFEB9C"; // amber -- matched_with_differences

function stringifyKeyPart(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Port of comparison.py's `_value_diffs_to_frame`: flattens ValueDifference
 * objects into plain rows with `key.<col>` prefixed key fields. */
function valueDiffsToRows(diffs: readonly ValueDifference[]): Array<Record<string, unknown>> {
  return diffs.map((d) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d.key)) row[`key.${k}`] = stringifyKeyPart(v);
    row.source_row = d.sourceRow;
    row.target_row = d.targetRow;
    row.column = d.column;
    row.source_value = d.sourceValue;
    row.target_value = d.targetValue;
    row.delta = d.delta !== null ? d.delta.toString() : "";
    row.within_tolerance = d.withinTolerance;
    return row;
  });
}

/** Port of comparison.py's `_summary_rows`. */
function summaryRows(report: CompareReport): Row[] {
  const cd = report.columnDiff;
  const lead: Row[] = report.audit.outcome
    ? [
        ["Reconciliation result", report.audit.outcome.verdict],
        ["", ""],
      ]
    : [];
  return [
    ...lead,
    ["Source rows", String(report.audit.source.rowCount)],
    ["Target rows", String(report.audit.target.rowCount)],
    ["Row count delta (T - S)", String(report.audit.target.rowCount - report.audit.source.rowCount)],
    ["Source columns", String(report.audit.source.columnCount)],
    ["Target columns", String(report.audit.target.columnCount)],
    ["Column count delta (T - S)", String(report.audit.target.columnCount - report.audit.source.columnCount)],
    ["Common columns", String(cd.common.length)],
    ["Source-only columns", String(cd.sourceOnly.length)],
    ["Target-only columns", String(cd.targetOnly.length)],
    ["Column sequence mismatches", String(cd.sequenceMismatches.length)],
    ["Column dtype mismatches", String(cd.dtypeMismatches.length)],
    ["Source-only rows", String(report.sourceOnlyRows.length)],
    ["Target-only rows", String(report.targetOnlyRows.length)],
    ["Source duplicate rows", String(report.duplicates.sourceDuplicateRows)],
    ["Source duplicated key values", String(report.duplicates.sourceDuplicateKeys)],
    ["Target duplicate rows", String(report.duplicates.targetDuplicateRows)],
    ["Target duplicated key values", String(report.duplicates.targetDuplicateKeys)],
    ["Matched & equal", String(report.matchedEqualCount)],
    ["Matched with differences", String(report.matchedWithDifferencesCount)],
    ["Matched within tolerance (flagged)", String(report.matchedWithToleranceCount)],
    ["Cell-level differences", String(report.valueDifferences.length)],
    ["Control totals tied out", String(report.controlTotals.filter((c) => c.tiesOut).length)],
    ["Control totals NOT tied out", String(report.controlTotals.filter((c) => !c.tiesOut).length)],
  ];
}

function addTable(
  ws: ExcelJS.Worksheet,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>
): void {
  ws.addRow([...columns]);
  for (const row of rows) {
    ws.addRow(columns.map((c) => (row[c] === undefined || row[c] === null ? "" : row[c])));
  }
}

function shadeDataRows(ws: ExcelJS.Worksheet, nDataRows: number, nCols: number, fillHex: string): void {
  if (nDataRows < 1 || nCols < 1) return;
  const fill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${fillHex}` } };
  for (let r = 2; r <= nDataRows + 1; r++) {
    for (let c = 1; c <= nCols; c++) {
      ws.getRow(r).getCell(c).fill = fill;
    }
  }
}

export interface ExcelReportResult {
  buffer: Buffer;
  /** filename -> CSV text, for any sheet that exceeded Excel's row cap. */
  extras: Record<string, string>;
}

function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const escape = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(","));
  return lines.join("\n");
}

/**
 * Port of comparison.py's `build_excel_report`. Multi-sheet audit workbook:
 * Audit Header, Summary, Warnings (if any), Column Differences,
 * Source/Target-Only Rows, Value Differences, Control Totals. Any
 * row-diff sheet exceeding EXCEL_MAX_ROWS spills to CSV in `extras`
 * instead, with a placeholder note sheet left in its place.
 */
export async function buildExcelReport(report: CompareReport): Promise<ExcelReportResult> {
  const wb = new ExcelJS.Workbook();
  const extras: Record<string, string> = {};

  const auditWs = wb.addWorksheet("Audit Header");
  addTable(
    auditWs,
    ["Field", "Value"],
    auditHeaderToRows(report.audit).map(([f, v]) => ({ Field: f, Value: v }))
  );

  const summaryWs = wb.addWorksheet("Summary");
  addTable(
    summaryWs,
    ["Metric", "Value"],
    summaryRows(report).map(([m, v]) => ({ Metric: m, Value: v }))
  );

  if (report.warnings.length > 0) {
    const warnWs = wb.addWorksheet("Warnings");
    addTable(
      warnWs,
      ["Warning"],
      report.warnings.map((w) => ({ Warning: w }))
    );
  }

  const cd = report.columnDiff;
  const colRows: Array<Record<string, unknown>> = [
    ...cd.sourceOnly.map((c) => ({ column: c, status: "source_only" })),
    ...cd.targetOnly.map((c) => ({ column: c, status: "target_only" })),
    ...cd.common.map((c) => ({ column: c, status: "common" })),
    ...cd.sequenceMismatches.map((m) => ({
      column: m.column,
      status: "sequence_mismatch",
      source_index: m.sourceIndex,
      target_index: m.targetIndex,
    })),
    ...cd.dtypeMismatches.map((m) => ({
      column: m.column,
      status: "dtype_mismatch",
      source_dtype: m.sourceDtype,
      target_dtype: m.targetDtype,
    })),
  ];
  const colDiffWs = wb.addWorksheet("Column Differences");
  const colDiffCols = ["column", "status", "source_index", "target_index", "source_dtype", "target_dtype"];
  addTable(colDiffWs, colDiffCols, colRows);

  const writeOrSpill = (
    columns: readonly string[],
    rows: ReadonlyArray<Record<string, unknown>>,
    sheet: string,
    csvName: string,
    fillHex?: string
  ) => {
    if (rows.length + 1 > EXCEL_MAX_ROWS) {
      extras[csvName] = toCsv(columns, rows);
      const ws = wb.addWorksheet(sheet);
      addTable(
        ws,
        ["Note"],
        [
          {
            Note: `Result has ${rows.length.toLocaleString()} rows which exceeds Excel's ${EXCEL_MAX_ROWS.toLocaleString()}-row limit. Full result emitted to '${csvName}'.`,
          },
        ]
      );
      return;
    }
    const ws = wb.addWorksheet(sheet);
    const nDataRows = rows.length;
    const effectiveCols = columns.length > 0 ? columns : ["_"];
    addTable(ws, effectiveCols, rows);
    if (fillHex && nDataRows > 0) shadeDataRows(ws, nDataRows, effectiveCols.length, fillHex);
  };

  const sourceOnlyCols = report.sourceOnlyRows.length > 0 ? Object.keys(report.sourceOnlyRows[0]) : [];
  writeOrSpill(
    sourceOnlyCols,
    report.sourceOnlyRows,
    "Source-Only Rows",
    "source_only_rows.csv",
    FILL_BREAK_HEX
  );

  const targetOnlyCols = report.targetOnlyRows.length > 0 ? Object.keys(report.targetOnlyRows[0]) : [];
  writeOrSpill(
    targetOnlyCols,
    report.targetOnlyRows,
    "Target-Only Rows",
    "target_only_rows.csv",
    FILL_BREAK_HEX
  );

  const valueDiffRows = valueDiffsToRows(report.valueDifferences);
  const valueDiffCols =
    valueDiffRows.length > 0
      ? Object.keys(valueDiffRows[0])
      : ["source_row", "target_row", "column", "source_value", "target_value", "delta", "within_tolerance"];
  writeOrSpill(valueDiffCols, valueDiffRows, "Value Differences", "value_differences.csv", FILL_DIFF_HEX);

  const ctWs = wb.addWorksheet("Control Totals");
  const ctRows = report.controlTotals.map((c) => ({
    column: c.column,
    source_total: c.sourceTotal.toString(),
    target_total: c.targetTotal.toString(),
    delta_target_minus_source: c.delta.toString(),
    ties_out: c.tiesOut,
  }));
  addTable(ctWs, ctRows.length > 0 ? Object.keys(ctRows[0]) : ["_"], ctRows);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, extras };
}
