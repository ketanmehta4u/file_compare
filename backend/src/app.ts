import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { corsOrigins, serveFrontendEnabled, trustProxy } from "./config/env";
import { bodySizeGuard } from "./api/middleware/bodySizeGuard";
import { securityHeaders } from "./api/middleware/securityHeaders";
import { requestLog, log } from "./api/middleware/requestLog";
import { healthRouter } from "./api/routes/health";
import { authRouter } from "./api/routes/auth";
import { configRouter } from "./api/routes/config";
import { catalogRouter } from "./api/routes/catalog";
import { filesRouter } from "./api/routes/files";
import { compareRouter } from "./api/routes/compare";
import { serveFrontend } from "./api/serveFrontend";

export function createApp(): Express {
  const app = express();

  // Behind the nginx container, `req.ip` is the proxy's address unless
  // Express is told how many proxy hops to trust -- which would put every
  // unauthenticated client in a single shared rate-limit bucket. See
  // trustProxy() for why the default is one hop, and how to turn it off.
  app.set("trust proxy", trustProxy());

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

  // 1 MB rather than express's 100 KB default: a compare request is small,
  // but a wide file's column_map is a name-pair per column and can run to
  // tens of kilobytes, and the default's failure mode is an opaque 413.
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", healthRouter);
  app.use("/api", authRouter);
  app.use("/api", configRouter);
  app.use("/api", catalogRouter);
  app.use("/api", filesRouter);
  app.use("/api", compareRouter);

  // Optional single-process mode: also serve the built SPA from here, for
  // running without Docker/nginx. Mounted after the API so it can never
  // shadow /api; a no-op unless enabled.
  if (serveFrontendEnabled()) serveFrontend(app);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error({ ctx_request_id: req.requestId, err: err instanceof Error ? err.message : String(err) }, "http.exception");
    if (res.headersSent) return;
    res.status(500).json({ detail: "Internal server error." });
  });

  return app;
}
