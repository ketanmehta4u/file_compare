import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { valuesEqual } from "../../src/engine/equality";
import { normaliseCell } from "../../src/engine/normalise";
import { defaultSettings } from "../../src/engine/types";
import type { CompareSettings } from "../../src/engine/types";

// Ported from tests/test_comparison.py::TestValuesEqual and
// ::TestOtherValueKinds / ::TestEnforcedDtypes (the id/leading-zero subset).
describe("valuesEqual", () => {
  it("exact numeric match", () => {
    const s = defaultSettings();
    const r = valuesEqual("numeric", new Decimal(100), "numeric", new Decimal(100), s);
    expect(r.equal).toBe(true);
    expect(r.withinTolerance).toBe(false);
    expect(r.delta!.equals(0)).toBe(true);
  });

  it("numeric mismatch outside tolerance", () => {
    const s = defaultSettings({ numericTolerance: new Decimal("0.01") });
    const r = valuesEqual("numeric", new Decimal("100.00"), "numeric", new Decimal("100.50"), s);
    expect(r.equal).toBe(false);
    expect(r.withinTolerance).toBe(false);
    expect(r.delta!.equals("0.50")).toBe(true);
  });

  it("within-tolerance match is flagged, never collapsed to equal", () => {
    const s = defaultSettings({ numericTolerance: new Decimal("0.01") });
    const r = valuesEqual("numeric", new Decimal("100.00"), "numeric", new Decimal("100.005"), s);
    expect(r.equal).toBe(false);
    expect(r.withinTolerance).toBe(true);
    expect(r.delta!.equals("0.005")).toBe(true);
  });

  it("blank vs value is always a difference", () => {
    const s = defaultSettings();
    const r = valuesEqual("null", null, "numeric", new Decimal(100), s);
    expect(r.equal).toBe(false);
    expect(r.withinTolerance).toBe(false);
  });

  it("sign is preserved, not magnitude-only", () => {
    const s = defaultSettings();
    const r = valuesEqual("numeric", new Decimal(100), "numeric", new Decimal(-100), s);
    expect(r.equal).toBe(false);
    expect(r.delta!.equals(-200)).toBe(true);
  });

  it("decimal_precision rounds before comparing", () => {
    const s = defaultSettings({ decimalPrecision: 2 });
    const r1 = valuesEqual("numeric", new Decimal("100.001"), "numeric", new Decimal("100.004"), s);
    expect(r1.equal).toBe(true);
    expect(r1.delta!.equals(0)).toBe(true);

    const r2 = valuesEqual("numeric", new Decimal("100.001"), "numeric", new Decimal("100.009"), s);
    expect(r2.equal).toBe(false);
    expect(r2.delta!.equals("0.01")).toBe(true);
  });

  it("default precision is exact (no rounding)", () => {
    const s = defaultSettings();
    const r = valuesEqual("numeric", new Decimal("100.001"), "numeric", new Decimal("100.004"), s);
    expect(r.equal).toBe(false);
  });
});

function compare(a: unknown, b: unknown, settings?: CompareSettings, enforced?: "id" | "timestamp") {
  const s = settings ?? defaultSettings();
  const na = normaliseCell(a, s, enforced);
  const nb = normaliseCell(b, s, enforced);
  return valuesEqual(na.kind, na.value, nb.kind, nb.value, s);
}

describe("normaliseCell + valuesEqual (documented behaviours)", () => {
  it("timestamps compare at day precision by default (time of day ignored)", () => {
    expect(compare("2026-01-31 09:00:00", "2026-01-31 17:30:00").equal).toBe(true);
  });

  it("a full ISO timestamp equals a plain date of the same day", () => {
    expect(compare("2026-01-31T09:00:00", "31/01/2026").equal).toBe(true);
  });

  it("a bare time is text, not anchored to today's date", () => {
    const { kind } = normaliseCell("09:30:00", defaultSettings());
    expect(kind).toBe("text");
    expect(compare("09:30:00", "17:45:00").equal).toBe(false);
  });

  it("booleans are case-sensitive text by default", () => {
    expect(compare("TRUE", "true").equal).toBe(false);
    expect(compare("TRUE", "true", defaultSettings({ caseSensitive: false })).equal).toBe(true);
  });

  it("a percent sign is not parsed as numeric", () => {
    const { kind } = normaliseCell("10%", defaultSettings());
    expect(kind).toBe("text");
    expect(compare("10%", "0.10").equal).toBe(false);
  });

  it("leading-zero ids compare as numbers by default (documented caveat)", () => {
    expect(compare("00123", "123").equal).toBe(true);
  });

  it("scientific notation is numeric", () => {
    expect(compare("1.2E5", "120000").equal).toBe(true);
  });

  it("enforced id makes leading zeros significant", () => {
    expect(compare("00123", "123", defaultSettings(), "id").equal).toBe(false);
    expect(compare("00123", "123").equal).toBe(true); // unenforced unaffected
  });

  it("enforced id never parses dates", () => {
    const { kind, value } = normaliseCell("2026-01-31", defaultSettings(), "id");
    expect(kind).toBe("text");
    expect(value).toBe("2026-01-31");
  });
});
