import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildExcelReport, GUIDE_SHEET } from "../../src/engine/report/buildExcelReport";
import { runComparison } from "../../src/engine/runComparison";
import { loadCsv } from "../../src/engine/fileLoad/csv";
import { defaultSettings } from "../../src/engine/types";

/** Builds a real workbook from two small CSVs and reads it back. */
async function workbookFor(source: string, target: string, keyColumns: string[] = ["id"]) {
  const src = loadCsv(Buffer.from(source), "source.csv");
  const tgt = loadCsv(Buffer.from(target), "target.csv");
  const report = runComparison(src.table, src.meta, tgt.table, tgt.meta, defaultSettings({ keyColumns }));
  const buffer = await buildExcelReport(report);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return { wb, report };
}

/** All text on the guide sheet, flattened. */
function guideText(wb: ExcelJS.Workbook): string {
  const ws = wb.getWorksheet(GUIDE_SHEET)!;
  const parts: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => parts.push(String(cell.value ?? ""))));
  return parts.join("\n");
}

const SOURCE = ["id,amount", "1,10.00", "2,20.00", "3,30.00", ""].join("\n");
const TARGET = ["id,amount", "1,10.00", "2,22.50", "4,40.00", ""].join("\n");

describe("the reading guide inside the audit workbook", () => {
  it("is the first sheet, so it is the tab a reader opens", async () => {
    const { wb } = await workbookFor(SOURCE, TARGET);
    expect(wb.worksheets[0].name).toBe(GUIDE_SHEET);
  });

  it("states this run's own verdict, not a generic one", async () => {
    const { wb, report } = await workbookFor(SOURCE, TARGET);
    expect(guideText(wb)).toContain(report.audit.outcome!.verdict);
  });

  it("explains every sheet actually present in the workbook", async () => {
    const { wb } = await workbookFor(SOURCE, TARGET);
    const text = guideText(wb);
    for (const ws of wb.worksheets) {
      if (ws.name === GUIDE_SHEET) continue;
      expect(text, `guide should describe the "${ws.name}" sheet`).toContain(ws.name);
    }
  });

  // Built from the report, not fixed text: it must not send a reader looking
  // for a Warnings sheet that was never written.
  it("mentions the Warnings sheet only when the workbook has one", async () => {
    const clean = await workbookFor(SOURCE, TARGET);
    expect(clean.wb.getWorksheet("Warnings")).toBeUndefined();
    expect(guideText(clean.wb)).not.toMatch(/^Warnings$/m);

    const duplicated = ["id,amount", "1,10.00", "1,99.00", "2,20.00", ""].join("\n");
    const warned = await workbookFor(duplicated, TARGET);
    expect(warned.wb.getWorksheet("Warnings")).toBeDefined();
    expect(guideText(warned.wb)).toMatch(/^Warnings$/m);
  });

  // The guide's claim must match the engine: a duplicated key present on
  // both sides compares only its first row, but one present on a single side
  // lists every row as one-sided.
  it("describes duplicate keys the way the engine treats them", async () => {
    const source = ["id,amount", "1,10.00", "1,99.00", "5,50.00", "5,55.00", ""].join("\n");
    const target = ["id,amount", "1,10.00", ""].join("\n");
    const { wb, report } = await workbookFor(source, target);
    expect(report.sourceOnlyRows).toHaveLength(2); // both id=5 rows
    expect(report.matchedEqualCount).toBe(1); // only the first id=1 row
    expect(guideText(wb)).toContain("only the FIRST of them");
    expect(guideText(wb)).toContain("lists all of its rows");
  });

  it("describes how rows were matched for this run's key columns", async () => {
    const keyed = await workbookFor(SOURCE, TARGET, ["id"]);
    expect(guideText(keyed.wb)).toContain("matched on the key column(s): id");

    const wholeRow = await workbookFor(SOURCE, TARGET, []);
    expect(guideText(wholeRow.wb)).toContain("ENTIRE content");
  });

  it("says which way the value delta runs, matching the engine", async () => {
    const { wb, report } = await workbookFor(SOURCE, TARGET);
    expect(guideText(wb)).toContain("TARGET minus SOURCE");
    // Target 22.50 against source 20.00: the engine's delta must agree.
    const diff = report.valueDifferences.find((d) => d.column === "amount")!;
    expect(diff.delta!.toNumber()).toBe(2.5);
  });

  it("uses the same colours in its legend as the detail sheets", async () => {
    const { wb } = await workbookFor(SOURCE, TARGET);
    const legendFill = (label: string) => {
      let argb: string | undefined;
      wb.getWorksheet(GUIDE_SHEET)!.eachRow((row) => {
        if (row.getCell(1).value === label) {
          argb = (row.getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb;
        }
      });
      return argb;
    };
    const firstDataFill = (sheet: string) =>
      (wb.getWorksheet(sheet)!.getRow(2).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb;

    expect(legendFill("Red rows")).toBe(firstDataFill("Source-Only Rows"));
    expect(legendFill("Amber rows")).toBe(firstDataFill("Value Differences"));
  });
});
