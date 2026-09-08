import Decimal from "decimal.js";
import { normaliseCell } from "./normalise";
import type { CompareSettings, ControlTotal, Table } from "./types";
import { enforcedFor } from "./types";
import { throttleByCount, type ProgressReporter } from "./progress";

/**
 * Port of comparison.py's `_control_totals`. Independent column-wise
 * sum tie-out: a column qualifies when at least one side has any numeric
 * value in it (an enforced id/timestamp column never yields "numeric" kind,
 * so it's naturally excluded). If `controlTotalColumns` is set, only those
 * (still restricted to common columns) are footed; otherwise every common
 * column is auto-footed.
 */
export function controlTotals(
  source: Table,
  target: Table,
  commonColumns: readonly string[],
  settings: CompareSettings,
  onProgress?: ProgressReporter
): ControlTotal[] {
  const selected = new Set(settings.controlTotalColumns);
  const cols = commonColumns.filter((c) => selected.size === 0 || selected.has(c));

  // Footing every numeric column re-normalises each cell on both sides, so
  // this phase is a full pass per column -- on a wide file it rivals the
  // matching itself, and without its own count the progress bar would sit
  // still for the whole of it.
  const report = throttleByCount(onProgress);
  const totalUnits = cols.length * (source.rows.length + target.rows.length);
  let unitsDone = 0;

  const totals: ControlTotal[] = [];
  for (const col of cols) {
    const enforced = enforcedFor(settings, col);
    const srcVals: Decimal[] = [];
    const tgtVals: Decimal[] = [];

    if (source.columns.includes(col)) {
      for (const row of source.rows) {
        const { kind, value } = normaliseCell(row[col], settings, enforced);
        if (kind === "numeric") srcVals.push(value as Decimal);
        report({ phase: "control_totals", done: ++unitsDone, total: totalUnits });
      }
    }
    if (target.columns.includes(col)) {
      for (const row of target.rows) {
        const { kind, value } = normaliseCell(row[col], settings, enforced);
        if (kind === "numeric") tgtVals.push(value as Decimal);
        report({ phase: "control_totals", done: ++unitsDone, total: totalUnits });
      }
    }
    if (srcVals.length === 0 && tgtVals.length === 0) continue;

    const sTotal = srcVals.reduce((acc, v) => acc.plus(v), new Decimal(0));
    const tTotal = tgtVals.reduce((acc, v) => acc.plus(v), new Decimal(0));
    const delta = tTotal.minus(sTotal);
    const tiesOut =
      delta.isZero() ||
      (settings.numericTolerance.greaterThan(0) && delta.abs().lessThanOrEqualTo(settings.numericTolerance));

    totals.push({ column: col, sourceTotal: sTotal, targetTotal: tTotal, delta, tiesOut });
  }
  return totals;
}
