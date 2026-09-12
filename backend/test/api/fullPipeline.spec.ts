import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../../src/app";
import { fileCache, catalogCache, runCache } from "../../src/cache/stores";

const FIXTURES = join(__dirname, "../../../fixtures");
const app = createApp();

beforeEach(() => {
  fileCache.clear();
  catalogCache.clear();
  runCache.clear();
});

/**
 * Full-pipeline smoke test, ported from test_api.py's
 * TestCompareFlow.test_full_pipeline_against_sample_data: upload the
 * catalogue, pick GL_MONTHLY, upload both sample files, run the
 * comparison, download the report. If any of these wires are
 * disconnected, this fails before the finer-grained tests matter.
 */
describe("full pipeline: catalog -> files -> compare -> report", () => {
  it("reproduces the documented sanity check end to end over HTTP", async () => {
    const catalogUpload = await request(app)
      .post("/api/catalog/upload")
      .attach("file", join(FIXTURES, "sample_catalog.xlsx"));
    expect(catalogUpload.status).toBe(200);
    const catalogId = catalogUpload.body.catalog_id;
    expect(catalogUpload.body.datasets.map((d: { dataset_id: string }) => d.dataset_id)).toContain(
      "GL_MONTHLY"
    );

    const mapping = await request(app).get(`/api/catalog/${catalogId}/datasets/GL_MONTHLY/mapping`);
    expect(mapping.status).toBe(200);
    expect(mapping.body.default_key_columns).toEqual(["transaction_id"]);

    const srcUpload = await request(app)
      .post("/api/files/upload")
      .attach("file", join(FIXTURES, "sample_source.csv"));
    expect(srcUpload.status).toBe(200);
    expect(srcUpload.body.row_count).toBe(12);

    const tgtUpload = await request(app)
      .post("/api/files/upload")
      .attach("file", join(FIXTURES, "sample_target.csv"));
    expect(tgtUpload.status).toBe(200);

    const run = await request(app).post("/api/compare/run").send({
      source_file_id: srcUpload.body.file_id,
      target_file_id: tgtUpload.body.file_id,
      catalog_id: catalogId,
      dataset_id: "GL_MONTHLY",
      drop_unmapped: true,
      key_columns: mapping.body.default_key_columns,
    });
    expect(run.status).toBe(200);
    expect(run.body.summary.matched_equal).toBe(9);
    expect(run.body.summary.matched_with_differences).toBe(2);
    expect(run.body.summary.source_only_rows).toBe(1);
    expect(run.body.summary.target_only_rows).toBe(2);
    expect(run.body.source_only_rows[0].transaction_id).toBe("TXN-012");

    // superagent doesn't know the xlsx MIME type, so it won't parse
    // res.body into a Buffer automatically -- assert via headers instead
    // of reading raw bytes.
    const report = await request(app).get(`/api/compare/${run.body.run_id}/report.xlsx`);
    expect(report.status).toBe(200);
    expect(report.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(report.headers["content-disposition"]).toContain("reconciliation_");

    const annotated = await request(app).get(`/api/compare/${run.body.run_id}/annotated/source`);
    expect(annotated.status).toBe(200);
  });

  it("returns 404 for an unknown run id", async () => {
    const res = await request(app).get("/api/compare/does-not-exist/report.xlsx");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a compare/run against an uncached file id", async () => {
    const res = await request(app)
      .post("/api/compare/run")
      .send({ source_file_id: "nope", target_file_id: "nope2" });
    expect(res.status).toBe(404);
  });
});
