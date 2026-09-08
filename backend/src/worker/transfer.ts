import Decimal from "decimal.js";

/**
 * Structured clone (what `worker_threads` uses to move values between
 * threads) preserves Date, Map, Set and plain objects, but not class
 * instances -- a Decimal arrives on the other side as a plain object with
 * Decimal's internals and none of its methods, which would break silently
 * the first time something called `.toString()` on a money value.
 *
 * So Decimals are boxed into a tagged marker on the way out and rebuilt on
 * the way in. Everything else is left alone: Dates and Maps cross intact,
 * and the tables themselves are plain strings.
 *
 * Deliberately generic rather than a field-by-field mapping of
 * CompareReport: Decimals turn up in the settings, the value differences,
 * the control totals *and* inside normalised row keys, and a hand-written
 * mapping would rot the moment a field moved.
 */

const DECIMAL_TAG = "__decimal__";

interface DecimalMarker {
  [DECIMAL_TAG]: string;
}

function isDecimalMarker(v: unknown): v is DecimalMarker {
  return typeof v === "object" && v !== null && typeof (v as DecimalMarker)[DECIMAL_TAG] === "string";
}

/** Replace every Decimal with a marker, recursively. */
export function encodeForTransfer<T>(value: T): unknown {
  if (value instanceof Decimal) return { [DECIMAL_TAG]: value.toString() };
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => encodeForTransfer(v));
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) out.set(k, encodeForTransfer(v));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    for (const v of value) out.add(encodeForTransfer(v));
    return out;
  }
  if (typeof value === "object") {
    // Plain objects only. Anything else with a prototype would lose it in
    // the clone anyway, and this codebase does not send one.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeForTransfer(v);
    }
    return out;
  }
  return value;
}

/** Rebuild the Decimals that encodeForTransfer boxed up. */
export function decodeAfterTransfer<T = unknown>(value: unknown): T {
  if (isDecimalMarker(value)) return new Decimal(value[DECIMAL_TAG]) as unknown as T;
  if (value === null || value === undefined) return value as T;
  if (value instanceof Date) return value as unknown as T;
  if (Array.isArray(value)) return value.map((v) => decodeAfterTransfer(v)) as unknown as T;
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) out.set(k, decodeAfterTransfer(v));
    return out as unknown as T;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    for (const v of value) out.add(decodeAfterTransfer(v));
    return out as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeAfterTransfer(v);
    }
    return out as T;
  }
  return value as T;
}
