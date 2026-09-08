import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { log } from "../../src/api/middleware/requestLog";

/** Captures the structured fields of every http.request log line emitted
 * while `fn` runs. */
async function captureLogs(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const original = log.info.bind(log);
  (log as unknown as { info: unknown }).info = (obj: Record<string, unknown>, msg?: string) => {
    if (msg === "http.request") lines.push(obj);
    return original(obj as never, msg as never);
  };
  try {
    await fn();
  } finally {
    (log as unknown as { info: unknown }).info = original;
  }
  return lines;
}

afterEach(() => {
  delete process.env.TRUST_PROXY;
});

describe("request logging", () => {
  // Regression: ctx_path was read inside the "finish" handler, by which
  // point Express had rewritten req.url relative to the mounted router --
  // so every API route logged with its /api prefix stripped.
  it("logs the full request path including the /api mount point", async () => {
    const app = createApp();
    const lines = await captureLogs(() => request(app).get("/api/livez"));
    expect(lines.length).toBe(1);
    expect(lines[0].ctx_path).toBe("/api/livez");
  });

  it("logs the path without its query string", async () => {
    const app = createApp();
    const lines = await captureLogs(() => request(app).get("/api/health?verbose=1"));
    expect(lines[0].ctx_path).toBe("/api/health");
  });

  it("logs the forwarded client address rather than the proxy's", async () => {
    const app = createApp();
    const lines = await captureLogs(() =>
      request(app).get("/api/livez").set("X-Forwarded-For", "203.0.113.9")
    );
    expect(lines[0].ctx_client_ip).toBe("203.0.113.9");
  });
});
