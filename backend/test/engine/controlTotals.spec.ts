import { describe, it, expect } from "vitest";
import { controlTotals } from "../../src/engine/controlTotals";
import { defaultSettings } from "../../src/engine/types";
import type { Table } from "../../src/engine/types";

// Ported from tests/test_comparison.py::TestValuesEqual::test_control_total_columns_selection_restricts.
describe("controlTotals", () => {
  const source: Table = {
    columns: ["id", "amount", "qty"],
    rows: [{ id: "A", amount: "10", qty: "2" }],
  };
  const target: Table = {
    columns: ["id", "amount", "qty"],
    rows: [{ id: "A", amount: "10", qty: "3" }],
  };
  const common = ["id", "amount", "qty"];

  it("auto-foots every numeric common column when none are selected", () => {
    const totals = controlTotals(source, target, common, defaultSettings());
    expect(new Set(totals.map((t) => t.column))).toEqual(new Set(["amount", "qty"]));
  });

  it("restricts to the selected columns when control_total_columns is set", () => {
    const totals = controlTotals(source, target, common, defaultSettings({ controlTotalColumns: ["amount"] }));
    expect(totals.map((t) => t.column)).toEqual(["amount"]);
  });

  it("ties out when the delta is zero", () => {
    const totals = controlTotals(source, target, common, defaultSettings({ controlTotalColumns: ["amount"] }));
    expect(totals[0].tiesOut).toBe(true);
    expect(totals[0].delta.isZero()).toBe(true);
  });

  it("does not tie out when qty differs and no tolerance is set", () => {
    const totals = controlTotals(source, target, common, defaultSettings({ controlTotalColumns: ["qty"] }));
    expect(totals[0].tiesOut).toBe(false);
    expect(totals[0].delta.equals(1)).toBe(true); // target(3) - source(2)
  });
});
