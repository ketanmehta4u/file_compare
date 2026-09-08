import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";

// The cache is sized once at module load, so the budget has to be set
// before stores.ts is imported. 200 KB fits two of the ~90 KB uploads
// below, but not three.
process.env.MAX_CACHE_BYTES = String(200 * 1024);
const { createApp } = await import("../../src/app");
const { fileCache } = await import("../../src/cache/stores");
const { cacheBudgetBytes } = await import("../../src/config/env");

const app = createApp();

beforeEach(() => {
  fileCache.clear();
});

afterAll(() => {
  delete process.env.MAX_CACHE_BYTES;
});

/** ~90 KB of CSV, distinct per `tag` so each gets its own content hash. */
function csv(tag: string): Buffer {
  let s = "id,amount\n";
  for (let i = 0; i < 6000; i++) s += `${tag}-${i},${i}.00\n`;
  return Buffer.from(s);
}

async function upload(tag: string) {
  const r = await request(app).post("/api/files/upload").attach("file", csv(tag), `${tag}.csv`);
  expect(r.status).toBe(200);
  return r.body.file_id as string;
}

describe("upload cache budget", () => {
  it("takes an explicit budget from the environment", () => {
    expect(cacheBudgetBytes()).toBe(200 * 1024);
  });

  it("caches the uploaded bytes, not the parsed table", async () => {
    const id = await upload("a");
    const cached = fileCache.get(id)!;
    expect(Buffer.isBuffer(cached.bytes)).toBe(true);
    // The parse is kept only as metadata; the rows are not retained.
    expect(cached.meta.rowCount).toBe(6000);
    expect(cached).not.toHaveProperty("table");
  });

  it("remembers how a file was read so later parses match", async () => {
    const r = await request(app)
      .post("/api/files/upload")
      .field("has_header", "false")
      .field("delimiter", ";")
      .attach("file", Buffer.from("a;b\n1;2\n"), "semi.csv");
    const cached = fileCache.get(r.body.file_id)!;
    expect(cached.load).toEqual({ sheetName: undefined, hasHeader: false, delimiter: ";" });
  });

  // The point of the change: eviction now follows bytes. Counting entries
  // said "50 files" whether they were 20 KB or 50 MB each.
  it("evicts by bytes rather than by entry count", async () => {
    const first = await upload("a");
    const second = await upload("b");
    expect(fileCache.get(first)).toBeDefined();
    expect(fileCache.get(second)).toBeDefined();

    // A third ~90 KB upload cannot fit in a 200 KB budget, so the least
    // recently used one goes -- with entry-count eviction all three would
    // have stayed, since the cap was 50.
    const third = await upload("c");
    expect(fileCache.get(third)).toBeDefined();
    expect(fileCache.size).toBeLessThan(3);
    expect(fileCache.calculatedSize).toBeLessThanOrEqual(200 * 1024);
  });

  it("keeps a re-used file over an idle one", async () => {
    const a = await upload("a");
    const b = await upload("b");
    // Touch a, so b becomes the least recently used.
    fileCache.get(a);
    await upload("c");

    expect(fileCache.get(a)).toBeDefined();
    expect(fileCache.get(b)).toBeUndefined();
  });
});
