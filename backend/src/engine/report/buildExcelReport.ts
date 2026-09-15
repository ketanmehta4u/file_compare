import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import ExcelJS from "exceljs";
import type { CompareReport, ValueDifference } from "../types";
import { auditHeaderToRows, type Row } from "./auditRows";

/** Excel's hard limit on rows per sheet, header row included. */
export const EXCEL_MAX_ROWS = 1_048_576;

const FILL_BREAK_HEX = "FFC7CE"; // red -- source_only/target_only
const FILL_DIFF_HEX = "FFEB9C"; // amber -- matched_with_differences

function stringifyKeyPart(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Port of comparison.py's `_value_diffs_to_frame`: flattens one
 * ValueDifference into a plain row with `key.<col>` prefixed key fields.
 * Done a row at a time as the sheet is written, so a large result is never
 * copied into a second array of objects. */
function valueDiffToRow(d: ValueDifference): Record<string, unknown> {
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

/**
 * The sheet names a detail table occupies. Excel caps a sheet at
 * EXCEL_MAX_ROWS rows including its header, but a workbook may hold any
 * number of sheets, so a larger table carries on in "Name (2)", "Name (3)"
 * and so on rather than being cut off or moved out of the workbook.
 */
export function detailSheetNames(base: string, rowCount: number, maxRows = EXCEL_MAX_ROWS): string[] {
  const perSheet = maxRows - 1;
  const parts = Math.max(1, Math.ceil(rowCount / perSheet));
  return Array.from({ length: parts }, (_, i) => (i === 0 ? base : `${base} (${i + 1})`));
}

/** The download was abandoned (the client disconnected) before it finished. */
export class ReportAbortedError extends Error {
  constructor() {
    super("The audit workbook download was abandoned before it finished.");
    this.name = "ReportAbortedError";
  }
}

export type SheetWriter = ReturnType<ExcelJS.stream.xlsx.WorkbookWriter["addWorksheet"]>;

/** Uncompressed sheet XML allowed to queue for the compressor before writing pauses. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * The stream each sheet's XML is written into on its way to the zip.
 *
 * exceljs normally uses its own buffer class here, and that is what made a
 * large workbook pile up in memory: it is not a real Node stream, so the zip
 * library wraps it in a PassThrough of its own, and exceljs pours XML into
 * that wrapper ignoring backpressure. Nothing outside could see how much was
 * queued -- measured, 1.2M rows reached the client almost entirely in the
 * last seconds, the uncompressed XML held in memory until then.
 *
 * A plain Node PassThrough, installed in its place, makes the queue visible
 * through public stream APIs (writableLength, readableLength, "drain"). The
 * one adaptation: exceljs writes its own StringBuf objects, which a Node
 * stream will not accept, and it reuses a single StringBuf for every write --
 * so each chunk is copied into a fresh Buffer before it is queued.
 */
export class SheetXmlStream extends PassThrough {
  constructor() {
    super({ highWaterMark: 1024 * 1024 });
  }

  override write(chunk: unknown, ...rest: unknown[]): boolean {
    let data = chunk;
    if (typeof chunk === "string") data = Buffer.from(chunk, "utf8");
    else if (!Buffer.isBuffer(chunk) && typeof (chunk as { toBuffer?: unknown })?.toBuffer === "function") {
      data = Buffer.from((chunk as { toBuffer(): Buffer }).toBuffer());
    }
    return (super.write as (...args: unknown[]) => boolean).call(this, data, ...rest);
  }
}

/**
 * Routes every stream the workbook writer opens through a SheetXmlStream.
 * `_openStream` and `zip` are internals of exceljs 4.4.0 (its final
 * release); this mirrors exceljs's own three-line implementation, and a test
 * in report.spec.ts fails loudly if an upgrade stops honouring it.
 */
function useVisibleSheetStreams(wb: ExcelJS.stream.xlsx.WorkbookWriter): void {
  const internals = wb as unknown as {
    zip: { append(source: NodeJS.ReadableStream, data: { name: string }): void };
    _openStream(path: string): SheetXmlStream;
  };
  internals._openStream = (path: string) => {
    const stream = new SheetXmlStream();
    internals.zip.append(stream, { name: path });
    stream.on("finish", () => stream.emit("zipped"));
    return stream;
  };
}

/** The stream a sheet's XML goes into (exceljs's `stream` getter). */
export function sheetStreamOf(ws: SheetWriter): unknown {
  return (ws as unknown as { stream?: unknown }).stream;
}

/** Bytes of a sheet's XML written but not yet taken by the compressor. */
export function pendingBytes(ws: SheetWriter): number {
  const stream = sheetStreamOf(ws);
  return stream instanceof SheetXmlStream ? stream.writableLength + stream.readableLength : 0;
}

/** Settles on whichever of the given events happens first. */
function firstEvent(...sources: Array<[NodeJS.EventEmitter, string]>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      for (const [emitter, name] of sources) emitter.off(name, done);
      resolve();
    };
    for (const [emitter, name] of sources) emitter.on(name, done);
  });
}

