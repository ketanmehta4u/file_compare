import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { currentUser } from "./currentUser";

/** Port of the original's `_rate_limit_key`: keyed by the authenticated
 * SSO user when present, else client IP. */
function keyGenerator(req: Request): string {
  return currentUser(req) || req.ip || "unknown";
}

function limiter(max: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: { detail: "Rate limit exceeded. Please slow down and try again shortly." },
  });
}

/** Uploads, catalogue upload, sheet listing, blob read -- 30/minute. */
export const uploadRateLimit = limiter(30);
/** Run a comparison, write outputs to blob -- 10/minute. */
export const compareRateLimit = limiter(10);
/** Download the audit workbook / annotated files -- 20/minute. */
export const downloadRateLimit = limiter(20);
