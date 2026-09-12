import path from "node:path";
import v8 from "node:v8";

const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const MULTIPART_SLACK_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_COMPARISONS = 3;
const DEFAULT_COMPARE_QUEUE_TIMEOUT_S = 120;
const DEFAULT_MAX_RESPONSE_ROWS = 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Memory the upload cache may hold, in bytes.
 *
 * Derived from V8's heap ceiling rather than a fixed number, because that
 * ceiling is what actually differs between machines: measured, the same
 * build gets ~2.1 GB of heap on a developer laptop and ~259 MB inside a
 * 512 MB container, and V8 adjusts itself to a cgroup limit without being
 * told. `os.totalmem()` is deliberately NOT used -- inside that same
 * container it reports the *host's* 3.8 GB and would size this cache
 * roughly seven times too large.
 *
 * A quarter of the heap is a deliberately conservative share: the cache
 * holds raw bytes, but a comparison then parses two of those files into
 * tables costing roughly 12x their bytes each, and that working set needs
 * the rest of the heap.
 */
export function cacheBudgetBytes(): number {
  const explicit = process.env.MAX_CACHE_BYTES;
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.floor(v8.getHeapStatistics().heap_size_limit * 0.25);
}

/** Effective per-file upload cap./** Effective per-file upload cap. Read on each call so a bad value can be
 * corrected without a restart, matching the original's `_max_upload_bytes`. */
export function maxUploadBytes(): number {
  const explicit = process.env.MAX_UPLOAD_BYTES;
  if (explicit) return envInt("MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
  // Unset, the cap follows the machine instead of promising 200 MB that a
  // small container could never parse: half the cache budget, so a source
  // and a target of that size both fit. On a laptop this still lands at
  // the 200 MB ceiling; in a 512 MB container it lands near 32 MB, which
  // is much closer to what that heap can actually process.
  return Math.min(DEFAULT_MAX_UPLOAD_BYTES, Math.floor(cacheBudgetBytes() / 2));
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

/**
 * How many rows of each detail section (source-only, target-only, cell
 * differences) the JSON response carries.
 *
 * The full result stays on the server and every download returns all of
 * it -- this caps only what is shipped to the browser to draw a table.
 * Uncapped, a reconciliation with hundreds of thousands of breaks
 * serialised into a ~28 MB response (measured) that the UI then rendered
 * 100 rows of, and a large enough run would fail outright: V8 refuses to
 * build a single string over 512 MB, so JSON.stringify would throw rather
 * than return a result the user could still have downloaded.
 */
export function maxResponseRows(): number {
  return envInt("MAX_RESPONSE_ROWS", DEFAULT_MAX_RESPONSE_ROWS);
}

export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? "http://localhost:4200";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

/**
 * Whether this process should also serve the built Angular SPA (see
 * api/serveFrontend.ts). Off by default: in the shipped Docker topology
 * nginx serves the static files and this process is the API only. Turned
 * on for a no-Docker, single-process deployment -- by env var or by the
 * --serve-frontend argv flag, since setting an env var inline differs
 * between cmd, PowerShell and POSIX shells.
 */
export function serveFrontendEnabled(): boolean {
  const raw = (process.env.SERVE_FRONTEND ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return process.argv.includes("--serve-frontend");
}

/** Directory holding the built SPA. The default is this repo's own layout
 * (backend/dist/... -> ../../frontend/dist/frontend), so a checkout that
 * has run `npm run build` in frontend/ needs no configuration. */
export function frontendDist(): string {
  const raw = (process.env.FRONTEND_DIST ?? "").trim();
  if (raw !== "") return raw;
  return path.resolve(__dirname, "..", "..", "..", "frontend", "dist", "frontend");
}

export function port(): number {
  return envInt("PORT", 3000);
}
