import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { runComparisonInWorker } from "../../src/worker/runInWorker";
import { runComparison } from "../../src/engine/runComparison";
import { loadBytes } from "../../src/engine/fileLoad/loadBytes";
import { mappingFromPairs } from "../../src/engine/catalog";
import { defaultSettings } from "../../src/engine/types";
import type { ProgressUpdate } from "../../src/engine/progress";
import type { CompareJobInput } from "../../src/worker/compareWorker";

const SOURCE_CSV = Buffer.from(["id,amount", "1,10.00", "2,20.00", "3,30.00", ""].join("\n"));
const TARGET_CSV = Buffer.from(["id,amount", "1,10.00", "2,22.50", "4,40.00", ""].join("\n"));

const load = { hasHeader: true, delimiter: null };
const settings = defaultSettings({ keyColumns: ["id"] });

function input(over: Partial<CompareJobInput> = {}): CompareJobInput {
  return {
    source: { bytes: SOURCE_CSV, fileName: "source.csv", load },
    target: { bytes: TARGET_CSV, fileName: "target.csv", load },
    settings,
    mapping: null,
    dropUnmapped: false,
    user: "tester",
    ...over,
  };
}

describe("running a comparison in a worker", () => {
  it("produces the same report as running it inline", async () => {
    const src = await loadBytes(SOURCE_CSV, "source.csv", load);
    const tgt = await loadBytes(TARGET_CSV, "target.csv", load);
    const inline = runComparison(src.table, src.meta, tgt.table, tgt.meta, settings, null, "tester");

    const { report } = await runComparisonInWorker(input());

    expect(report.audit.outcome).toEqual(inline.audit.outcome);
    expect(report.sourceOnlyRows).toEqual(inline.sourceOnlyRows);
    expect(report.targetOnlyRows).toEqual(inline.targetOnlyRows);
    expect(report.valueDifferences.length).toBe(inline.valueDifferences.length);
  });

  // Regression: the transfer encoder walked every object generically, so a
  // Buffer was rebuilt byte by byte as {0: 105, 1: 100, ...}. Uploads are
  // handed to the worker this way, so it corrupted every file it touched.
  it("carries the uploaded bytes across intact", async () => {
    const { report, sourceMeta } = await runComparisonInWorker(input());
    expect(report.audit.source.rowCount).toBe(3);
    expect(sourceMeta.columns).toEqual(["id", "amount"]);
  });

  // The whole point of the transfer encoding: a structured clone strips
  // Decimal's prototype, which would leave money values as inert objects.
  it("brings Decimals back as real Decimals, not plain objects", async () => {
    const { report } = await runComparisonInWorker(input());

    const diff = report.valueDifferences.find((d) => d.column === "amount");
    expect(diff).toBeDefined();
    expect(diff!.delta).toBeInstanceOf(Decimal);
    expect(diff!.delta!.toString()).toBe("2.5");
    expect(report.audit.settings.numericTolerance).toBeInstanceOf(Decimal);

    const total = report.controlTotals.find((t) => t.column === "amount");
    expect(total?.sourceTotal).toBeInstanceOf(Decimal);
    expect(total?.sourceTotal.toString()).toBe("60");
  });

  it("reports progress as it goes, ending each counted phase at its total", async () => {
    const updates: ProgressUpdate[] = [];
    await runComparisonInWorker(input(), { onProgress: (u) => updates.push(u) });

    const phases = updates.map((u) => u.phase);
    expect(phases).toContain("indexing_source");
    expect(phases).toContain("indexing_target");
    expect(phases).toContain("comparing");
    expect(phases).toContain("reporting");

    const lastIndexSource = [...updates].reverse().find((u) => u.phase === "indexing_source")!;
    expect(lastIndexSource.done).toBe(3);
    expect(lastIndexSource.total).toBe(3);

    // Two keys are common (1 and 2), so the comparing phase counts to 2.
    const lastComparing = [...updates].reverse().find((u) => u.phase === "comparing")!;
    expect(lastComparing.done).toBe(2);
    expect(lastComparing.total).toBe(2);
  });

  it("applies a column mapping on the worker side", async () => {
    const renamedTarget = Buffer.from(["ref,amount", "1,10.00", "2,22.50", "4,40.00", ""].join("\n"));
    // Built the way the route builds it: source column -> target column,
    // where the target's name is the canonical one.
    const mapping = mappingFromPairs(
      new Map([
        ["id", "ref"],
        ["amount", "amount"],
      ])
    );
    const { report } = await runComparisonInWorker(
      input({
        target: { bytes: renamedTarget, fileName: "target.csv", load },
        mapping,
        dropUnmapped: false,
        settings: defaultSettings({ keyColumns: ["ref"] }),
      })
    );
    // The mapping renames the source's "id" to the canonical "ref", so the
    // two sides key together: 1 and 2 match, 3 is source-only, 4 is
    // target-only. Without it, nothing would match at all.
    expect(report.sourceOnlyRows).toHaveLength(1);
    expect(report.targetOnlyRows).toHaveLength(1);
  });

  it("surfaces an engine error rather than hanging", async () => {
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(
      runComparisonInWorker(input({ source: { bytes: ole2, fileName: "legacy.xls", load } }))
    ).rejects.toThrow(/xls/);
  });
});
