import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createApp } from "../../src/app";
import { trustProxy } from "../../src/config/env";

/**
 * Regression guard for the proxy-trust defect: with no `trust proxy`
 * setting, Express reports the *proxy's* socket address as `req.ip` for
 * every request, so every unauthenticated client behind the nginx
 * container shared one rate-limit bucket (rateLimit.ts keys on req.ip when
 * there is no SSO header) and `ctx_client_ip` logged the proxy every time.
 */

/** Mounts the real app under a one-hop stand-in for nginx, so the request
 * arrives with an X-Forwarded-For exactly as nginx's
 * `$proxy_add_x_forwarded_for` would build it. */
function appBehindProxy() {
  const app = createApp();
  app.get("/api/__ip", (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe("trust proxy", () => {
  it("defaults to trusting exactly one hop", () => {
    delete process.env.TRUST_PROXY;
    expect(trustProxy()).toBe(1);
  });

  it("can be disabled for a directly-exposed deployment", () => {
    process.env.TRUST_PROXY = "false";
    expect(trustProxy()).toBe(false);
    delete process.env.TRUST_PROXY;
  });

  it("reads the client address nginx appended, not the proxy's own", async () => {
    const r = await request(appBehindProxy())
      .get("/api/__ip")
      .set("X-Forwarded-For", "203.0.113.9");
    expect(r.body.ip).toBe("203.0.113.9");
  });

  it("ignores a client-supplied hop beyond the one trusted proxy", async () => {
    // A client that sends its own X-Forwarded-For gets nginx's entry
    // appended to the right of it; trusting one hop must resolve to that
    // appended (real) address, not the spoofed leftmost one.
    const r = await request(appBehindProxy())
      .get("/api/__ip")
      .set("X-Forwarded-For", "1.2.3.4, 203.0.113.9");
    expect(r.body.ip).toBe("203.0.113.9");
  });

  it("distinguishes two clients arriving through the same proxy", async () => {
    const app = appBehindProxy();
    const a = await request(app).get("/api/__ip").set("X-Forwarded-For", "203.0.113.9");
    const b = await request(app).get("/api/__ip").set("X-Forwarded-For", "198.51.100.7");
    expect(a.body.ip).not.toBe(b.body.ip);
  });
});
