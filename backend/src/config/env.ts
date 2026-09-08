const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const MULTIPART_SLACK_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_COMPARISONS = 3;
const DEFAULT_COMPARE_QUEUE_TIMEOUT_S = 120;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Effective per-file upload cap. Read on each call so a bad value can be
 * corrected without a restart, matching the original's `_max_upload_bytes`. */
export function maxUploadBytes(): number {
  return envInt("MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

export function multipartSlackBytes(): number {
  return MULTIPART_SLACK_BYTES;
}

/** Read once at startup -- the concurrency semaphore this backs cannot be
 * resized after construction, same constraint as the original. */
export function maxConcurrentComparisons(): number {
  return envInt("MAX_CONCURRENT_COMPARISONS", DEFAULT_MAX_CONCURRENT_COMPARISONS);
}

export function compareQueueTimeoutMs(): number {
  return envInt("COMPARE_QUEUE_TIMEOUT_S", DEFAULT_COMPARE_QUEUE_TIMEOUT_S) * 1000;
}

export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? "http://localhost:4200";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function logLevel(): string {
  return process.env.LOG_LEVEL ?? "info";
}

export function logFormat(): "json" | "text" {
  return process.env.LOG_FORMAT === "text" ? "text" : "json";
}

/**
 * Express `trust proxy` setting. The shipped topology always puts nginx in
 * front of this backend (see docker-compose.yml), and without this Express
 * reports every request's `req.ip` as the *nginx container's* address --
 * which silently collapses the per-client rate limiters in
 * api/middleware/rateLimit.ts into one shared bucket for all
 * unauthenticated users, and makes the `ctx_client_ip` log field useless.
 *
 * Default 1 = trust exactly one proxy hop, so `req.ip` becomes the address
 * nginx appended to X-Forwarded-For (the real client). Only the hop count
 * is trusted, so a client cannot widen this by sending its own
 * X-Forwarded-For -- nginx's appended entry is still the rightmost.
 *
 * Set TRUST_PROXY=false when running this backend directly exposed with no
 * reverse proxy, where an attacker-supplied X-Forwarded-For would otherwise
 * be believed. A number sets a different hop count; anything else is passed
 * through to Express verbatim (e.g. "loopback", or a subnet list).
 */
export function trustProxy(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY ?? "").trim();
  if (raw === "") return 1;
  if (raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return raw;
}

export function port(): number {
  return envInt("PORT", 3000);
}
