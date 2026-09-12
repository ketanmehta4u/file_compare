import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { loadCatalog, getMappingFor, applyMapping, keyCanonicalNames } from "../../src/engine/catalog";
import { loadCsv } from "../../src/engine/fileLoad/csv";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { CompareReport, CompareSettings, Table } from "../../src/engine/types";
import { buildExcelReport, EXCEL_MAX_ROWS } from "../../src/engine/report/buildExcelReport";
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

  it("produces a valid, openable xlsx with nothing spilled to CSV", async () => {
    const { buffer, extras } = await buildExcelReport(ctx.report);
    expect(buffer.subarray(0, 2).toString()).toBe("PK"); // ZIP magic bytes
    expect(extras).toEqual({});

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
    const { buffer } = await buildExcelReport(ctx.report);
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

describe("EXCEL_MAX_ROWS spill behaviour", () => {
  it("spills to CSV and leaves a placeholder note when a sheet would exceed the row cap", async () => {
    const { report } = await buildSampleReport();
    // Force a spill by padding source_only_rows past the cap, without
    // touching the real comparison result.
    const padded: CompareReport = {
      ...report,
      sourceOnlyRows: Array.from({ length: EXCEL_MAX_ROWS + 5 }, (_, i) => ({ id: i })),
    };
    const { extras } = await buildExcelReport(padded);
    expect(extras["source_only_rows.csv"]).toBeDefined();
    expect(extras["source_only_rows.csv"].split("\n").length).toBeGreaterThan(EXCEL_MAX_ROWS);
  });
});
