import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare module "express-serve-static-core" {
  interface Request {
    sessionId?: string;
  }
}

const COOKIE_NAME = "fr_session";

/**
 * Reads one cookie straight off the header rather than adding a
 * cookie-parser dependency for a single value. Anything that is not the
 * exact shape this middleware issues is ignored, so a hand-crafted cookie
 * cannot be used to claim a session id format the app never mints.
 */
function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return /^[0-9a-f]{32}$/.test(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Gives every browser an opaque session id, issued on its first request and
 * kept in an httpOnly cookie.
 *
 * This is **not** authentication -- there is no login here, and the id
 * proves nothing about who someone is. It exists so that a result belongs
 * to the browser that produced it: on a shared deployment, one person's
 * reconciliation should not be fetchable by another who happens to have the
 * run id. See api/routes/compare.ts, where downloads and job polling check
 * it, and config/env.ts (RUN_ISOLATION) for turning it off for API-only use.
 *
 * 128 bits from randomUUID, httpOnly so page scripts cannot read it,
 * SameSite=Lax so it still arrives on a download link the user clicks, and
 * Secure only when the request actually arrived over HTTPS (behind a TLS
 * terminator that means X-Forwarded-Proto, which `req.secure` honours via
 * Express's trust-proxy setting). It carries no expiry, so it lasts only as
 * long as the browser stays open.
 */
export function sessionCookie(req: Request, res: Response, next: NextFunction): void {
  const existing = readSessionCookie(req.headers.cookie);
  const id = existing ?? randomUUID().replace(/-/g, "");
  req.sessionId = id;
  if (!existing) {
    res.cookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      // Deliberately no maxAge/expires: a session cookie, discarded when the
      // browser closes. The next visit is a clean slate -- nothing from the
      // previous session is reachable, even by someone holding an old link.
      path: "/",
    });
  }
  next();
}

/** The session this request belongs to; "" before the middleware has run. */
export function currentSession(req: Request): string {
  return req.sessionId ?? "";
}
