import Decimal from "decimal.js";

/**
 * Port of comparison.py's `_to_decimal`. Regex order verified against the
 * source (comparison.py:1603-1642): currency symbols stripped first, then
 * thousands-separator commas, then accounting-negative parens LAST (parens
 * check runs on the already currency/comma-stripped string).
 */

const CURRENCY_RE = /[$€£¥₹₽₩₪]/g;
// Only strips a comma sitting between a digit and a following exact 3-digit
// group -- "1,234" -> "1234", but a decimal-comma locale is left untouched.
const THOUSANDS_RE = /(?<=\d),(?=\d{3}\b)/g;
const PAREN_NEG_RE = /^\((.+)\)$/;

export function toDecimal(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Decimal) return raw;

  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return null;
    // Round-trip through the shortest string representation, same as
    // Python's Decimal(str(raw)) -- avoids binary-float artifacts like
    // Decimal(0.1) producing a long non-0.1 expansion.
    return normaliseNegZero(new Decimal(String(raw)));
  }

  let s = String(raw).trim();
  if (s === "") return null;
  const lower = s.toLowerCase();
  if (lower === "nan" || lower === "none" || lower === "null") return null;

  s = s.replace(CURRENCY_RE, "").trim();
  s = s.replace(THOUSANDS_RE, "");

  const parenMatch = PAREN_NEG_RE.exec(s);
  if (parenMatch) {
    s = "-" + parenMatch[1];
  }

  s = s.replace(/\s+/g, "");

  try {
    const d = new Decimal(s);
    return normaliseNegZero(d);
  } catch {
    return null;
  }
}

function normaliseNegZero(d: Decimal): Decimal {
  return d.isZero() ? new Decimal(0) : d;
}
