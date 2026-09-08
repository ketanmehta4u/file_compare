import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { listExcelSheets, loadExcel } from "../../src/engine/fileLoad/excel";

const FIXTURES = join(__dirname, "../../../fixtures");

// Ported from tests/test_comparison.py::TestLoading (Excel subset).
describe("listExcelSheets", () => {
  it("reads sheet names from the real sample_catalog.xlsx fixture", async () => {
    const data = readFileSync(join(FIXTURES, "sample_catalog.xlsx"));
    const sheets = await listExcelSheets(data, "sample_catalog.xlsx");
    expect(sheets).toContain("Datasets");
    expect(sheets).toContain("Columns");
  });

  it("rejects a legacy .xls (OLE2) file with a clear error, not a silent misread", async () => {
    const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(listExcelSheets(oleHeader, "legacy.xls")).rejects.toThrow(/legacy \.xls/);
  });

  it("rejects a non-Excel file", async () => {
    await expect(listExcelSheets(Buffer.from("col1,col2\n1,2\n"), "data.csv")).rejects.toThrow(
      /not a recognised \.xlsx/
    );
  });
});

describe("loadExcel", () => {
  it("loads the real sample_catalog.xlsx fixture", async () => {
    const data = readFileSync(join(FIXTURES, "sample_catalog.xlsx"));
    const { table, meta } = await loadExcel(data, "sample_catalog.xlsx", { sheetName: "Datasets" });
    expect(meta.rowCount).toBe(2);
    expect(meta.columns).toContain("dataset_id");
    expect(table.rows[0].dataset_id).toBe("GL_MONTHLY");
  });

  it("raises on empty input", async () => {
    await expect(loadExcel(Buffer.alloc(0), "empty.xlsx", { sheetName: "Sheet1" })).rejects.toThrow(/empty/);
  });

  it("detects hidden columns and rows, and includes their data in the comparison", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(["id", "amount", "tax"]);
    ws.addRow(["A", 100, 20]);
    ws.addRow(["B", 200, 40]); // this row will be hidden
    ws.getColumn(3).hidden = true; // hide "tax"
    ws.getRow(3).hidden = true;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const { table, meta } = await loadExcel(buf, "hidden.xlsx", { sheetName: "Data" });
    expect(meta.columns).toContain("tax");
    expect(meta.rowCount).toBe(2);
    expect(table.rows.map((r) => r.tax)).toEqual(["20", "40"]); // hidden cells still read/compared
    expect(meta.hiddenColumns).toEqual(["tax"]);
    expect(meta.hiddenRowCount).toBe(1);
  });

  it("flags uncalculated formula cells as blank rather than a value", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(["id", "total"]);
    const row = ws.addRow(["A", null]);
    // A formula with no cached result -- exceljs writes { formula } with no `result`.
    row.getCell(2).value = { formula: "1+1" } as ExcelJS.CellFormulaValue;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const { table, meta } = await loadExcel(buf, "formula.xlsx", { sheetName: "Data" });
    expect(table.rows[0].total).toBe(""); // read as blank, not "1+1" or an error
    expect(meta.formulaBlankColumns).toEqual(["total"]);
    expect(meta.formulaBlankCount).toBe(1);
  });
});
