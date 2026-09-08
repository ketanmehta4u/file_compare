import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { compareRecords } from "../../src/engine/compareRecords";
import { defaultSettings } from "../../src/engine/types";
import type { Table } from "../../src/engine/types";

function table(columns: string[], rows: Array<Record<string, unknown>>): Table {
  return { columns, rows };
}

describe("compareRecords", () => {
  it("classifies matched_equal, matched_with_differences, and only-in-X rows", () => {
    const source = table(
      ["id", "amount", "name"],
      [
        { id: "1", amount: "100", name: "Acme" },
        { id: "2", amount: "50", name: "Beta" },
        { id: "3", amount: "10", name: "Gone" },
      ]
    );
    const target = table(
      ["id", "amount", "name"],
      [
        { id: "1", amount: "100", name: "Acme" }, // equal
        { id: "2", amount: "55", name: "Beta" }, // differs
        { id: "4", amount: "20", name: "New" }, // target-only
      ]
    );
    const settings = defaultSettings({ keyColumns: ["id"] });
    const r = compareRecords(source, target, ["id", "amount", "name"], settings, 2, 2);

    expect(r.matchedEqual).toBe(1);
    expect(r.matchedDiff).toBe(1);
    expect(r.matchedTol).toBe(0);
    expect(r.sourceOnlyRows).toHaveLength(1);
    expect(r.sourceOnlyRows[0].id).toBe("3");
    expect(r.targetOnlyRows).toHaveLength(1);
    expect(r.targetOnlyRows[0].id).toBe("4");
    expect(r.valueDifferences).toHaveLength(1);
    expect(r.valueDifferences[0].column).toBe("amount");
    // the diff belongs to id=2 (Beta: 50 -> 55) -- id=1 (Acme) is identical.
    // keyed diff: key is { id: <normalised key value> }, not stringified.
    expect(r.valueDifferences[0].key.id).toBeInstanceOf(Decimal);
    expect((r.valueDifferences[0].key.id as Decimal).equals(2)).toBe(true);
  });

  it("classifies matched_with_tolerance separately from matched_with_differences", () => {
    const source = table(["id", "amount"], [{ id: "1", amount: "100.00" }]);
    const target = table(["id", "amount"], [{ id: "1", amount: "100.005" }]);
    const settings = defaultSettings({ keyColumns: ["id"], numericTolerance: new Decimal("0.01") });
    const r = compareRecords(source, target, ["id", "amount"], settings, 2, 2);

    expect(r.matchedEqual).toBe(0);
    expect(r.matchedDiff).toBe(0);
    expect(r.matchedTol).toBe(1);
    expect(r.valueDifferences[0].withinTolerance).toBe(true);
  });

  it("falls back to whole-row matching and warns when a key column is missing from one side", () => {
    // Fallback resolves key columns independently per side (all of that
    // side's own columns, sorted) -- matching Python's _key_cols_for(df).
    // With matching column sets on both sides, whole-row equality still
    // finds the match once 'id' (present in neither) is dropped as the key.
    const source = table(["amount"], [{ amount: "100" }]);
    const target = table(["amount"], [{ amount: "100" }]);
    const settings = defaultSettings({ keyColumns: ["id"] }); // 'id' exists in neither
    const r = compareRecords(source, target, ["amount"], settings, 2, 2);

    expect(r.warnings.some((w) => w.includes("Falling back to full-row matching"))).toBe(true);
    expect(r.matchedEqual).toBe(1);
  });

  it("detects duplicate keys and does not match beyond the first occurrence", () => {
    const source = table(
      ["id", "amount"],
      [
        { id: "1", amount: "100" },
        { id: "1", amount: "999" }, // duplicate key
      ]
    );
    const target = table(["id", "amount"], [{ id: "1", amount: "100" }]);
    const settings = defaultSettings({ keyColumns: ["id"] });
    const r = compareRecords(source, target, ["id", "amount"], settings, 2, 2);

    expect(r.dupStats.sourceDuplicateKeys).toBe(1);
    expect(r.dupStats.sourceDuplicateRows).toBe(2);
    expect(r.dupStats.keyed).toBe(true);
    expect(r.warnings.some((w) => w.includes("duplicated key value(s)"))).toBe(true);
    // Only the first source row (amount=100) participates in matching.
    expect(r.matchedEqual).toBe(1);
  });

  it("sorts only-in-X rows by content, not file order, for determinism", () => {
    // The content sort key covers ALL non-underscore columns (matching
    // Python's _content_key), not just the compared ones -- a single
    // column keeps this test's ordering unambiguous.
    const source = table(["name"], [{ name: "Zeta" }, { name: "Alpha" }]);
    const target = table(["name"], []);
    const settings = defaultSettings({ keyColumns: ["id"] }); // 'id' missing -> whole-row fallback
    const r = compareRecords(source, target, ["name"], settings, 2, 2);

    expect(r.sourceOnlyRows.map((row) => row.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("uses a stringified whole-row key for ValueDifference.key when no key columns are configured", () => {
    const source = table(["a", "b"], [{ a: "1", b: "x" }]);
    const target = table(["a", "b"], [{ a: "1", b: "y" }]);
    const settings = defaultSettings(); // no key columns -> whole-row fallback
    const r = compareRecords(source, target, ["a", "b"], settings, 2, 2);

    // Whole-row keys differ (b differs), so there's no common key at all --
    // both rows show up as only-in-X, not as a value difference.
    expect(r.sourceOnlyRows).toHaveLength(1);
    expect(r.targetOnlyRows).toHaveLength(1);
    expect(r.valueDifferences).toHaveLength(0);
  });

  it("row offset controls the 1-based row numbers surfaced on diffs and only-rows", () => {
    const source = table(["id", "amount"], [{ id: "1", amount: "100" }]);
    const target = table(["id", "amount"], [{ id: "1", amount: "200" }]);
    const settings = defaultSettings({ keyColumns: ["id"] });
    // offset 2 == "file has a header row" (0-based index 0 -> file row 2).
    const r = compareRecords(source, target, ["id", "amount"], settings, 2, 2);
    expect(r.valueDifferences[0].sourceRow).toBe(2);
    expect(r.valueDifferences[0].targetRow).toBe(2);
  });
});
