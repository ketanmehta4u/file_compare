import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { frontendDist } from "../config/env";
import { log } from "./middleware/requestLog";

/**
 * Optional single-process mode: serve the built Angular SPA from this same
 * Express process, so the app can run without Docker (and without a
 * separate nginx) as one `node dist/server.js`.
 *
 * Off by default -- the shipped topology puts nginx in front, and there
 * static serving belongs to nginx, not here. Enable with SERVE_FRONTEND=1
 * or the --serve-frontend flag.
 */

/** The CSP the SPA needs. The API-wide default (`default-src 'none'`, set
 * in middleware/securityHeaders.ts) is right for JSON but would block the
 * app's own bundles and stylesheet, so non-/api responses get the same
 * policy nginx.conf serves instead. Angular 14 injects component styles as
 * inline <style> tags, hence 'unsafe-inline' for styles only -- scripts
 * stay strictly 'self'. */
const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Mounts static serving + SPA fallback, if enabled and a build is present.
 * Returns the directory being served, or null when serving is off or no
 * build was found. Call after the API routes are mounted so nothing here
 * can shadow /api.
 */
export function serveFrontend(app: Express): string | null {
  const dist = resolve(frontendDist());
  const indexHtml = join(dist, "index.html");

  if (!existsSync(indexHtml)) {
    log.warn(
      { ctx_dist: dist },
      "frontend.serve_skipped -- no index.html there; run `npm run build` in frontend/, or set FRONTEND_DIST"
    );
    return null;
  }

  // Replace the API's restrictive CSP for everything that is not the API.
  // securityHeaders only fills in headers that are absent, so this must
  // overwrite rather than defer.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isApiPath(req.path)) res.setHeader("Content-Security-Policy", SPA_CSP);
    next();
  });

  app.use(
    express.static(dist, {
      // index.html is served by the fallback below, so it goes through one
      // code path (and one set of cache headers) whether the request was
      // for "/" or a deep link.
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        }
      },
    })
  );

  // SPA fallback. A GET for anything that is not an API route and did not
  // match a real file is a client-side route -- hand back the shell and let
  // Angular resolve it. Written as a middleware rather than a wildcard
  // route because Express 5's path parser no longer accepts "*" here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isApiPath(req.path)) return next();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });

  log.info({ ctx_dist: dist }, "frontend.serving");
  return dist;
}
