import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { FileMeta, Table } from "../../src/engine/types";

function meta(name: string, columns: string[], overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    name,
    sha256: "x".repeat(64),
    sizeBytes: 100,
    rowCount: 10,
    columnCount: columns.length,
    columns,
    dtypes: columns.map((c) => [c, "text"] as const),
    hasHeader: true,
    ...overrides,
  };
}

describe("runComparison (orchestration + verdict)", () => {
  it("verdict is RECONCILED when everything matches exactly", () => {
    const source: Table = { columns: ["id", "amount"], rows: [{ id: "1", amount: "100" }] };
    const target: Table = { columns: ["id", "amount"], rows: [{ id: "1", amount: "100" }] };
    const settings = defaultSettings({ keyColumns: ["id"] });
    const report = runComparison(source, meta("s", source.columns), target, meta("t", target.columns), settings);

    expect(report.audit.outcome.reconciled).toBe(true);
    expect(report.audit.outcome.verdict).toBe("RECONCILED — no differences found");
    expect(report.matchedEqualCount).toBe(1);
  });

  it("verdict is RECONCILED WITHIN TOLERANCE when only tolerance-flagged rows exist", () => {
    const source: Table = { columns: ["id", "amount"], rows: [{ id: "1", amount: "100.00" }] };
    const target: Table = { columns: ["id", "amount"], rows: [{ id: "1", amount: "100.005" }] };
    const settings = defaultSettings({ keyColumns: ["id"], numericTolerance: new Decimal("0.01") });
    const report = runComparison(source, meta("s", source.columns), target, meta("t", target.columns), settings);

    expect(report.audit.outcome.reconciled).toBe(true);
    expect(report.audit.outcome.verdict).toContain("RECONCILED WITHIN TOLERANCE");
    expect(report.matchedWithToleranceCount).toBe(1);
  });

  it("verdict is DIFFERENCES FOUND and counts every hard-break category", () => {
    const source: Table = {
      columns: ["id", "amount"],
      rows: [
        { id: "1", amount: "100" }, // matches
        { id: "2", amount: "50" }, // source-only
      ],
    };
    const target: Table = {
      columns: ["id", "amount"],
      rows: [
        { id: "1", amount: "999" }, // hard diff
        { id: "3", amount: "20" }, // target-only
      ],
    };
    const settings = defaultSettings({ keyColumns: ["id"] });
    const report = runComparison(source, meta("s", source.columns), target, meta("t", target.columns), settings);

    expect(report.audit.outcome.reconciled).toBe(false);
    // hard_breaks = 1 source-only + 1 target-only + 1 matched-with-differences
    // + 2 control totals not tied out. Both "amount" AND "id" auto-foot here:
    // id's values ("1","2","3") parse as numeric too, so id sums to 3 vs 4
    // as well as amount's real mismatch -- every common numeric column foots
    // by default, matching Python's exact auto-footing rule.
    expect(report.audit.outcome.verdict).toBe("DIFFERENCES FOUND — 5 break(s) require review");
    expect(report.audit.outcome.controlTotalsNotTiedOut).toBe(2);
    expect(report.audit.outcome.sourceOnlyRows).toBe(1);
    expect(report.audit.outcome.targetOnlyRows).toBe(1);
    expect(report.audit.outcome.matchedWithDifferences).toBe(1);
  });

  it("row offset reflects whether the file had a header (2) or not (1)", () => {
    const source: Table = { columns: ["id"], rows: [{ id: "1" }] };
    const target: Table = { columns: ["id"], rows: [{ id: "2" }] }; // no match -> source-only + target-only
    const settings = defaultSettings({ keyColumns: ["id"] });
    const report = runComparison(
      source,
      meta("s", source.columns, { hasHeader: false }),
      target,
      meta("t", target.columns, { hasHeader: true }),
      settings
    );
    expect(report.sourceOnlyRows[0]._row).toBe(1); // no header -> offset 1
    expect(report.targetOnlyRows[0]._row).toBe(2); // header -> offset 2
  });

  it("surfaces file-level notice warnings (hidden columns/rows, uncalculated formulas)", () => {
    const source: Table = { columns: ["id"], rows: [{ id: "1" }] };
    const target: Table = { columns: ["id"], rows: [{ id: "1" }] };
    const settings = defaultSettings({ keyColumns: ["id"] });
    const report = runComparison(
      source,
      meta("s", source.columns, { hiddenColumns: ["secret"], hiddenRowCount: 2 }),
      target,
      meta("t", target.columns, { formulaBlankColumns: ["calc"], formulaBlankCount: 3 }),
      settings
    );
    expect(report.warnings.some((w) => w.includes("hidden column"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("uncalculated formula"))).toBe(true);
  });
});
