import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";

// Set before the app is imported: the limiters are built once, at module
// load, and an express-rate-limit instance cannot be resized afterwards.
process.env.COMPARE_RATE_LIMIT = "2";
process.env.UPLOAD_RATE_LIMIT = "3";
const { createApp } = await import("../../src/app");
const app = createApp();

afterAll(() => {
  delete process.env.COMPARE_RATE_LIMIT;
  delete process.env.UPLOAD_RATE_LIMIT;
});

const CSV = Buffer.from("id,amount\n1,2.00\n");

/** Fires `n` requests from one client and returns the statuses in order. */
async function burst(n: number, send: (ip: string) => Promise<number>, ip: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await send(ip));
  return out;
}

describe("rate limits follow the environment", () => {
  it("applies the configured comparison allowance, not the built-in default", async () => {
    const statuses = await burst(
      4,
      async (ip) =>
        (
          await request(app)
            .post("/api/compare/run")
            .set("X-Forwarded-For", ip)
            .send({ source_file_id: "missing", target_file_id: "missing" })
        ).status,
      "10.9.0.1"
    );

    // Two allowed (404: the file ids are not cached, which is the point --
    // the request was let through), then the limiter takes over.
    expect(statuses.slice(0, 2)).toEqual([404, 404]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it("applies the configured upload allowance", async () => {
    const statuses = await burst(
      4,
      async (ip) =>
        (await request(app).post("/api/files/upload").set("X-Forwarded-For", ip).attach("file", CSV, "a.csv"))
          .status,
      "10.9.0.2"
    );

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  // Limits are per client, so one busy user cannot lock everyone else out.
  it("keeps one client's limit from affecting another", async () => {
    await burst(
      3,
      async (ip) =>
        (
          await request(app)
            .post("/api/compare/run")
            .set("X-Forwarded-For", ip)
            .send({ source_file_id: "missing", target_file_id: "missing" })
        ).status,
      "10.9.0.3"
    );

    const other = await request(app)
      .post("/api/compare/run")
      .set("X-Forwarded-For", "10.9.0.4")
      .send({ source_file_id: "missing", target_file_id: "missing" });
    expect(other.status).toBe(404);
  });
});
