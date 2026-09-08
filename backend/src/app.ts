import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { corsOrigins } from "./config/env";
import { bodySizeGuard } from "./api/middleware/bodySizeGuard";
import { securityHeaders } from "./api/middleware/securityHeaders";
import { requestLog, log } from "./api/middleware/requestLog";
import { healthRouter } from "./api/routes/health";
import { authRouter } from "./api/routes/auth";
import { configRouter } from "./api/routes/config";
import { catalogRouter } from "./api/routes/catalog";
import { filesRouter } from "./api/routes/files";
import { compareRouter } from "./api/routes/compare";

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: corsOrigins(),
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Accept", "X-Request-Id"],
      exposedHeaders: ["Content-Disposition"],
    })
  );

  // Middleware order matches the original: body-size guard first (can
  // short-circuit before the body streams), then security headers, then
  // request logging (wraps whatever status the route ultimately sets).
  app.use(bodySizeGuard);
  app.use(securityHeaders);
  app.use(requestLog);

  app.use(express.json());

  app.use("/api", healthRouter);
  app.use("/api", authRouter);
  app.use("/api", configRouter);
  app.use("/api", catalogRouter);
  app.use("/api", filesRouter);
  app.use("/api", compareRouter);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error({ ctx_request_id: req.requestId, err: err instanceof Error ? err.message : String(err) }, "http.exception");
    if (res.headersSent) return;
    res.status(500).json({ detail: "Internal server error." });
  });

  return app;
}
