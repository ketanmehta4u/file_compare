import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../../src/app";

/**
 * Single-process mode: the backend can also serve the built Angular SPA,
 * so the app runs without Docker or a separate nginx.
 */

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "spa-dist-"));
  writeFileSync(join(dist, "index.html"), "<html><body><app-root></app-root></body></html>");
  writeFileSync(join(dist, "main.abc123.js"), "console.log('bundle');");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "logo.svg"), "<svg/>");
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SERVE_FRONTEND;
  delete process.env.FRONTEND_DIST;
});

/** createApp() decides whether to serve the SPA at construction time, so
 * the environment has to be set before the app is built. */
function appServingSpa() {
  process.env.SERVE_FRONTEND = "1";
  process.env.FRONTEND_DIST = dist;
  return createApp();
}

describe("serving the SPA from the API process", () => {
  it("is off by default -- the API alone serves no HTML", async () => {
    const r = await request(createApp()).get("/");
    expect(r.status).toBe(404);
  });

  it("serves the SPA shell at the root when enabled", async () => {
    const r = await request(appServingSpa()).get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<app-root>");
    expect(r.headers["content-type"]).toContain("text/html");
  });

  it("serves hashed bundles and assets", async () => {
    const app = appServingSpa();
    expect((await request(app).get("/main.abc123.js")).status).toBe(200);
    expect((await request(app).get("/assets/logo.svg")).status).toBe(200);
  });

  it("falls back to the shell for a client-side deep link", async () => {
    const r = await request(appServingSpa()).get("/some/client/route");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<app-root>");
  });

  // The fallback must never swallow the API: an unknown /api path has to
  // stay a 404, not hand an API client the HTML shell with a 200.
  it("never shadows the API", async () => {
    const app = appServingSpa();
    const live = await request(app).get("/api/livez");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: "alive" });

    const missing = await request(app).get("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain("<app-root>");
  });

  // The API-wide CSP is `default-src 'none'`, which is right for JSON and
  // fatal for an HTML app -- it would block the SPA's own bundles.
  it("swaps the API's CSP for one the SPA can actually run under", async () => {
    const app = appServingSpa();

    const page = await request(app).get("/");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).not.toContain("default-src 'none'");

    const api = await request(app).get("/api/livez");
    expect(api.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("keeps the other security headers on the shell", async () => {
    const r = await request(appServingSpa()).get("/");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("tells the browser not to cache the shell", async () => {
    const r = await request(appServingSpa()).get("/");
    expect(r.headers["cache-control"]).toContain("no-store");
  });

  it("starts anyway, serving the API only, when no build is present", async () => {
    process.env.SERVE_FRONTEND = "1";
    process.env.FRONTEND_DIST = join(dist, "does-not-exist");
    const app = createApp();
    expect((await request(app).get("/api/livez")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(404);
  });
});
