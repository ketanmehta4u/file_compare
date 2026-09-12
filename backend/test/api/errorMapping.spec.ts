import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";
import * as loadBytesModule from "../../src/engine/fileLoad/loadBytes";
import { log } from "../../src/api/middleware/requestLog";

const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every route used to answer any thrown Error with 400 and its message.
 * That made a bad upload and a bug indistinguishable to a caller, and put
 * internal messages -- including stack-shaped detail -- into responses.
 */
describe("error mapping", () => {
  it("answers a bad upload with 400 and the reason", async () => {
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    const r = await request(app).post("/api/files/upload").attach("file", ole2, "legacy.xls");

    expect(r.status).toBe(400);
    expect(r.body.detail).toContain("legacy .xls");
  });

  it("answers an empty file with 400", async () => {
    const r = await request(app).post("/api/files/upload").attach("file", Buffer.from(""), "empty.csv");
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain("empty");
  });

  it("answers an unknown file id with 404, not 400", async () => {
    const r = await request(app)
      .post("/api/compare/run")
      .send({ source_file_id: "deadbeefdeadbeef", target_file_id: "deadbeefdeadbeef" });
    expect(r.status).toBe(404);
    expect(r.body.detail).toContain("not in cache");
  });

  it("answers a bad option with 400 and names it", async () => {
    const csv = Buffer.from("id,amount\n1,2.00\n");
    const src = await request(app).post("/api/files/upload").attach("file", csv, "a.csv");
    const r = await request(app).post("/api/compare/run").send({
      source_file_id: src.body.file_id,
      target_file_id: src.body.file_id,
      numeric_tolerance: "nonsense",
    });
    expect(r.status).toBe(400);
    expect(r.body.detail).toContain("numeric_tolerance");
  });

  // The point of the change: an internal fault must not masquerade as the
  // caller's mistake, and its message must not reach the response.
  it("answers an internal fault with 500 and a generic message", async () => {
    // Two error lines are expected for a 500: this one, and requestLog's
    // own line for the response status. Only the first is under test.
    const errors: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    vi.spyOn(log, "error").mockImplementation(((obj: Record<string, unknown>, msg?: string) => {
      errors.push({ obj, msg });
      return undefined;
    }) as never);

    vi.spyOn(loadBytesModule, "loadBytes").mockRejectedValue(
      new Error("ENOENT: something internal leaked out")
    );

    const r = await request(app)
      .post("/api/files/upload")
      .attach("file", Buffer.from("id\n1\n"), "a.csv");

    expect(r.status).toBe(500);
    expect(r.body.detail).toBe("Internal server error.");
    expect(JSON.stringify(r.body)).not.toContain("ENOENT");

    // Still traceable: logged against the request id rather than swallowed.
    const unhandled = errors.filter((e) => e.msg === "http.unhandled");
    expect(unhandled.length).toBe(1);
    expect(String(unhandled[0].obj.err)).toContain("ENOENT");
    expect(unhandled[0].obj.ctx_request_id).toBeDefined();
  });

  it("keeps an input error raised inside the worker a 400, not a 500", async () => {
    // An .xls only fails once the worker parses it, so this exercises the
    // error crossing the thread boundary -- where the class is lost and
    // only a flag carries the distinction.
    const csv = Buffer.from("id,amount\n1,2.00\n");
    const good = await request(app).post("/api/files/upload").attach("file", csv, "a.csv");

    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    fileCache.set("forcedxls", {
      bytes: ole2,
      meta: { ...fileCache.get(good.body.file_id)!.meta, name: "legacy.xls" },
      load: { hasHeader: true, delimiter: null },
      cachedAt: Date.now(),
    });

    const r = await request(app)
      .post("/api/compare/run")
      .send({ source_file_id: "forcedxls", target_file_id: good.body.file_id });

    expect(r.status).toBe(400);
    expect(r.body.detail).toContain(".xls");
  });
});
