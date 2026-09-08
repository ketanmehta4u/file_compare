import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

describe("health/livez/readyz", () => {
  it("health returns ok", async () => {
    const r = await request(app).get("/api/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
  });

  it("livez returns alive", async () => {
    const r = await request(app).get("/api/livez");
    expect(r.body).toEqual({ status: "alive" });
  });

  it("readyz reports cache sizes and disabled blob flags", async () => {
    const r = await request(app).get("/api/readyz");
    expect(r.body.status).toBe("ready");
    expect(r.body.checks.blob_read_configured).toBe(false);
    expect(r.body.checks.blob_write_configured).toBe(false);
  });
});

describe("auth/me", () => {
  it("returns empty user when unauthenticated", async () => {
    const r = await request(app).get("/api/auth/me");
    expect(r.body.user).toBe("");
  });

  it("recognises an SSO header", async () => {
    const r = await request(app).get("/api/auth/me").set("x-forwarded-user", "alice@example.com");
    expect(r.body.user).toBe("alice@example.com");
  });
});

describe("config", () => {
  it("reports capability flags and the effective upload cap", async () => {
    const r = await request(app).get("/api/config");
    expect(r.body.blob_read_enabled).toBe(false);
    expect(r.body.excel_max_rows).toBe(1_048_576);
    expect(typeof r.body.max_upload_bytes).toBe("number");
  });
});

describe("security headers", () => {
  it("are present on every response", async () => {
    const r = await request(app).get("/api/health");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["strict-transport-security"]).toBeDefined();
  });
});

describe("blob endpoints are disabled stubs", () => {
  it("from-blob returns 400", async () => {
    const r = await request(app).post("/api/files/from-blob").send({ url: "https://example.com/x.csv" });
    expect(r.status).toBe(400);
  });

  it("write-to-blob returns 400", async () => {
    const r = await request(app).post("/api/compare/some-run/write-to-blob");
    expect(r.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("compare/run eventually returns 429 past its allowance", async () => {
    let lastStatus = 200;
    for (let i = 0; i < 15; i++) {
      const r = await request(app)
        .post("/api/compare/run")
        .send({ source_file_id: "missing", target_file_id: "missing" });
      lastStatus = r.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