/**
 * Keeps the writer in step with the compressor and with whoever is reading
 * the workbook: every so often it waits until the queued sheet XML is back
 * under MAX_PENDING_BYTES and the destination has room. That bounds memory
 * however large the result, and gives other requests their turn.
 */
class Pacer {
  private rows = 0;
  constructor(
    private readonly out: Writable,
    private readonly every = 1000
  ) {}

  /** Cheap per-row check; only every `every` rows does it need awaiting. */
  due(): boolean {
    return ++this.rows % this.every === 0;
  }

  async wait(ws: SheetWriter): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    for (;;) {
      if (this.out.destroyed) throw new ReportAbortedError();
      if (this.out.writableNeedDrain) {
        await firstEvent([this.out, "drain"], [this.out, "close"]);
        continue;
      }
      const stream = sheetStreamOf(ws);
      if (!(stream instanceof SheetXmlStream) || pendingBytes(ws) <= MAX_PENDING_BYTES) return;
      // Over the limit means the stream's own buffer is past its high-water
      // mark, so "drain" is due once the compressor has taken it -- including
      // when the zip has not reached this sheet yet and starts on it later.
      await firstEvent([stream, "drain"], [stream, "close"], [this.out, "close"]);
    }
  }
}

const solidFill = (hex: string): ExcelJS.Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: `FF${hex}` },
});

const cellValue = (v: unknown) => (v === undefined || v === null ? "" : v);

export const GUIDE_SHEET = "How to Read";

/** What the guide needs to know about how the detail tables were laid out. */
interface DetailLayout {
  name: string;
  rowCount: number;
  sheets: string[];
}

/**
 * A plain-language guide to the workbook, written into the workbook itself
 * so it travels with the file -- an auditor reading a report emailed to
 * them months later has no app, no README and no one to ask.
 *
 * Built from the report rather than written as fixed text, so it only ever
 * describes sheets that are actually present: the Warnings sheet exists
 * only when there were warnings, and a detail table too large for one sheet
 * is described with the names of every sheet it runs across.
 */
