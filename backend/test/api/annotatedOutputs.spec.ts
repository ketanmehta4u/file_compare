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

const SOURCE = Buffer.from(["id,amount", "1,10.00", "2,20.00", "3,30.00", ""].join("\n"));
const TARGET = Buffer.from(["id,amount", "1,10.00", "2,22.50", "4,40.00", ""].join("\n"));

async function compare(annotatedOutputs?: boolean) {
  const src = await request(app).post("/api/files/upload").attach("file", SOURCE, "source.csv");
  const tgt = await request(app).post("/api/files/upload").attach("file", TARGET, "target.csv");
  const body: Record<string, unknown> = {
    source_file_id: src.body.file_id,
    target_file_id: tgt.body.file_id,
    key_columns: ["id"],
  };
  if (annotatedOutputs !== undefined) body.annotated_outputs = annotatedOutputs;
  const run = await request(app).post("/api/compare/run").send(body);
  expect(run.status).toBe(200);
  return run.body;
}

describe("optional annotated outputs", () => {
  it("produces them by default, so an existing caller sees no change", async () => {
    const body = await compare();
    expect(body.annotated_outputs).toBe(true);

    for (const side of ["source", "target"]) {
      const r = await request(app).get(`/api/compare/${body.run_id}/annotated/${side}`);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("spreadsheetml");
    }
  });

  it("says in the result when they were not produced", async () => {
    const body = await compare(false);
    expect(body.annotated_outputs).toBe(false);
    // The comparison itself is unaffected.
    expect(body.summary.matched_equal).toBe(1);
    expect(body.summary.matched_with_differences).toBe(1);
  });

  // The flag is a property of the run, not of whoever asks later: a link
  // kept from an earlier session must not produce a file whose every row
  // is marked unmatched because the statuses were dropped.
  it("refuses the annotated download when the run did not produce it", async () => {
    const body = await compare(false);

    for (const side of ["source", "target"]) {
      const r = await request(app).get(`/api/compare/${body.run_id}/annotated/${side}`);
      expect(r.status).toBe(400);
      expect(r.body.detail).toContain("Annotated files were not produced");
    }
  });

  it("still produces the audit workbook, which never depended on them", async () => {
    const body = await compare(false);
    const report = await request(app).get(`/api/compare/${body.run_id}/report.xlsx`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("spreadsheetml");
  });

  it("drops the per-row statuses that only the annotated export reads", async () => {
    const off = await compare(false);
    const on = await compare(true);

    expect(runCache.get(off.run_id)!.report.sourceRowStatus.size).toBe(0);
    expect(runCache.get(off.run_id)!.report.targetRowStatus.size).toBe(0);
    // With the option on they are populated -- one entry per distinct key.
    expect(runCache.get(on.run_id)!.report.sourceRowStatus.size).toBeGreaterThan(0);
  });

  it("works the same through the job route", async () => {
    const src = await request(app).post("/api/files/upload").attach("file", SOURCE, "source.csv");
    const tgt = await request(app).post("/api/files/upload").attach("file", TARGET, "target.csv");
    const started = await request(app)
      .post("/api/compare/jobs")
      .send({
        source_file_id: src.body.file_id,
        target_file_id: tgt.body.file_id,
        key_columns: ["id"],
        annotated_outputs: false,
      });
    expect(started.status).toBe(202);

    let view: { status: string; result: { annotated_outputs: boolean; run_id: string } | null } | undefined;
    for (let i = 0; i < 200; i++) {
      const r = await request(app).get(`/api/compare/jobs/${started.body.job_id}`);
      view = r.body;
      if (view!.status !== "queued" && view!.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(view!.status).toBe("done");
    expect(view!.result!.annotated_outputs).toBe(false);
    const r = await request(app).get(`/api/compare/${view!.result!.run_id}/annotated/source`);
    expect(r.status).toBe(400);
  });
});
