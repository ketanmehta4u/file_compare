import type { NextFunction, Request, Response } from "express";
import { maxUploadBytes, multipartSlackBytes } from "../../config/env";

/** Port of the original's `body_size_guard` middleware: advisory
 * Content-Length pre-check before the body streams. Doesn't catch a
 * missing/false Content-Length -- actual bytes read are enforced
 * per-endpoint by multer's own `limits.fileSize`. */
export function bodySizeGuard(req: Request, res: Response, next: NextFunction): void {
  const contentLength = req.headers["content-length"];
  if (contentLength && /^\d+$/.test(contentLength)) {
    const cap = maxUploadBytes() + multipartSlackBytes();
    if (Number(contentLength) > cap) {
      res
        .status(413)
        .json({ detail: `Request body exceeds the server's upload limit of ${cap.toLocaleString()} bytes.` });
      return;
    }
  }
  next();
}
