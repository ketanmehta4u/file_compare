import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { loadCatalog, getMappingFor, applyMapping, keyCanonicalNames } from "../../src/engine/catalog";
import { loadCsv } from "../../src/engine/fileLoad/csv";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { CompareReport, CompareSettings, Table } from "../../src/engine/types";
import {
  buildExcelReport,
  detailSheetNames,
  EXCEL_MAX_ROWS,
  pendingBytes,
  ReportAbortedError,
  SheetXmlStream,
  sheetStreamOf,
  writeExcelReport,
} from "../../src/engine/report/buildExcelReport";
import type { SheetWriter } from "../../src/engine/report/buildExcelReport";
import {
  annotateForExcel,
  diffCellsForAnnotated,
  buildAnnotatedExcel,
} from "../../src/engine/report/annotate";

const FIXTURES = join(__dirname, "../../../fixtures");

async function buildSampleReport(): Promise<{
  report: CompareReport;
  settings: CompareSettings;
  srcTable: Table;
  tgtTable: Table;
}> {
  const catalog = await loadCatalog(
    readFileSync(join(FIXTURES, "sample_catalog.xlsx")),
    "sample_catalog.xlsx"
  );
  const mapping = getMappingFor(catalog, "GL_MONTHLY");
  const src = loadCsv(readFileSync(join(FIXTURES, "sample_source.csv")), "sample_source.csv");
  const tgt = loadCsv(readFileSync(join(FIXTURES, "sample_target.csv")), "sample_target.csv");
  const srcMapped = applyMapping(src.table, src.meta, "source", mapping, true);
  const tgtMapped = applyMapping(tgt.table, tgt.meta, "target", mapping, true);
  const settings = defaultSettings({ keyColumns: keyCanonicalNames(mapping) });
  const report = runComparison(
    srcMapped.table,
    srcMapped.meta,
    tgtMapped.table,
    tgtMapped.meta,
    settings,
    mapping
  );
  return { report, settings, srcTable: srcMapped.table, tgtTable: tgtMapped.table };
}

// Ported from tests/test_comparison.py::TestAnnotation and ::TestExcelReport.
describe("annotateForExcel", () => {
  let ctx: Awaited<ReturnType<typeof buildSampleReport>>;
  beforeAll(async () => {
    ctx = await buildSampleReport();
  });

  it("gives the same record id on both sides for a matched key, and it's the readable value", () => {
    const annS = annotateForExcel(ctx.srcTable, "source", ctx.report, ctx.settings);
    const annT = annotateForExcel(ctx.tgtTable, "target", ctx.report, ctx.settings);

    const srcIds = new Set(
      annS.rows.filter((r) => r._record_status !== "source_only").map((r) => r._record_id)
    );
    const tgtIds = new Set(
      annT.rows.filter((r) => r._record_status !== "target_only").map((r) => r._record_id)
    );
    expect(srcIds).toEqual(tgtIds);
    expect(srcIds.has("TXN-001")).toBe(true);
  });
});

describe("buildExcelReport", () => {
  let ctx: Awaited<ReturnType<typeof buildSampleReport>>;
  beforeAll(async () => {
    ctx = await buildSampleReport();
  });

  it("produces a valid, openable xlsx", async () => {
    const buffer = await buildExcelReport(ctx.report);
    expect(buffer.subarray(0, 2).toString()).toBe("PK"); // ZIP magic bytes

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Audit Header",
        "Summary",
        "Column Differences",
        "Source-Only Rows",
        "Target-Only Rows",
        "Value Differences",
        "Control Totals",
      ])
    );
  });

  it("Audit Header leads with the reconciliation verdict", async () => {
    const buffer = await buildExcelReport(ctx.report);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Audit Header")!;
    const row2 = ws.getRow(2).values as unknown[];
    expect(row2[1]).toBe("Reconciliation result");
    expect(String(row2[2])).toContain("DIFFERENCES FOUND");
  });
});

