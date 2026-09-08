import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { currentUser } from "./currentUser";

/** Port of the original's `_rate_limit_key`: keyed by the authenticated
 * SSO user when present, else client IP. IPv6 addresses must go through
 * ipKeyGenerator's normalisation (not used as the raw string) -- without
 * it, two different textual representations of the same IPv6 address
 * would count as different rate-limit buckets, letting a client bypass
 * the limit just by varying how it writes its own address. */
function keyGenerator(req: Request): string {
  const user = currentUser(req);
  if (user) return user;
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
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
