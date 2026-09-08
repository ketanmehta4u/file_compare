import v8 from "node:v8";
import { Router } from "express";
import { fileCache, catalogCache, runCache } from "../../cache/stores";
import { cacheBudgetBytes } from "../../config/env";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => res.json({ status: "ok" }));
healthRouter.get("/livez", (_req, res) => res.json({ status: "alive" }));

const MB = 1024 * 1024;

/**
 * Readiness plus the numbers an operator actually needs when this is
 * running on someone else's machine: how much heap V8 has granted itself
 * (it adapts to a container's memory limit), how much is in use, and how
 * much of the upload budget is spoken for. RSS is deliberately not the
 * headline -- V8 does not hand freed heap back to the OS, so RSS overstates
 * what is actually held.
 */
healthRouter.get("/readyz", (_req, res) => {
  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const budget = cacheBudgetBytes();
  res.json({
    status: "ready",
    checks: {
      blob_read_configured: false,
      blob_write_configured: false,
      cache_files: fileCache.size,
      cache_catalogs: catalogCache.size,
      cache_runs: runCache.size,
    },
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / MB),
      heap_limit_mb: Math.round(heapLimit / MB),
      rss_mb: Math.round(mem.rss / MB),
      upload_cache_mb: Math.round((fileCache.calculatedSize ?? 0) / MB),
      upload_cache_budget_mb: Math.round(budget / MB),
    },
  });
});
