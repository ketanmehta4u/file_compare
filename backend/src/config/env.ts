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

export function port(): number {
  return envInt("PORT", 3000);
}
