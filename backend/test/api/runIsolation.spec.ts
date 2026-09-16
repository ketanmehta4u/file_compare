import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

afterEach(() => {
  delete process.env.RUN_ISOLATION;
});

const SOURCE = Buffer.from(["id,amount", "1,10.00", "2,20.00", "3,30.00", ""].join("\n"));
const TARGET = Buffer.from(["id,amount", "1,10.00", "2,22.50", "4,40.00", ""].join("\n"));

/** A separate "browser": a supertest agent keeps its cookies between calls,
 * exactly as a browser would, so two agents are two different people. */
function browser() {
  return request.agent(app);
}

type Browser = ReturnType<typeof browser>;

async function compareAs(who: Browser): Promise<string> {
  const src = await who.post("/api/files/upload").attach("file", SOURCE, "source.csv");
  const tgt = await who.post("/api/files/upload").attach("file", TARGET, "target.csv");
  const run = await who.post("/api/compare/run").send({
    source_file_id: src.body.file_id,
    target_file_id: tgt.body.file_id,
    key_columns: ["id"],
  });
  expect(run.status).toBe(200);
  return run.body.run_id as string;
}

async function startJobAs(who: Browser): Promise<string> {
  const src = await who.post("/api/files/upload").attach("file", SOURCE, "source.csv");
  const tgt = await who.post("/api/files/upload").attach("file", TARGET, "target.csv");
  const started = await who.post("/api/compare/jobs").send({
    source_file_id: src.body.file_id,
    target_file_id: tgt.body.file_id,
    key_columns: ["id"],
  });
  expect(started.status).toBe(202);
  return started.body.job_id as string;
}

describe("the session cookie", () => {
  it("is issued on the first request and then reused, not reissued", async () => {
    const me = browser();

    const first = await me.get("/api/config");
    const setCookie = first.headers["set-cookie"] as unknown as string[] | undefined;
    expect(setCookie?.join(";")).toContain("fr_session=");
    // httpOnly so page scripts cannot read it; Lax so it still travels on a
    // download link the user clicks.
    expect(setCookie?.join(";")).toContain("HttpOnly");
    expect(setCookie?.join(";")).toContain("SameSite=Lax");
    // No Max-Age and no Expires: it ends with the browser, so a later visit
    // starts clean and cannot reach anything from this one.
    expect(setCookie?.join(";")).not.toContain("Max-Age");
    expect(setCookie?.join(";")).not.toContain("Expires");

    const second = await me.get("/api/config");
    expect(second.headers["set-cookie"]).toBeUndefined();
  });
});

// The deployment is shared and anonymous, so a run id is the only thing
// between one person's reconciliation and everybody else. It is bound to the
// browser that produced it.
describe("a run belongs to the browser that made it", () => {
  it("lets that browser download the workbook and the annotated file", async () => {
    const me = browser();
    const runId = await compareAs(me);

    const report = await me.get(`/api/compare/${runId}/report.xlsx`);
    expect(report.status).toBe(200);
    const annotated = await me.get(`/api/compare/${runId}/annotated/source`);
    expect(annotated.status).toBe(200);
  });

  it("answers another browser with 404, revealing nothing about the run", async () => {
    const me = browser();
    const someoneElse = browser();
    const runId = await compareAs(me);

    const report = await someoneElse.get(`/api/compare/${runId}/report.xlsx`);
    expect(report.status).toBe(404);
    // Same wording as a genuinely unknown id: "forbidden" would confirm the
    // run exists.
    expect(report.body.detail).toContain("Run not found");

    const annotated = await someoneElse.get(`/api/compare/${runId}/annotated/source`);
    expect(annotated.status).toBe(404);

    // And the owner is unaffected by the other browser's attempt.
    expect((await me.get(`/api/compare/${runId}/report.xlsx`)).status).toBe(200);
  });

  it("keeps job progress and cancellation to the browser that started the job", async () => {
    const me = browser();
    const someoneElse = browser();
    const jobId = await startJobAs(me);

    expect((await someoneElse.get(`/api/compare/jobs/${jobId}`)).status).toBe(404);
    const theirCancel = await someoneElse.delete(`/api/compare/jobs/${jobId}`);
    expect(theirCancel.status).toBe(404);

    // Their failed cancel must not have stopped my job.
    const mine = await me.get(`/api/compare/jobs/${jobId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.status).not.toBe("cancelled");
  });

  it("still 404s an id that never existed", async () => {
    const me = browser();
    expect((await me.get("/api/compare/deadbeefdeadbeef/report.xlsx")).status).toBe(404);
    expect((await me.get("/api/compare/jobs/deadbeefdeadbeef")).status).toBe(404);
  });
});

// A script driving the HTTP API keeps no cookie jar, so isolation can be
// turned off for that deployment rather than forcing one on it.
describe("RUN_ISOLATION=off", () => {
  it("returns to the shared behaviour: any caller with the id may download", async () => {
    const me = browser();
    const someoneElse = browser();
    const runId = await compareAs(me);

    expect((await someoneElse.get(`/api/compare/${runId}/report.xlsx`)).status).toBe(404);

    process.env.RUN_ISOLATION = "off";
    expect((await someoneElse.get(`/api/compare/${runId}/report.xlsx`)).status).toBe(200);
  });
});
