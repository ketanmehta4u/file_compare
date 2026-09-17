import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { currentUser } from "./currentUser";
import {
  compareRateLimitMax,
  downloadRateLimitMax,
  rateLimitWindowMs,
  uploadRateLimitMax,
} from "../../config/env";

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
    windowMs: rateLimitWindowMs(),
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: { detail: "Rate limit exceeded. Please slow down and try again shortly." },
  });
}

// All three are per client and read once at startup; the window and the
// allowances come from the environment (see config/env.ts), because the
// right numbers depend on how many people share the instance and whether
// anything drives the API by script.

/** Uploads, catalogue upload, sheet listing. Default 30 a minute. */
export const uploadRateLimit = limiter(uploadRateLimitMax());
/** Starting a comparison, by either route. Default 10 a minute. */
export const compareRateLimit = limiter(compareRateLimitMax());
/** Downloading the audit workbook or an annotated file. Default 20 a minute. */
export const downloadRateLimit = limiter(downloadRateLimitMax());
