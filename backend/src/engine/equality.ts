import Decimal from "decimal.js";
import type { CellKind, CellValue, CompareSettings } from "./types";

export interface EqualityResult {
  equal: boolean;
  withinTolerance: boolean;
  delta: Decimal | null;
}

/** Port of comparison.py's `_round_to`: half-up rounding, falls back to the
 * unrounded value if the quantize target is out of range. */
function roundTo(value: Decimal, precision: number): Decimal {
  try {
    return value.toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
  } catch {
    return value;
  }
}

/**
 * Port of comparison.py's `_values_equal`. Logic verified line-for-line
 * against source (comparison.py:1956-2017):
 *  - blank-as-zero coercion is asymmetric: only fires when the *other*
 *    side is numeric, and only when the setting is on.
 *  - exactly-one-null is always unequal, with a directional delta
 *    (negative of the numeric side if source was numeric, else the
 *    target's value, else null).
 *  - both-numeric: optional precision rounding, then delta = target -
 *    source; tolerance is a THIRD state (within_tolerance=true,
 *    equal=false) that never collapses to equal.
 *  - cross-kind (non-numeric) is unequal with no delta; same-kind
 *    non-numeric compares by plain equality.
 */
export function valuesEqual(
  srcKindIn: CellKind,
  srcValIn: CellValue,
  tgtKindIn: CellKind,
  tgtValIn: CellValue,
  settings: CompareSettings
): EqualityResult {
  let srcKind = srcKindIn;
  let srcVal = srcValIn;
  let tgtKind = tgtKindIn;
  let tgtVal = tgtValIn;

  let srcIsNull = srcKind === "null";
  let tgtIsNull = tgtKind === "null";

  if (settings.treatBlankAsZero) {
    if (srcIsNull && tgtKind === "numeric") {
      srcKind = "numeric";
      srcVal = new Decimal(0);
      srcIsNull = false;
    }
    if (tgtIsNull && srcKind === "numeric") {
      tgtKind = "numeric";
      tgtVal = new Decimal(0);
      tgtIsNull = false;
    }
  }

  if (srcIsNull && tgtIsNull) {
    return { equal: true, withinTolerance: false, delta: null };
  }
  if (srcIsNull || tgtIsNull) {
    if (srcKind === "numeric") {
      return { equal: false, withinTolerance: false, delta: (srcVal as Decimal).negated() };
    }
    if (tgtKind === "numeric") {
      return { equal: false, withinTolerance: false, delta: tgtVal as Decimal };
    }
    return { equal: false, withinTolerance: false, delta: null };
  }

  if (srcKind === "numeric" && tgtKind === "numeric") {
    let s = srcVal as Decimal;
    let t = tgtVal as Decimal;
    if (settings.decimalPrecision !== null) {
      s = roundTo(s, settings.decimalPrecision);
      t = roundTo(t, settings.decimalPrecision);
    }
    const delta = t.minus(s);
    if (delta.isZero()) {
      return { equal: true, withinTolerance: false, delta: new Decimal(0) };
    }
    if (
      settings.numericTolerance.greaterThan(0) &&
      delta.abs().lessThanOrEqualTo(settings.numericTolerance)
    ) {
      return { equal: false, withinTolerance: true, delta };
    }
    return { equal: false, withinTolerance: false, delta };
  }

  if (srcKind !== tgtKind) {
    return { equal: false, withinTolerance: false, delta: null };
  }

  const equal = valuesStrictlyEqual(srcVal, tgtVal);
  return { equal, withinTolerance: false, delta: null };
}

function valuesStrictlyEqual(a: CellValue, b: CellValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