describe("diffCellsForAnnotated + buildAnnotatedExcel", () => {
  let ctx: Awaited<ReturnType<typeof buildSampleReport>>;
  beforeAll(async () => {
    ctx = await buildSampleReport();
  });

  it("highlights the exact mismatched cells with the diff-fill colour", async () => {
    const annotated = annotateForExcel(ctx.srcTable, "source", ctx.report, ctx.settings);
    const cells = diffCellsForAnnotated(annotated, ctx.report, ctx.settings);
    expect(cells.length).toBeGreaterThan(0);

    const buffer = await buildAnnotatedExcel(annotated, "source", cells);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("source")!;
    const [r, ci] = cells[0];
    const fill = ws.getRow(r + 2).getCell(ci + 1).fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe("FFFFC000");
  });

  it("colours the _record_status column per status", async () => {
    const annotated = annotateForExcel(ctx.srcTable, "source", ctx.report, ctx.settings);
    const buffer = await buildAnnotatedExcel(annotated, "source", []);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("source")!;
    const statusColIdx = annotated.columns.indexOf("_record_status") + 1;
    // Row 1 (TXN-001) is matched_equal -> green fill.
    const fill = ws.getRow(2).getCell(statusColIdx).fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe("FFC6EFCE");
  });
});

describe("detailSheetNames", () => {
  it("keeps a table that fits on one sheet under its own name", () => {
    expect(detailSheetNames("Value Differences", 0)).toEqual(["Value Differences"]);
    expect(detailSheetNames("Value Differences", EXCEL_MAX_ROWS - 1)).toEqual(["Value Differences"]);
  });

  // The header takes one of Excel's rows on every sheet, so the first row
  // that does not fit is row EXCEL_MAX_ROWS, not EXCEL_MAX_ROWS + 1.
  it("starts a second sheet exactly when the header plus rows would pass Excel's limit", () => {
    expect(detailSheetNames("Value Differences", EXCEL_MAX_ROWS)).toEqual([
      "Value Differences",
      "Value Differences (2)",
    ]);
    expect(detailSheetNames("Source-Only Rows", 2 * (EXCEL_MAX_ROWS - 1) + 1)).toEqual([
      "Source-Only Rows",
      "Source-Only Rows (2)",
      "Source-Only Rows (3)",
    ]);
  });
});

describe("a detail table longer than one sheet", () => {
  // A 5-row sheet limit (header + 4 rows) exercises the real splitting code
  // without writing a million rows.
  const MAX = 5;
  let wb: ExcelJS.Workbook;
  let padded: CompareReport;
  beforeAll(async () => {
    const { report } = await buildSampleReport();
    padded = {
      ...report,
      sourceOnlyRows: Array.from({ length: 10 }, (_, i) => ({ _row: i + 2, id: `ROW-${i}` })),
    };
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildExcelReport(padded, { maxRowsPerSheet: MAX }));
  });

  it("continues on numbered sheets, in order, right after the first", () => {
    const names = wb.worksheets.map((w) => w.name);
    const at = names.indexOf("Source-Only Rows");
    expect(names.slice(at, at + 4)).toEqual([
      "Source-Only Rows",
      "Source-Only Rows (2)",
      "Source-Only Rows (3)",
      "Target-Only Rows",
    ]);
  });

  it("loses no row, repeats no row, and keeps them in order", () => {
    const ids: string[] = [];
    for (const name of ["Source-Only Rows", "Source-Only Rows (2)", "Source-Only Rows (3)"]) {
      const ws = wb.getWorksheet(name)!;
      expect(ws.rowCount).toBeLessThanOrEqual(MAX);
      expect(ws.getRow(1).values).toEqual([undefined, "_row", "id"]); // header on every part
      ws.eachRow((row, n) => {
        if (n > 1) ids.push(String(row.getCell(2).value));
      });
    }
    expect(ids).toEqual(padded.sourceOnlyRows.map((r) => r.id));
  });

  it("shades the rows on every part, not just the first", () => {
    const fill = wb.getWorksheet("Source-Only Rows (3)")!.getRow(2).getCell(1).fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe("FFFFC7CE");
  });
});

