import { Router } from "express";
import { maxUploadBytes, maxResponseRows } from "../../config/env";
import { EXCEL_MAX_ROWS } from "../../engine/report/buildExcelReport";
import type { ConfigInfo } from "../dto";

/** The limits the UI must respect, fetched once at startup. */
export const configRouter = Router();

/** The limits the UI must respect: Excel's row ceiling, the effective
 * upload cap, and how many rows a compare response will carry. */
configRouter.get("/config", (_req, res) => {
  const body: ConfigInfo = {
    excel_max_rows: EXCEL_MAX_ROWS,
    max_upload_bytes: maxUploadBytes(),
    max_response_rows: maxResponseRows(),
  };
  res.json(body);
});
