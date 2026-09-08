import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { runComparisonInWorker } from "../../src/worker/runInWorker";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { FileMeta, Table } from "../../src/engine/types";
import type { ProgressUpdate } from "../../src/engine/progress";

function table(rows: Array<Record<string, string>>): Table {
  return { columns: ["id", "amount"], rows };
}

function meta(name: string, rowCount: number): FileMeta {
  return {
    name,
    sha256: "0".repeat(64),
    sizeBytes: 1,
    rowCount,
    columnCount: 2,
    columns: ["id", "amount"],
    dtypes: [
      ["id", "text"],
      ["amount", "numeric"],
    ],
    hasHeader: true,
  };
}

const src = table([
  { id: "1", amount: "10.00" },
  { id: "2", amount: "20.00" },
  { id: "3", amount: "30.00" },
]);
const tgt = table([
  { id: "1", amount: "10.00" },
  { id: "2", amount: "22.50" },
  { id: "4", amount: "40.00" },
]);

const settings = defaultSettings({ keyColumns: ["id"] });

describe("running a comparison in a worker", () => {
  it("produces the same report as running it inline", async () => {
    const inline = runComparison(src, meta("a", 3), tgt, meta("b", 3), settings, null, "tester");
    const viaWorker = await runComparisonInWorker({
      source: src,
      sourceMeta: meta("a", 3),
      target: tgt,
      targetMeta: meta("b", 3),
      settings,
      mapping: null,
      user: "tester",
    });

    expect(viaWorker.audit.outcome).toEqual(inline.audit.outcome);
    expect(viaWorker.sourceOnlyRows).toEqual(inline.sourceOnlyRows);
    expect(viaWorker.targetOnlyRows).toEqual(inline.targetOnlyRows);
    expect(viaWorker.valueDifferences.length).toBe(inline.valueDifferences.length);
  });

  // The whole point of the transfer encoding: a structured clone strips
  // Decimal's prototype, which would leave money values as inert objects.
  it("brings Decimals back as real Decimals, not plain objects", async () => {
    const report = await runComparisonInWorker({
      source: src,
      sourceMeta: meta("a", 3),
      target: tgt,
      targetMeta: meta("b", 3),
      settings,
      mapping: null,
      user: "",
    });

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
    await runComparisonInWorker(
      {
        source: src,
        sourceMeta: meta("a", 3),
        target: tgt,
        targetMeta: meta("b", 3),
        settings,
        mapping: null,
        user: "",
      },
      { onProgress: (u) => updates.push(u) }
    );

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

  it("surfaces an engine error rather than hanging", async () => {
    await expect(
      runComparisonInWorker({
        source: null as unknown as Table,
        sourceMeta: meta("a", 0),
        target: tgt,
        targetMeta: meta("b", 3),
        settings,
        mapping: null,
        user: "",
      })
    ).rejects.toThrow();
  });
});
