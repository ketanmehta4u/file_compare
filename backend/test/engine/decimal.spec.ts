import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { toDecimal } from "../../src/engine/decimal";

// Ported from tests/test_comparison.py::TestNormalise::test_to_decimal
// and ::test_to_decimal_non_numeric in the original Python app.
describe("toDecimal", () => {
  it.each([
    ["100", "100"],
    ["1,000.50", "1000.50"],
    ["$1,000.00", "1000.00"],
    ["(1,250.00)", "-1250.00"],
    ["($500)", "-500"],
    ["-0.00", "0"],
    [" 250.00 ", "250.00"],
    ["123.456", "123.456"],
  ])("parses %s -> %s", (raw, expected) => {
    const result = toDecimal(raw);
    expect(result).not.toBeNull();
    expect(result!.equals(new Decimal(expected))).toBe(true);
  });

  it("does not support comma-decimal locale (left as unparseable)", () => {
    expect(toDecimal("€1.234,56")).toBeNull();
  });

  it.each([["", null], ["abc", null], ["nan", null], [null, null]])(
    "non-numeric %s -> null",
    (raw) => {
      expect(toDecimal(raw)).toBeNull();
    }
  );
});
