import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, getMappingFor, applyMapping, keyCanonicalNames } from "../../src/engine/catalog";
import { loadCsv } from "../../src/engine/fileLoad/csv";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { CompareReport } from "../../src/engine/types";

const FIXTURES = join(__dirname, "../../../fixtures");

/**
 * THE anchor regression test for this entire port. Ported directly from
 * tests/test_comparison.py::TestEndToEnd, which exercises the full
 * pipeline (catalog parse -> mapping -> load -> apply mapping -> compare)
 * against real sample data with an already-known-correct answer:
 * 9 matched & equal, 2 matched with differences, 1 source-only row,
 * 2 target-only rows -- comparing the sample GL_MONTHLY dataset.
 *
 * If this test passes, every engine phase (2.1 through 2.6) is wired
 * together correctly end to end, not just correct in isolation.
 */
describe("end-to-end: sample GL_MONTHLY reconciliation", () => {
  let report: CompareReport;

  beforeAll(async () => {
    const catalogBytes = readFileSync(join(FIXTURES, "sample_catalog.xlsx"));
    const sourceBytes = readFileSync(join(FIXTURES, "sample_source.csv"));
    const targetBytes = readFileSync(join(FIXTURES, "sample_target.csv"));

    const catalog = await loadCatalog(catalogBytes, "sample_catalog.xlsx");
    const mapping = getMappingFor(catalog, "GL_MONTHLY");

    const src = loadCsv(sourceBytes, "sample_source.csv");
    const tgt = loadCsv(targetBytes, "sample_target.csv");

    const srcMapped = applyMapping(src.table, src.meta, "source", mapping, true);
    const tgtMapped = applyMapping(tgt.table, tgt.meta, "target", mapping, true);

    const settings = defaultSettings({ keyColumns: keyCanonicalNames(mapping) });
    report = runComparison(
      srcMapped.table,
      srcMapped.meta,
      tgtMapped.table,
      tgtMapped.meta,
      settings,
      mapping
    );
  });

  it("matches the known-correct ground truth counts", () => {
    expect(report.matchedEqualCount).toBe(9);
    expect(report.matchedWithDifferencesCount).toBe(2);
    expect(report.sourceOnlyRows).toHaveLength(1);
    expect(report.targetOnlyRows).toHaveLength(2);
    expect(report.valueDifferences).toHaveLength(2);
  });

  it("identifies TXN-012 as the source-only row", () => {
    expect(report.sourceOnlyRows[0].transaction_id).toBe("TXN-012");
  });
});
