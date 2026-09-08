import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

const FIXTURES = join(__dirname, "../../../fixtures");
const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

async function uploadSamples(a: Express) {
  const src = await request(a).post("/api/files/upload").attach("file", join(FIXTURES, "sample_source.csv"));
  const tgt = await request(a).post("/api/files/upload").attach("file", join(FIXTURES, "sample_target.csv"));
  return { sourceId: src.body.file_id as string, targetId: tgt.body.file_id as string };
}

const MAPPED_REQUEST = {
  column_map: {
    txn_id: "transaction_id",
    posting_date: "accounting_date",
    description: "description",
    amount: "amount_local",
    currency: "currency_code",
    gl_account: "gl_account",
  },
  drop_unmapped: true,
  key_columns: ["transaction_id"],
};

interface JobView {
  job_id: string;
  status: string;
  progress: { phase: string; label: string; done: number; total: number; percent: number | null } | null;
  result: { summary: { matched_equal: number }; run_id: string } | null;
  detail: string | null;
}

/** Polls until the job leaves the queued/running states, collecting every
 * progress snapshot it saw on the way. */
async function pollToCompletion(a: Express, jobId: string): Promise<{ final: JobView; seen: JobView[] }> {
  const seen: JobView[] = [];
  for (let i = 0; i < 200; i++) {
    const r = await request(a).get(`/api/compare/jobs/${jobId}`);
    expect(r.status).toBe(200);
    const view = r.body as JobView;
    seen.push(view);
    if (view.status !== "queued" && view.status !== "running") return { final: view, seen };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish in time");
}

describe("background comparison jobs", () => {
  it("accepts a job immediately instead of holding the connection open", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({ source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST });

    expect(started.status).toBe(202);
    expect(started.body.job_id).toMatch(/^[0-9a-f]{16}$/);
    expect(["queued", "running"]).toContain(started.body.status);
  });

  it("runs to completion and returns the same result the synchronous route does", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const body = { source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST };

    const sync = await request(app).post("/api/compare/run").send(body);
    expect(sync.status).toBe(200);

    const started = await request(app).post("/api/compare/jobs").send(body);
    const { final } = await pollToCompletion(app, started.body.job_id);

    expect(final.status).toBe("done");
    expect(final.detail).toBeNull();
    expect(final.result).not.toBeNull();
    // Same known-good reconciliation as the anchor test: 9 matched-equal,
    // 1 source-only (TXN-012), 2 target-only.
    expect(final.result!.summary).toEqual(sync.body.summary);
    expect(final.result!.run_id).not.toBe(sync.body.run_id);
  });

  it("reports progress with a phase, a label and a percentage", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({ source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST });

    const { final, seen } = await pollToCompletion(app, started.body.job_id);
    expect(final.status).toBe("done");

    const withProgress = seen.filter((v) => v.progress !== null);
    expect(withProgress.length).toBeGreaterThan(0);

    const last = withProgress[withProgress.length - 1].progress!;
    expect(typeof last.label).toBe("string");
    expect(last.label.length).toBeGreaterThan(0);
    expect(last.percent).toBe(100);

    // Percentages must never go backwards -- a progress bar that retreats
    // reads as a bug even when the run is fine.
    const percents = withProgress.map((v) => v.progress!.percent).filter((p): p is number => p !== null);
    const sorted = [...percents].sort((a, b) => a - b);
    expect(percents).toEqual(sorted);
  });

  it("makes the finished run's report downloadable", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({ source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST });
    const { final } = await pollToCompletion(app, started.body.job_id);

    const report = await request(app).get(`/api/compare/${final.result!.run_id}/report.xlsx`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("spreadsheetml");
  });

  it("rejects a bad request up front rather than failing inside the job", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const r = await request(app).post("/api/compare/jobs").send({
      source_file_id: sourceId,
      target_file_id: targetId,
      numeric_tolerance: "not-a-number",
    });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain("numeric_tolerance");
  });

  it("404s for an unknown job", async () => {
    const r = await request(app).get("/api/compare/jobs/deadbeefdeadbeef");
    expect(r.status).toBe(404);
    const c = await request(app).delete("/api/compare/jobs/deadbeefdeadbeef");
    expect(c.status).toBe(404);
  });

  it("reports a job that was cancelled", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({ source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST });

    // Cancel straight away: the fixtures are small, so this races the run
    // itself. Either outcome is legitimate -- what must hold is that the
    // job reaches a terminal state and a cancelled one carries no result.
    await request(app).delete(`/api/compare/jobs/${started.body.job_id}`);
    const { final } = await pollToCompletion(app, started.body.job_id);

    expect(["cancelled", "done"]).toContain(final.status);
    if (final.status === "cancelled") expect(final.result).toBeNull();
  });

  it("cancelling a job that already finished changes nothing", async () => {
    const { sourceId, targetId } = await uploadSamples(app);
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({ source_file_id: sourceId, target_file_id: targetId, ...MAPPED_REQUEST });
    const { final } = await pollToCompletion(app, started.body.job_id);
    expect(final.status).toBe("done");

    const cancel = await request(app).delete(`/api/compare/jobs/${started.body.job_id}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(false);
    expect(cancel.body.status).toBe("done");

    const after = await request(app).get(`/api/compare/jobs/${started.body.job_id}`);
    expect(after.body.status).toBe("done");
    expect(after.body.result).not.toBeNull();
  });
});
