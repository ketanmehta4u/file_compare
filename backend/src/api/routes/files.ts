import { Router } from "express";
import { fileCache } from "../../cache/stores";
import { loadCsv } from "../../engine/fileLoad/csv";
import { loadExcel, listExcelSheets } from "../../engine/fileLoad/excel";
import { sha256Hex } from "../../engine/fileLoad/hash";
import { uploadSingle } from "../upload";
import { uploadRateLimit } from "../middleware/rateLimit";
import { fileMetaToView } from "../toView";
import type { ExcelSheetsResponse, FileMetaView } from "../dto";
import type { FileMeta, Table } from "../../engine/types";

export const filesRouter = Router();

function isExcel(fileName: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "xlsx" || ext === "xls";
}

/** Port of the original's `_load_bytes` dispatch: extension picks CSV vs
 * Excel; for Excel, an unspecified sheet name falls back to the first
 * sheet in the workbook. */
async function loadBytes(
  data: Buffer,
  fileName: string,
  sheetName: string | undefined,
  hasHeader: boolean,
  delimiter: string | undefined
): Promise<{ table: Table; meta: FileMeta }> {
  if (isExcel(fileName)) {
    const sheet = sheetName || (await listExcelSheets(data, fileName))[0];
    if (!sheet) throw new Error(`${fileName}: workbook has no sheets.`);
    return loadExcel(data, fileName, { sheetName: sheet, hasHeader });
  }
  return loadCsv(data, fileName, { hasHeader, delimiter: delimiter ?? null });
}

filesRouter.post("/files/upload", uploadRateLimit, uploadSingle("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ detail: "No file uploaded." });
    const data = req.file.buffer;
    if (data.length === 0) return res.status(400).json({ detail: "Uploaded file is empty." });

    const sheetName = typeof req.body.sheet_name === "string" ? req.body.sheet_name : undefined;
    const hasHeader = req.body.has_header !== "false";
    const delimiter = typeof req.body.delimiter === "string" && req.body.delimiter ? req.body.delimiter : undefined;

    const { table, meta } = await loadBytes(data, req.file.originalname, sheetName, hasHeader, delimiter);
    const fileId = sha256Hex(data).slice(0, 16);
    fileCache.set(fileId, { table, meta, cachedAt: Date.now() });

    const body: FileMetaView = fileMetaToView(meta, fileId);
    res.json(body);
  } catch (err) {
    if (err instanceof Error) return res.status(400).json({ detail: err.message });
    next(err);
  }
});

filesRouter.post("/files/list-sheets", uploadRateLimit, uploadSingle("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ detail: "No file uploaded." });
    if (req.file.buffer.length === 0) return res.status(400).json({ detail: "Uploaded file is empty." });
    const sheets = await listExcelSheets(req.file.buffer, req.file.originalname);
    const body: ExcelSheetsResponse = { sheets };
    res.json(body);
  } catch (err) {
    if (err instanceof Error) return res.status(400).json({ detail: err.message });
    next(err);
  }
});

// Blob storage is out of scope for this port (matching the original's own
// already-disabled state) -- these are literal 400-returning stubs, no
// Azure SDK dependency at all.
const BLOB_DISABLED_MSG = { detail: "Azure Storage is disabled on this server — blob input/output are not available." };

filesRouter.post("/files/from-blob", uploadRateLimit, (_req, res) => {
  res.status(400).json(BLOB_DISABLED_MSG);
});

filesRouter.post("/files/blob-sheets", uploadRateLimit, (_req, res) => {
  res.status(400).json(BLOB_DISABLED_MSG);
});
