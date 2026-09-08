import { describe, it, expect, beforeEach, afterAll } from "vitest";
import ExcelJS from "exceljs";
import request from "supertest";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

// The cap is read per response, but createApp() must be imported after the
// env var is set for the config route to report the same number.
process.env.MAX_RESPONSE_ROWS = "25";
const { createApp } = await import("../../src/app");
const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

afterAll(() => {
  delete process.env.MAX_RESPONSE_ROWS;
});

/** Two files sharing no keys at all, so every row lands in a detail
 * section: `rows` source-only and `rows` target-only. */
function csvPair(rows: number): { source: Buffer; target: Buffer } {
  let a = "id,amount\n";
  let b = "id,amount\n";
  for (let i = 0; i < rows; i++) {
    a += `SRC-${i},${i}.00\n`;
    b += `TGT-${i},${i}.00\n`;
  }
  return { source: Buffer.from(a), target: Buffer.from(b) };
}

async function compare(rows: number) {
  const { source, target } = csvPair(rows);
  const src = await request(app).post("/api/files/upload").attach("file", source, "source.csv");
  const tgt = await request(app).post("/api/files/upload").attach("file", target, "target.csv");
  const run = await request(app)
    .post("/api/compare/run")
    .send({ source_file_id: src.body.file_id, target_file_id: tgt.body.file_id, key_columns: ["id"] });
  expect(run.status).toBe(200);
  return run.body;
}

describe("capping the detail rows in a compare response", () => {
  it("reports the cap in /api/config so the UI knows what it is getting", async () => {
    const r = await request(app).get("/api/config");
    expect(r.body.max_response_rows).toBe(25);
  });

  it("leaves a small result untouched and flags nothing", async () => {
    const body = await compare(5);
    expect(body.source_only_rows).toHaveLength(5);
    expect(body.target_only_rows).toHaveLength(5);
    expect(body.truncation.any_truncated).toBe(false);
    expect(body.truncation.source_only_rows).toEqual({ returned: 5, total: 5, truncated: false });
  });

  it("caps the detail sections but keeps the true totals in the summary", async () => {
    const body = await compare(100);

    expect(body.source_only_rows).toHaveLength(25);
    expect(body.target_only_rows).toHaveLength(25);

    // The counts the UI displays must still be the real ones.
    expect(body.summary.source_only_rows).toBe(100);
    expect(body.summary.target_only_rows).toBe(100);
    expect(body.audit.outcome.source_only_rows).toBe(100);

    expect(body.truncation.any_truncated).toBe(true);
    expect(body.truncation.limit).toBe(25);
    expect(body.truncation.source_only_rows).toEqual({ returned: 25, total: 100, truncated: true });
    expect(body.truncation.target_only_rows).toEqual({ returned: 25, total: 100, truncated: true });
  });

  // The whole point of capping the response rather than the run: the
  // download has to stay complete, or the user loses data they were told
  // to go and fetch.
  it("still puts every row in the downloadable workbook", async () => {
    const body = await compare(100);
    expect(body.source_only_rows).toHaveLength(25);

    const report = await request(app)
      .get(`/api/compare/${body.run_id}/report.xlsx`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(report.status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(report.body);
    const sheet = wb.worksheets.find((w) => w.name.toLowerCase().includes("source"));
    expect(sheet).toBeDefined();
    // Header row plus every one of the 100 source-only rows.
    expect(sheet!.rowCount).toBe(101);
  });

  it("still annotates every row of the source file for download", async () => {
    const body = await compare(100);
    const annotated = await request(app)
      .get(`/api/compare/${body.run_id}/annotated/source`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(annotated.status).toBe(200);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(annotated.body);
    expect(wb.worksheets[0].rowCount).toBe(101);
  });
});
