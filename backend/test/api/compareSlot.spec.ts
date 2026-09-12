import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// MAX_CONCURRENT_COMPARISONS and COMPARE_QUEUE_TIMEOUT_S are read once at
// module load, so they must be set before compareSlot is imported.
process.env.MAX_CONCURRENT_COMPARISONS = "2";
process.env.COMPARE_QUEUE_TIMEOUT_S = "0.3";

describe("compareSlot concurrency gate", () => {
  let app: express.Express;

  let handlerStarts: number[];

  beforeEach(async () => {
    vi.resetModules();
    const { compareSlot } = await import("../../src/api/middleware/compareSlot");
    handlerStarts = [];
    app = express();
    app.get("/slow", compareSlot, async (_req, res) => {
      handlerStarts.push(performance.now());
      await new Promise((r) => setTimeout(r, 150));
      res.json({ ok: true });
    });
  });

  it("allows up to the configured number of concurrent requests through immediately", async () => {
    // Deterministic rather than wall-clock-based (a total-elapsed-time
    // assertion is flaky under full-suite CPU contention): both handlers
    // must actually START within a tight window of each other -- if the
    // gate were serializing them, the second start would trail the first
    // by roughly the 150ms handler duration, not a few milliseconds.
    const results = await Promise.all([request(app).get("/slow"), request(app).get("/slow")]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(handlerStarts).toHaveLength(2);
    expect(Math.abs(handlerStarts[1] - handlerStarts[0])).toBeLessThan(100);
  });

  it("queues a request beyond the cap and lets it through once a slot frees", async () => {
    const results = await Promise.all([
      request(app).get("/slow"),
      request(app).get("/slow"),
      request(app).get("/slow"), // 3rd request queues behind the 2-slot cap
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("returns 503 with Retry-After when the queue doesn't clear in time", async () => {
    // Occupy both slots with requests that outlast the 0.3s queue timeout.
    const appLong = express();
    appLong.get(
      "/slow",
      (await import("../../src/api/middleware/compareSlot")).compareSlot,
      async (_req, res) => {
        await new Promise((r) => setTimeout(r, 500));
        res.json({ ok: true });
      }
    );

    // supertest's Test objects (superagent Requests) don't actually send
    // the HTTP request until awaited/.then()'d -- merely constructing them
    // via request(app).get(...) leaves them dormant. Attach .catch() (which
    // internally calls .then()) to kick off execution immediately without
    // blocking on the result yet, otherwise these "holders" never occupy a
    // slot before the "rejected" request below fires and finds both free.
    const holders = [request(appLong).get("/slow"), request(appLong).get("/slow")];
    holders.forEach((h) => void h.catch(() => {}));
    // Give the holders a moment to actually acquire their slots first.
    await new Promise((r) => setTimeout(r, 20));
    const rejected = await request(appLong).get("/slow");
    expect(rejected.status).toBe(503);
    expect(rejected.headers["retry-after"]).toBe("60");
    expect(rejected.body.detail).toContain("busy");

    await Promise.all(holders); // let the long-running holders finish before the test ends
  });
});
