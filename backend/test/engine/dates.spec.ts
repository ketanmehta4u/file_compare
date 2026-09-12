import { describe, it, expect } from "vitest";
import { parseDate } from "../../src/engine/dates";

function iso(d: Date | null): string | null {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(
    2,
    "0"
  )}`;
}

// Ported from tests/test_comparison.py::TestNormalise::test_parse_date.
// The DMY-before-MDY case ("03/01/2026" -> Jan 3, not March 1) is the
// single most safety-critical assertion in this file.
describe("parseDate", () => {
  it.each([
    ["2026-01-03", "2026-01-03"],
    ["03/01/2026", "2026-01-03"], // DMY: 3 January, not 1 March
    ["2026/01/03", "2026-01-03"],
    ["Jan 3, 2026", "2026-01-03"],
  ])("%s -> %s", (raw, expected) => {
    expect(iso(parseDate(raw))).toBe(expected);
  });

  it("falls through to MDY when DMY is impossible (month > 12)", () => {
    // "12/25/2024": day=12 valid but month=25 is not, so DMY must fail and
    // MDY (December 25) must be the one that succeeds.
    expect(iso(parseDate("12/25/2024"))).toBe("2024-12-25");
  });

  it("rejects a bare time rather than anchoring to today", () => {
    expect(parseDate("09:30")).toBeNull();
    expect(parseDate("9:30 AM")).toBeNull();
  });

  it("treats an Excel serial as a day count from 1899-12-30", () => {
    // Verified against the original Python engine's own epoch arithmetic:
    // datetime(1899,12,30) + timedelta(days=45658) == 2025-01-01.
    expect(iso(parseDate(45658))).toBe("2025-01-01");
  });
});
