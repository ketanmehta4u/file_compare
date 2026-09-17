import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

const app = createApp();

/**
 * Each test speaks from its own client address.
 *
 * Rate limits are per client (10 comparisons a minute), and this file makes
 * more than that between its cases -- so sharing one address would have the
 * limiter, quite correctly, answering 429 to tests that are about something
 * else. TRUST_PROXY defaults to one hop, so X-Forwarded-For is what req.ip
 * becomes here, exactly as it would behind the shipped nginx.
 */
let clientNo = 0;
function client(): string {
  clientNo += 1;
  return `10.1.${Math.floor(clientNo / 250)}.${clientNo % 250}`;
}

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

const SOURCE = Buffer.from(["id,amount", "1,10.00", "2,20.00", ""].join("\n"));
const TARGET = Buffer.from(["id,amount", "1,10.00", "2,22.50", ""].join("\n"));

async function uploadPair(ip: string) {
  const src = await request(app)
    .post("/api/files/upload")
    .set("X-Forwarded-For", ip)
    .attach("file", SOURCE, "source.csv");
  const tgt = await request(app)
    .post("/api/files/upload")
    .set("X-Forwarded-For", ip)
    .attach("file", TARGET, "target.csv");
  return { source_file_id: src.body.file_id as string, target_file_id: tgt.body.file_id as string };
}

/**
 * Every case here was tried against the running server before this existed.
 * Two produced a 500 and an unhandled-error log line; four produced **200
 * and a reconciliation result** computed with the setting quietly ignored.
 * The second kind is the dangerous one: the caller is told the comparison
 * succeeded, having asked for something the server did not do.
 */
describe("a malformed compare request is refused, not guessed at", () => {
  const cases: Array<{ what: string; body: Record<string, unknown>; names: string }> = [
    { what: "key_columns as a string", body: { key_columns: "id" }, names: "key_columns" },
    { what: "key_columns as numbers", body: { key_columns: [1, 2] }, names: "key_columns" },
    { what: "column_map as an array", body: { column_map: ["a", "b"] }, names: "column_map" },
    { what: "case_sensitive as text", body: { case_sensitive: "yes" }, names: "case_sensitive" },
    { what: "decimal_precision as text", body: { decimal_precision: "abc" }, names: "decimal_precision" },
    {
      what: "control_total_columns as an object",
      body: { control_total_columns: { a: 1 } },
      names: "control_total_columns",
    },
    { what: "a negative decimal_precision", body: { decimal_precision: -1 }, names: "decimal_precision" },
    { what: "an unknown field (a typo)", body: { key_column: ["id"] }, names: "key_column" },
    {
      what: "an absurd number of key columns",
      body: { key_columns: Array.from({ length: 2000 }, (_, i) => `c${i}`) },
      names: "key_columns",
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.what} with a 400 naming the field`, async () => {
      const ip = client();
      const ids = await uploadPair(ip);
      const res = await request(app)
        .post("/api/compare/run")
        .set("X-Forwarded-For", ip)
        .send({ ...ids, ...c.body });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain(c.names);
      // Never a result: the caller must not be told a comparison succeeded.
      expect(res.body.run_id).toBeUndefined();
    });
  }

  it("applies the same checks to the background job route", async () => {
    const ip = client();
    const ids = await uploadPair(ip);
    const res = await request(app)
      .post("/api/compare/jobs")
      .set("X-Forwarded-For", ip)
      .send({ ...ids, case_sensitive: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("case_sensitive");
    expect(res.body.job_id).toBeUndefined();
  });

  it("still runs a valid request unchanged", async () => {
    const ip = client();
    const ids = await uploadPair(ip);
    const res = await request(app)
      .post("/api/compare/run")
      .set("X-Forwarded-For", ip)
      .send({
        ...ids,
        key_columns: ["id"],
        case_sensitive: true,
        decimal_precision: 2,
        numeric_tolerance: "0.01",
        annotated_outputs: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.summary.matched_equal).toBe(1);
    expect(res.body.summary.matched_with_differences).toBe(1);
  });

  // The engine's own input errors still have to come back as 400s with their
  // own wording -- schema validation sits in front of them, not over them.
  it("leaves the existing field-level errors intact", async () => {
    const ip = client();
    const ids = await uploadPair(ip);
    const res = await request(app)
      .post("/api/compare/run")
      .set("X-Forwarded-For", ip)
      .send({ ...ids, numeric_tolerance: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("numeric_tolerance");
  });
});

describe("upload options", () => {
  it("rejects a delimiter that could never be one", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("X-Forwarded-For", client())
      .field("delimiter", "not-a-delimiter")
      .attach("file", SOURCE, "source.csv");
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("delimiter");
  });

  it("accepts the options the UI actually sends", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("X-Forwarded-For", client())
      .field("has_header", "true")
      .field("delimiter", ",")
      .attach("file", SOURCE, "source.csv");
    expect(res.status).toBe(200);
    expect(res.body.row_count).toBe(2);
  });
});
