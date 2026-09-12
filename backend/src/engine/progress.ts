/**
 * Progress reporting for a running comparison.
 *
 * The engine stays synchronous -- it just calls a reporter as it goes. In
 * the worker that reporter turns into a postMessage, which the main thread
 * receives on its own event loop, so live progress needs no async plumbing
 * inside the engine itself.
 */

export type ProgressPhase =
  "indexing_source" | "indexing_target" | "matching" | "comparing" | "control_totals" | "reporting";

/** Human wording per phase, so the API and UI agree on the label. */
export const PHASE_LABELS: Record<ProgressPhase, string> = {
  indexing_source: "Indexing source rows",
  indexing_target: "Indexing target rows",
  matching: "Matching rows",
  comparing: "Comparing matched rows",
  control_totals: "Footing control totals",
  reporting: "Building the report",
};

export interface ProgressUpdate {
  phase: ProgressPhase;
  /** Units finished in this phase. */
  done: number;
  /** Units expected in this phase; 0 when it cannot be known up front. */
  total: number;
}

export type ProgressReporter = (update: ProgressUpdate) => void;

/**
 * Wraps a reporter so a hot loop can call it per row without flooding the
 * channel: an update is passed on every `every` units, and the final one
 * for a phase is always sent (so a phase never appears to stall short of
 * its total).
 */
export function throttleByCount(reporter: ProgressReporter | undefined, every = 2000): ProgressReporter {
  if (!reporter) return () => {};
  let lastSent = -1;
  let lastPhase: ProgressPhase | null = null;
  return (u: ProgressUpdate) => {
    const phaseChanged = u.phase !== lastPhase;
    const isLast = u.total > 0 && u.done >= u.total;
    if (phaseChanged || isLast || u.done - lastSent >= every) {
      lastPhase = u.phase;
      lastSent = u.done;
      reporter(u);
    }
  };
}
