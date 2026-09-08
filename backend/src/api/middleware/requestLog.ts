import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";
import { logFormat, logLevel } from "../../config/env";
import { currentUser } from "./currentUser";

export const log = pino({
  level: logLevel(),
  transport: logFormat() === "text" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

/** Port of the original's `log_requests` middleware: a short correlation
 * id per request, structured JSON log line on completion with the same
 * `ctx_*` field naming for continuity with any existing log tooling. */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID().replace(/-/g, "").slice(0, 12);
  req.requestId = requestId;
  const start = performance.now();
  // Captured now, not in the finish handler: Express rewrites req.url to be
  // relative while dispatching into a mounted router, and "finish" can fire
  // while still inside that dispatch -- which logged the API's own routes
  // with their /api mount point stripped ("/compare/run", "/livez").
  const path = req.originalUrl.split("?")[0];

  res.on("finish", () => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const fields = {
      ctx_request_id: requestId,
      ctx_method: req.method,
      ctx_path: path,
      ctx_status: res.statusCode,
      ctx_duration_ms: durationMs,
      ctx_user: currentUser(req),
      ctx_client_ip: req.ip ?? "",
    };
    if (res.statusCode >= 500) log.error(fields, "http.request");
    else if (res.statusCode >= 400) log.warn(fields, "http.request");
    else log.info(fields, "http.request");
  });

  next();
}
