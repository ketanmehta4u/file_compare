import multer from "multer";
import { maxUploadBytes } from "../config/env";

/**
 * In-memory multipart handling, matching the original's fully-in-memory
 * upload model (no temp files on disk).
 *
 * Scope note vs. the original: the Python backend re-reads
 * `MAX_UPLOAD_BYTES` on every request (`_max_upload_bytes()` is a plain
 * function call, no caching) via a hand-rolled chunked read with a
 * running-total abort. Multer's `limits.fileSize` is captured once when
 * this middleware is constructed, which happens at module load (route
 * registration) time here -- so, like `MAX_CONCURRENT_COMPARISONS`
 * elsewhere in this port, a `MAX_UPLOAD_BYTES` change needs a process
 * restart to take effect, not just an env var edit. Reimplementing a
 * chunked streaming size-check to match the original's live-reload
 * behaviour exactly wasn't judged worth the added complexity here.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes() } });

export function uploadSingle(fieldName: string) {
  return upload.single(fieldName);
}