// The real limit, end to end: past 1,048,576 rows the workbook still holds
// every row. Rows are counted straight from the zip rather than with
// exceljs's streaming reader, which cannot name sheets in a workbook whose
// workbook.xml comes last (as any streamed one does) and skips the final one.
describe("EXCEL_MAX_ROWS in a real workbook", () => {
  /** sheet name -> number of <row> elements, read without loading the workbook. */
  async function rowsPerSheet(buffer: Buffer): Promise<Map<string, number>> {
    const zip = await JSZip.loadAsync(buffer);
    const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    const targets = new Map(
      [...relsXml.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]])
    );
    const counts = new Map<string, number>();
    for (const m of workbookXml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      const entry = zip.file(`xl/${targets.get(m[2])}`)!;
      // JSZip hands back an old-style stream that is not async-iterable.
      const n = await new Promise<number>((resolve, reject) => {
        let rows = 0;
        let carry = "";
        entry
          .nodeStream()
          .on("data", (chunk: Buffer) => {
            const text = carry + chunk.toString("latin1");
            rows += text.split("<row ").length - 1;
            carry = text.slice(-4); // "<row " is 5 bytes, so at most 4 can straddle a chunk
          })
          .on("end", () => resolve(rows))
          .on("error", reject);
      });
      counts.set(m[1], n);
    }
    return counts;
  }

  it("puts the rows beyond Excel's limit on a second sheet instead of dropping them", async () => {
    const { report } = await buildSampleReport();
    const total = EXCEL_MAX_ROWS + 5;
    const padded: CompareReport = {
      ...report,
      sourceOnlyRows: Array.from({ length: total }, (_, i) => ({ id: i })),
    };
    const counts = await rowsPerSheet(await buildExcelReport(padded));

    expect(counts.get("Source-Only Rows")).toBe(EXCEL_MAX_ROWS); // full: header + 1,048,575 rows
    expect(counts.get("Source-Only Rows (2)")).toBe(1 + (total - (EXCEL_MAX_ROWS - 1))); // header + the rest
    expect(counts.get("Control Totals")).toBeGreaterThan(0); // the sheets after the split are all there
  });
});

// A download the user abandons must stop the work, not carry on writing a
// multi-million-row workbook to nobody -- and must not hang waiting for a
// response that will never finish.
describe("an abandoned download", () => {
  it("stops writing and rejects with ReportAbortedError", async () => {
    const { report } = await buildSampleReport();
    const padded: CompareReport = {
      ...report,
      sourceOnlyRows: Array.from({ length: 200_000 }, (_, i) => ({ id: i })),
    };
    let bytes = 0;
    const client = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback();
        if (bytes > 0) client.destroy(); // the user closes the tab after the first chunk
      },
    });

    await expect(writeExcelReport(padded, client)).rejects.toBeInstanceOf(ReportAbortedError);
  });

  // A small report never reaches a pacer check, so the only place to notice
  // a departed client is the final commit. If the client is already gone by
  // then, its "close" event has fired -- a listener added at that point would
  // wait forever -- so this must still settle, as an abort.
  it("does not hang when the client is already gone before the workbook finishes", async () => {
    const { report } = await buildSampleReport();
    const client = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    client.destroy();
    await new Promise((resolve) => client.once("close", resolve));

    const outcome = await Promise.race([
      writeExcelReport(report, client).then(
        () => "finished",
        (err: unknown) => (err instanceof ReportAbortedError ? "aborted" : `other: ${String(err)}`)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 10_000)),
    ]);
    expect(outcome).toBe("aborted");
  });
});

// The pacer depends on exceljs using the stream this module installs for
// each sheet (via its internal `_openStream`). If an exceljs upgrade stops
// honouring that, the pacer would see nothing queued and memory would
// quietly grow with the result again -- so fail here instead.
describe("the exceljs internals the pacer depends on", () => {
  it("writes each sheet through a stream whose queue is visible", async () => {
    const buffer = await buildExcelReport((await buildSampleReport()).report);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");

    // Probe the same hook directly: a sheet written through it reports its
    // queued bytes as a real number, and the workbook still opens.
    let probed = Number.NaN;
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const report = await buildSampleReport();
    const padded: CompareReport = {
      ...report.report,
      sourceOnlyRows: Array.from({ length: 3000 }, (_, i) => ({ id: `ROW-${i}` })),
    };
    const originalAdd = ExcelJS.stream.xlsx.WorkbookWriter.prototype.addWorksheet;
    ExcelJS.stream.xlsx.WorkbookWriter.prototype.addWorksheet = function (this: never, ...args: never[]) {
      const ws = (originalAdd as (...a: never[]) => SheetWriter).apply(this, args);
      const originalCommit = ws.commit.bind(ws);
      ws.commit = () => {
        if (Number.isNaN(probed)) {
          expect(sheetStreamOf(ws)).toBeInstanceOf(SheetXmlStream);
          probed = pendingBytes(ws);
        }
        originalCommit();
      };
      return ws;
    } as typeof originalAdd;
    try {
      await writeExcelReport(padded, out);
    } finally {
      ExcelJS.stream.xlsx.WorkbookWriter.prototype.addWorksheet = originalAdd;
    }
    expect(Number.isFinite(probed)).toBe(true);
  });
});
