import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { normaliseCell } from "../../src/engine/normalise";
import { defaultSettings } from "../../src/engine/types";

// Ported from tests/test_comparison.py::TestNormalise (kind-dispatch subset).
describe("normaliseCell", () => {
  const settings = defaultSettings();

  it("null/blank inputs normalise to null", () => {
    expect(normaliseCell(null, settings)).toEqual({ kind: "null", value: null });
    expect(normaliseCell("", settings)).toEqual({ kind: "null", value: null });
    expect(normaliseCell(" ", settings)).toEqual({ kind: "null", value: null });
  });

  it("dispatches currency text to numeric", () => {
    const { kind, value } = normaliseCell("$100.50", settings);
    expect(kind).toBe("numeric");
    expect((value as Decimal).equals("100.50")).toBe(true);
  });

  it("dispatches an ISO date string to date", () => {
    const { kind, value } = normaliseCell("2026-01-03", settings);
    expect(kind).toBe("date");
    const d = value as Date;
    expect(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`).toBe("2026-1-3");
  });

  it("falls through to text for non-numeric, non-date strings", () => {
    expect(normaliseCell("Acme Corp", settings)).toEqual({ kind: "text", value: "Acme Corp" });
  });

  it("case_sensitive=false folds text to lowercase", () => {
    const s = defaultSettings({ caseSensitive: false });
    expect(normaliseCell("Acme", s)).toEqual({ kind: "text", value: "acme" });
  });

  it("trim_whitespace=false preserves surrounding whitespace", () => {
    const s = defaultSettings({ trimWhitespace: false });
    expect(normaliseCell(" Acme ", s)).toEqual({ kind: "text", value: " Acme " });
  });
});
