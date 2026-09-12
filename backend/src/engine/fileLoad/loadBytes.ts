import { loadCsv } from "./csv";
import { loadExcel, listExcelSheets } from "./excel";
import type { FileMeta, Table } from "../types";
import { InputError } from "../errors";

/**
 * Everything needed to re-parse an uploaded file identically later.
 *
 * Uploads are cached as raw bytes rather than parsed tables (a parsed
 * table costs roughly 12x the bytes it came from), so every consumer
 * parses on demand -- and must do so with exactly the options the upload
 * was read with, or a comparison would see different columns from the
 * ones the user was shown.
 */
export interface LoadOptions {
  sheetName?: string | null;
  hasHeader: boolean;
  delimiter?: string | null;
}

export function isExcelName(fileName: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "xlsx" || ext === "xls";
}

/**
 * Port of the original's `_load_bytes` dispatch: the extension picks CSV
 * vs Excel, and for Excel an unspecified sheet falls back to the first in
 * the workbook.
 */
export async function loadBytes(
  data: Buffer,
  fileName: string,
  options: LoadOptions
): Promise<{ table: Table; meta: FileMeta }> {
  if (isExcelName(fileName)) {
    const sheet = options.sheetName || (await listExcelSheets(data, fileName))[0];
    if (!sheet) throw new InputError(`${fileName}: workbook has no sheets.`);
    return loadExcel(data, fileName, { sheetName: sheet, hasHeader: options.hasHeader });
  }
  return loadCsv(data, fileName, {
    hasHeader: options.hasHeader,
    delimiter: options.delimiter ?? null,
  });
}