function writeReadingGuide(
  wb: ExcelJS.stream.xlsx.WorkbookWriter,
  report: CompareReport,
  layout: DetailLayout[]
): void {
  const ws = wb.addWorksheet(GUIDE_SHEET);
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 100;

  const put = (label: string, body: string, opts: { bold?: boolean; fillHex?: string } = {}) => {
    const row = ws.addRow([label, body]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    if (opts.bold) row.getCell(2).font = { bold: true };
    if (opts.fillHex) row.getCell(1).fill = solidFill(opts.fillHex);
    row.commit();
  };
  const heading = (text: string) => {
    ws.addRow([]).commit();
    const row = ws.addRow([text]);
    row.getCell(1).font = { bold: true, size: 13 };
    row.commit();
  };

  const title = ws.addRow(["How to read this reconciliation workbook"]);
  title.getCell(1).font = { bold: true, size: 16 };
  title.commit();
  const intro = ws.addRow([
    "",
    "This workbook compares a SOURCE file against a TARGET file. Start with the verdict, then work " +
      "through the sheets below in order. Every figure here is the complete result: unlike the " +
      "on-screen preview, nothing in this workbook is trimmed.",
  ]);
  intro.getCell(2).alignment = { wrapText: true, vertical: "top" };
  intro.commit();

  heading("1. Start here: the verdict");
  put("This run's result", report.audit.outcome?.verdict ?? "(no verdict recorded)", { bold: true });
  put("RECONCILED", "Every row matched and every control total tied out. Nothing requires review.");
  put(
    "RECONCILED WITHIN TOLERANCE",
    "No hard breaks, but some matched rows differ by an amount inside the numeric tolerance that was " +
      "set. They are listed on Value Differences with within_tolerance = true; review them if the " +
      "tolerance was generous."
  );
  put(
    "DIFFERENCES FOUND",
    "At least one break: a row on only one side, a matched row with a real difference, or a control " +
      "total that does not tie out. The number in the verdict is how many breaks need review."
  );

  heading("2. The sheets, in order");
  const detail = (name: string, body: string) => {
    const { rowCount, sheets } = layout.find((l) => l.name === name)!;
    put(
      name,
      sheets.length > 1
        ? body +
            ` SPLIT ACROSS ${sheets.length} SHEETS: this result has ${rowCount.toLocaleString("en-US")} ` +
            `rows, more than one Excel sheet can hold (${EXCEL_MAX_ROWS.toLocaleString("en-US")} rows ` +
            `including the header), so it runs across ${sheets.join(", ")}. Each part repeats the ` +
            "header row, and the rows carry on in order from one part to the next."
        : body
    );
  };
  put(
    "Audit Header",
    "Who ran the comparison and when, the exact files compared (name, size and SHA-256 fingerprint), " +
      "and every setting that was in force. The SHA-256 proves which file was compared: if a " +
      "fingerprint differs, it is not the same file, whatever its name."
  );
  put(
    "Summary",
    "Every count in one table: rows and columns on each side, rows matched, differing or on one side " +
      "only, duplicate rows and keys, and control totals. Read it before the detail sheets to know " +
      "how much there is to look at."
  );
  if (report.warnings.length > 0) {
    put(
      "Warnings",
      `This run produced ${report.warnings.length} warning(s). Read them before relying on the ` +
        "numbers: they describe situations that change what the result means, such as hidden Excel " +
        "rows or columns that were included, formulas with no calculated value read as blank, " +
        "duplicate keys, or key columns missing from one side."
    );
  }
  put(
    "Column Differences",
    "Structure, not data. status source_only or target_only: a column in one file only. common: in " +
      "both. sequence_mismatch: a common column in a different position (source_index and " +
      "target_index, counted from 0). dtype_mismatch: the same column holds different kinds of " +
      "value on each side (source_dtype and target_dtype)."
  );
  detail(
    "Source-Only Rows",
    "Rows in the SOURCE with no matching row in the TARGET, typically an entry the target is missing. " +
      "_row is that row's number in the source file as Excel would show it (a header row, when the " +
      "file has one, is row 1)."
  );
  detail(
    "Target-Only Rows",
    "Rows in the TARGET with no matching row in the SOURCE, typically an entry the source does not " +
      "have. _row is its row number in the target file."
  );
  detail(
    "Value Differences",
    "One line per differing CELL in a row that did match. key.<column> identifies the record; " +
      "source_row and target_row locate it in each file; column names the field; source_value and " +
      "target_value are as they appear in the files; delta is TARGET minus SOURCE for numbers and " +
      "blank for text; within_tolerance = true means the difference is inside the tolerance and is " +
      "not counted as a break."
  );
  put(
    "Control Totals",
    "An independent check that does not depend on row matching: each numeric column summed on both " +
      "sides. delta_target_minus_source is exact decimal arithmetic with no rounding. ties_out = " +
      "false means the column does not balance, even if every row appears to match."
  );

  heading("3. Colours");
  put("Red rows", "A break: a row present on only one side (Source-Only Rows, Target-Only Rows).", {
    fillHex: FILL_BREAK_HEX,
  });
  put("Amber rows", "A matched row whose values differ (Value Differences).", { fillHex: FILL_DIFF_HEX });

  heading("4. Things that catch people out");
  const keys = report.audit.settings.keyColumns;
  put(
    "How rows were matched",
    keys.length > 0
      ? `Rows were matched on the key column(s): ${keys.join(", ")}. Rows with the same key are ` +
          "treated as the same record, and their other columns are compared cell by cell."
      : "No key columns were set, so rows were matched on their ENTIRE content. Any difference at all " +
          "makes a row appear as both source-only and target-only rather than as a value difference. " +
          "Set key columns to see which fields differ."
  );
  put(
    "Duplicate keys",
    "When several rows in one file share a key that the other file also has, only the FIRST of them " +
      "is compared and the rest are not matched. A key found in one file only lists all of its rows on " +
      "Source-Only Rows or Target-Only Rows. The Summary sheet counts duplicates. Make the key unique, " +
      "for example with more than one key column, to compare every row."
  );
  put("Dates", "Ambiguous numeric dates are read day-first: 03/04/2024 is 3 April 2024, not 4 March.");
  put(
    "Numbers",
    "All money arithmetic is exact decimal, never floating point. Currency symbols, thousands " +
      "separators and accounting-style negatives in brackets, such as (1,200.00), are understood."
  );
  put(
    "Leading zeros",
    "A value that looks like a number is compared as one, so 00123 equals 123. Where leading zeros " +
      "matter, the column must be declared with dtype id."
  );
  ws.commit();
}

/** A small sheet: a header row and a handful of rows, written in one go. */
function writeSmallSheet(
  wb: ExcelJS.stream.xlsx.WorkbookWriter,
  name: string,
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>
): void {
  const ws: SheetWriter = wb.addWorksheet(name);
  ws.addRow([...columns]).commit();
  for (const row of rows) ws.addRow(columns.map((c) => cellValue(row[c]))).commit();
  ws.commit();
}

/**
 * A detail table, possibly millions of rows, written one row at a time and
 * split across as many sheets as Excel's row limit requires. Each sheet is
 * committed -- flushed into the zip and released -- before the next begins.
 */
async function writeDetailSheets(
  wb: ExcelJS.stream.xlsx.WorkbookWriter,
  sheets: readonly string[],
  columns: readonly string[],
  rowCount: number,
  rowAt: (i: number) => Record<string, unknown>,
  fillHex: string,
  maxRows: number,
  pacer: Pacer
): Promise<void> {
  const cols = columns.length > 0 ? columns : ["_"];
  const fill = solidFill(fillHex);
  const perSheet = maxRows - 1;
  for (let part = 0; part < sheets.length; part++) {
    const ws: SheetWriter = wb.addWorksheet(sheets[part]);
    ws.addRow([...cols]).commit();
    const end = Math.min(rowCount, (part + 1) * perSheet);
    for (let i = part * perSheet; i < end; i++) {
      const src = rowAt(i);
      const row = ws.addRow(cols.map((c) => cellValue(src[c])));
      for (let c = 1; c <= cols.length; c++) row.getCell(c).fill = fill;
      row.commit();
      if (pacer.due()) await pacer.wait(ws);
    }
    ws.commit();
  }
}

export interface ExcelReportOptions {
  /** Rows per sheet including the header. Only tests lower it, so that
   * splitting can be exercised without writing a million rows. */
  maxRowsPerSheet?: number;
}

/**
 * Port of comparison.py's `build_excel_report`, streamed. Writes the audit
 * workbook -- How to Read, Audit Header, Summary, Warnings (if any), Column
 * Differences, Source/Target-Only Rows, Value Differences, Control Totals --
 * straight into `out`, typically the HTTP response.
 *
 * Nothing is left out: a detail table longer than Excel's per-sheet limit
 * continues on further sheets (see detailSheetNames). And the file is never
 * held whole on the server: rows are written as they are produced, each
 * finished sheet is released, and writing waits whenever the compressor falls
 * behind or `out` is full (see Pacer).
 *
 * Rejects with ReportAbortedError if `out` is destroyed first (the client
 * went away).
 */
export async function writeExcelReport(
  report: CompareReport,
  out: Writable,
  options: ExcelReportOptions = {}
): Promise<void> {
  const maxRows = options.maxRowsPerSheet ?? EXCEL_MAX_ROWS;
  const pacer = new Pacer(out);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  useVisibleSheetStreams(wb);

  const valueDiffCols =
    report.valueDifferences.length > 0
      ? Object.keys(valueDiffToRow(report.valueDifferences[0]))
      : ["source_row", "target_row", "column", "source_value", "target_value", "delta", "within_tolerance"];
  const details = [
    {
      name: "Source-Only Rows",
      rowCount: report.sourceOnlyRows.length,
      columns: report.sourceOnlyRows.length > 0 ? Object.keys(report.sourceOnlyRows[0]) : [],
      rowAt: (i: number) => report.sourceOnlyRows[i],
      fillHex: FILL_BREAK_HEX,
    },
    {
      name: "Target-Only Rows",
      rowCount: report.targetOnlyRows.length,
      columns: report.targetOnlyRows.length > 0 ? Object.keys(report.targetOnlyRows[0]) : [],
      rowAt: (i: number) => report.targetOnlyRows[i],
      fillHex: FILL_BREAK_HEX,
    },
    {
      name: "Value Differences",
      rowCount: report.valueDifferences.length,
      columns: valueDiffCols,
      rowAt: (i: number) => valueDiffToRow(report.valueDifferences[i]),
      fillHex: FILL_DIFF_HEX,
    },
  ].map((d) => ({ ...d, sheets: detailSheetNames(d.name, d.rowCount, maxRows) }));

  // The layout is known before anything is written, so the guide can
  // describe the workbook exactly and still be the first tab.
  writeReadingGuide(wb, report, details);

  writeSmallSheet(
    wb,
    "Audit Header",
    ["Field", "Value"],
    auditHeaderToRows(report.audit).map(([f, v]) => ({ Field: f, Value: v }))
  );
  writeSmallSheet(
    wb,
    "Summary",
    ["Metric", "Value"],
    summaryRows(report).map(([m, v]) => ({ Metric: m, Value: v }))
  );
  if (report.warnings.length > 0) {
    writeSmallSheet(
      wb,
      "Warnings",
      ["Warning"],
      report.warnings.map((w) => ({ Warning: w }))
    );
  }

  const cd = report.columnDiff;
  writeSmallSheet(
    wb,
    "Column Differences",
    ["column", "status", "source_index", "target_index", "source_dtype", "target_dtype"],
    [
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
    ]
  );

  for (const d of details) {
    await writeDetailSheets(wb, d.sheets, d.columns, d.rowCount, d.rowAt, d.fillHex, maxRows, pacer);
  }

  const ctRows = report.controlTotals.map((c) => ({
    column: c.column,
    source_total: c.sourceTotal.toString(),
    target_total: c.targetTotal.toString(),
    delta_target_minus_source: c.delta.toString(),
    ties_out: c.tiesOut,
  }));
  writeSmallSheet(wb, "Control Totals", ctRows.length > 0 ? Object.keys(ctRows[0]) : ["_"], ctRows);

  // commit() settles when `out` finishes, which never happens if the client
  // has already gone -- so also stop waiting once `out` is done either way.
  // finished() rather than a "close" listener: the client may have left
  // before this line, after the last pacer check (a small report never
  // reaches one), and a listener added now would wait for an event that
  // has already fired.
  await Promise.race([wb.commit(), finished(out).catch(() => undefined)]);
  if (!out.writableFinished) throw new ReportAbortedError();
}

/**
 * The whole workbook as one Buffer, for tests and small callers. The
 * download route streams instead (writeExcelReport), so a large result is
 * never held whole in memory there.
 */
export async function buildExcelReport(
  report: CompareReport,
  options: ExcelReportOptions = {}
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await writeExcelReport(report, sink, options);
  return Buffer.concat(chunks);
}
