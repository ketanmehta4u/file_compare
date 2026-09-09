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

/** id 1 appears twice on the source side, id 2 twice on the target side. */
const SOURCE = Buffer.from(["id,amount", "1,10.00", "1,999.00", "2,20.00", "3,30.00", ""].join("\n"));
const TARGET = Buffer.from(["id,amount", "1,10.00", "2,20.00", "2,777.00", "4,40.00", ""].join("\n"));

async function compareWithDuplicates() {
  const src = await request(app).post("/api/files/upload").attach("file", SOURCE, "source.csv");
  const tgt = await request(app).post("/api/files/upload").attach("file", TARGET, "target.csv");
  const run = await request(app)
    .post("/api/compare/run")
    .send({ source_file_id: src.body.file_id, target_file_id: tgt.body.file_id, key_columns: ["id"] });
  expect(run.status).toBe(200);
  return run.body;
}

describe("duplicate keys", () => {
  it("reports duplicate rows and duplicated key values per side", async () => {
    const body = await compareWithDuplicates();

    // Both numbers are needed to read the situation: "2 rows across 1 key"
    // is a different problem from "2 rows across 2 keys".
    expect(body.summary.source_duplicate_rows).toBe(2);
    expect(body.summary.source_duplicate_keys).toBe(1);
    expect(body.summary.target_duplicate_rows).toBe(2);
    expect(body.summary.target_duplicate_keys).toBe(1);
  });

  // The damaging part of a duplicate key is what it hides: rows beyond the
  // first are not compared, and are not reported as source/target-only
  // either, so they simply do not appear in the reconciliation.
  it("compares only the first row of a duplicated key", async () => {
    const body = await compareWithDuplicates();

    expect(body.summary.matched_equal).toBe(2); // ids 1 and 2, first rows only
    expect(body.source_only_rows.map((r: { id: string }) => r.id)).toEqual(["3"]);
    expect(body.target_only_rows.map((r: { id: string }) => r.id)).toEqual(["4"]);
  });

  it("warns about each side, naming both counts and the way out", async () => {
    const body = await compareWithDuplicates();

    const source = body.warnings.find((w: string) => w.startsWith("Source has"));
    expect(source).toBeDefined();
    expect(source).toContain("1 duplicated key value(s) across 2 rows");
    expect(source).toContain("only the first row per key is compared");
    expect(source).toContain("_record_hash");

    expect(body.warnings.some((w: string) => w.startsWith("Target has"))).toBe(true);
  });

  it("reports no duplicates when keys are unique", async () => {
    const clean = Buffer.from(["id,amount", "1,10.00", "2,20.00", ""].join("\n"));
    const src = await request(app).post("/api/files/upload").attach("file", clean, "a.csv");
    const tgt = await request(app).post("/api/files/upload").attach("file", clean, "b.csv");
    const run = await request(app)
      .post("/api/compare/run")
      .send({ source_file_id: src.body.file_id, target_file_id: tgt.body.file_id, key_columns: ["id"] });

    expect(run.body.summary.source_duplicate_rows).toBe(0);
    expect(run.body.summary.source_duplicate_keys).toBe(0);
    expect(run.body.warnings.filter((w: string) => w.includes("duplicat"))).toEqual([]);
  });

  // Without key columns the key is the whole row, so "duplicate" means an
  // exact repeat rather than a repeated identifier -- and the warning says
  // so in different words.
  it("treats identical rows as duplicates when no key column is set", async () => {
    const repeated = Buffer.from(["id,amount", "1,10.00", "1,10.00", "2,20.00", ""].join("\n"));
    const src = await request(app).post("/api/files/upload").attach("file", repeated, "a.csv");
    const tgt = await request(app).post("/api/files/upload").attach("file", repeated, "b.csv");
    const run = await request(app)
      .post("/api/compare/run")
      .send({ source_file_id: src.body.file_id, target_file_id: tgt.body.file_id });

    expect(run.body.summary.source_duplicate_rows).toBe(2);
    expect(run.body.summary.source_duplicate_keys).toBe(1);
    expect(run.body.warnings.some((w: string) => w.includes("exact-duplicate row group(s)"))).toBe(true);
  });
});
