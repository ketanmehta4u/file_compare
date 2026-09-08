import { Router } from "express";
import { fileCache, catalogCache, runCache } from "../../cache/stores";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => res.json({ status: "ok" }));
healthRouter.get("/livez", (_req, res) => res.json({ status: "alive" }));
healthRouter.get("/readyz", (_req, res) => {
  res.json({
    status: "ready",
    checks: {
      blob_read_configured: false,
      blob_write_configured: false,
      cache_files: fileCache.size,
      cache_catalogs: catalogCache.size,
      cache_runs: runCache.size,
    },
  });
});
