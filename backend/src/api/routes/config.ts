import { Router } from "express";
import { maxUploadBytes } from "../../config/env";
import { EXCEL_MAX_ROWS } from "../../engine/report/buildExcelReport";
import type { ConfigInfo } from "../dto";

export const configRouter = Router();

/** Blob storage is out of scope for this port (the original app already
 * ships it hard-disabled) -- these flags always report false/empty,
 * matching the disabled state exactly rather than a partial integration. */
configRouter.get("/config", (_req, res) => {
  const body: ConfigInfo = {
    blob_read_enabled: false,
    blob_write_enabled: false,
    blob_output_container_url: "",
    excel_max_rows: EXCEL_MAX_ROWS,
    max_upload_bytes: maxUploadBytes(),
  };
  res.json(body);
});
