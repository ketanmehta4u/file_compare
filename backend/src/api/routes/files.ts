import { Router } from "express";
import { fileCache } from "../../cache/stores";
import { listExcelSheets } from "../../engine/fileLoad/excel";
import { loadBytes, type LoadOptions } from "../../engine/fileLoad/loadBytes";
import { sha256Hex } from "../../engine/fileLoad/hash";
import { uploadSingle } from "../upload";
import { uploadRateLimit } from "../middleware/rateLimit";
import { fileMetaToView } from "../toView";
import type { ExcelSheetsResponse, FileMetaView } from "../dto";
import type { FileMeta, Table } from "../../engine/types";
import { respondWithError } from "../errors";

export const filesRouter = Router();

filesRouter.post("/files/upload", uploadRateLimit, uploadSingle("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: "No file uploaded." });
    const data = req.file.buffer;
    if (data.length === 0) return res.status(400).json({ detail: "Uploaded file is empty." });

    const load: LoadOptions = {
      sheetName: typeof req.body.sheet_name === "string" ? req.body.sheet_name : undefined,
      hasHeader: req.body.has_header !== "false",
      delimiter: typeof req.body.delimiter === "string" && req.body.delimiter ? req.body.delimiter : undefined,
    };

    // Parsed once here for the metadata the UI needs (columns, dtypes, row
    // counts, hidden-data notices) -- then the table is dropped and only
    // the bytes are cached. Everything downstream re-parses from those,
    // which keeps steady-state memory close to what was uploaded rather
    // than roughly twelve times it.
    const { meta } = await loadBytes(data, req.file.originalname, load);
    const fileId = sha256Hex(data).slice(0, 16);
    fileCache.set(fileId, { bytes: data, meta, load, cachedAt: Date.now() });

    const body: FileMetaView = fileMetaToView(meta, fileId);
    res.json(body);
  } catch (err) {
    respondWithError(req, res, err);
  }
});

filesRouter.post("/files/list-sheets", uploadRateLimit, uploadSingle("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: "No file uploaded." });
    if (req.file.buffer.length === 0) return res.status(400).json({ detail: "Uploaded file is empty." });
    const sheets = await listExcelSheets(req.file.buffer, req.file.originalname);
    const body: ExcelSheetsResponse = { sheets };
    res.json(body);
  } catch (err) {
    respondWithError(req, res, err);
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
