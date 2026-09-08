import type { NextFunction, Request, Response } from "express";

/** Port of the original's `security_headers` middleware -- the exact same
 * 7 headers, set only if not already present (defence-in-depth alongside
 * whatever a fronting reverse proxy also sets). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const set = (name: string, value: string) => {
    if (!res.getHeader(name)) res.setHeader(name, value);
  };
  set("X-Content-Type-Options", "nosniff");
  set("X-Frame-Options", "DENY");
  set("Referrer-Policy", "strict-origin-when-cross-origin");
  set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}
