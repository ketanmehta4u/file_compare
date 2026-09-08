import ExcelJS from "exceljs";
import type { FileMeta, Table } from "../types";
import { cleanupColumnNames, inferColumnDtype } from "./csv";
import { sha256Hex } from "./hash";

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" -- ZIP signature
const XLS_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // OLE2 -- legacy .xls

/** Port of comparison.py's `_excel_engine_for`, narrowed to this port's
 * scope. Legacy `.xls` (OLE2) is explicitly out of scope -- see the
 * project's known-scope-reductions note -- so it's detected and rejected
 * with a clear error rather than silently mishandled. */
function assertXlsxMagicBytes(data: Buffer, fileName: string): void {
  if (data.subarray(0, 4).equals(XLSX_MAGIC)) return;
  if (data.subarray(0, 8).equals(XLS_MAGIC)) {
    throw new Error(
      `${fileName}: legacy .xls format is not supported in this port -- please re-save as .xlsx or .csv.`
    );
  }
  throw new Error(`${fileName}: not a recognised .xlsx file (unexpected file signature).`);
}

export async function listExcelSheets(data: Buffer, fileName: string): Promise<string[]> {
  assertXlsxMagicBytes(data, fileName);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
  return wb.worksheets.map((ws) => ws.name);
}

/** Best-effort string conversion of a cell's value, mirroring the source's
 * "everything read as string, normalisation happens later" policy. Not a
 * byte-for-byte match of Python's openpyxl+pandas string coercion for
 * every possible cell type (rich text, hyperlinks, and array formulas fall
 * through to a generic stringification) -- covers the common cases
 * (numbers, dates, strings, booleans, formulas with a cached result). */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDateLikePython(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    // Detect via "formula", not "result": exceljs omits the `result` key
    // entirely (not just sets it undefined) when a formula has no cached
    // value, so checking for "result" would miss exactly the uncalculated
    // case this branch exists to handle.
    if ("formula" in value || "sharedFormula" in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      return result === undefined ? "" : cellToString(result as ExcelJS.CellValue);
    }
    if ("richText" in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    }
    if ("text" in value) {
      return String((value as ExcelJS.CellHyperlinkValue).text);
    }
    if ("error" in value) return "";
  }
  return String(value);
}

/** Matches Python's `str(datetime)` formatting ("YYYY-MM-DD HH:MM:SS"),
 * read with local getters per the local-date convention noted in dates.ts. */
function formatDateLikePython(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const XLSX_INSPECT_MAX_BYTES = 25_000_000;

export interface LoadExcelOptions {
  sheetName: string;
  hasHeader?: boolean;
}

/**
 * Port of comparison.py's `load_excel` + `_inspect_xlsx`. Every cell is
 * read as a string (see cellToString) -- normalisation happens later via
 * normaliseCell, never here. Hidden-row/column and uncalculated-formula
 * inspection is best-effort and skipped above ~25MB or on any error --
 * it must never break a load.
 */
export async function loadExcel(
  data: Buffer,
  fileName: string,
  options: LoadExcelOptions
): Promise<{ table: Table; meta: FileMeta }> {
  if (data.length === 0) throw new Error(`${fileName}: file is empty (0 bytes).`);
  assertXlsxMagicBytes(data, fileName);

  const hasHeader = options.hasHeader ?? true;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(options.sheetName);
  if (!ws) throw new Error(`${fileName}: sheet "${options.sheetName}" not found.`);

  const width = ws.actualColumnCount;
  const rawRows: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) {
      cells.push(cellToString(row.getCell(c).value));
    }
    rawRows.push(cells);
  });

  let headerRow: string[];
  let dataRows: string[][];
  if (hasHeader) {
    headerRow = rawRows[0] ?? [];
    dataRows = rawRows.slice(1);
  } else {
    headerRow = Array.from({ length: width }, (_, i) => `col_${i + 1}`);
    dataRows = rawRows;
  }
  const columns = hasHeader ? cleanupColumnNames(headerRow) : headerRow;
  const rows: Array<Record<string, unknown>> = dataRows.map((r) => {
    const row: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      row[c] = r[i] ?? "";
    });
    return row;
  });

  const dtypes: Array<readonly [string, string]> = columns.map((c) => [
    c,
    inferColumnDtype(rows.map((r) => String(r[c] ?? ""))),
  ]);

  let hiddenColumns: string[] = [];
  let hiddenRowCount = 0;
  let formulaBlankColumns: string[] = [];
  let formulaBlankCount = 0;

  if (data.length <= XLSX_INSPECT_MAX_BYTES) {
    try {
      const inspected = inspectXlsx(ws, columns, rows.length, hasHeader);
      hiddenColumns = inspected.hiddenColumns;
      hiddenRowCount = inspected.hiddenRowCount;
      formulaBlankColumns = inspected.formulaBlankColumns;
      formulaBlankCount = inspected.formulaBlankCount;
    } catch {
      // Inspection is a nicety, never allowed to break the load.
    }
  }

  const meta: FileMeta = {
    name: fileName,
    sha256: sha256Hex(data),
    sizeBytes: data.length,
    rowCount: rows.length,
    columnCount: columns.length,
    columns,
    dtypes,
    sheetName: options.sheetName,
    hiddenColumns,
    hiddenRowCount,
    formulaBlankColumns,
    formulaBlankCount,
    hasHeader,
  };

  return { table: { columns, rows }, meta };
}

function inspectXlsx(
  ws: ExcelJS.Worksheet,
  columns: readonly string[],
  nRows: number,
  hasHeader: boolean
): {
  hiddenColumns: string[];
  hiddenRowCount: number;
  formulaBlankColumns: string[];
  formulaBlankCount: number;
} {
  const firstDataRow = hasHeader ? 2 : 1;

  const hiddenColumns: string[] = [];
  const seenHidden = new Set<string>();
  for (let ci = 1; ci <= columns.length; ci++) {
    const col = ws.getColumn(ci);
    if (col.hidden) {
      const name = columns[ci - 1];
      if (!seenHidden.has(name)) {
        seenHidden.add(name);
        hiddenColumns.push(name);
      }
    }
  }

  let hiddenRowCount = 0;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (row.hidden && rowNumber >= firstDataRow) hiddenRowCount++;
  });

  const blankFormulaCols = new Set<string>();
  let formulaBlankCount = 0;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    for (let ci = 1; ci <= columns.length; ci++) {
      const cell = row.getCell(ci);
      if (cell.type !== ExcelJS.ValueType.Formula) continue;
      const dataRow = rowNumber - firstDataRow;
      if (dataRow < 0 || dataRow >= nRows) continue;
      const result = (cell.value as ExcelJS.CellFormulaValue)?.result;
      if (result === undefined) {
        formulaBlankCount++;
        blankFormulaCols.add(columns[ci - 1]);
      }
    }
  });

  return {
    hiddenColumns,
    hiddenRowCount,
    formulaBlankColumns: [...blankFormulaCols],
    formulaBlankCount,
  };
}
