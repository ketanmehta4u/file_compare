import { createHash } from "node:crypto";

/** Port of comparison.py's `sha256_bytes` -- used to fingerprint inputs
 * in the audit header and as a cache key in the backend layer. */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
