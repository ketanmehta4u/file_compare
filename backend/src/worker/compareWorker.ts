import { parentPort, workerData } from "node:worker_threads";
import { runComparison } from "../engine/runComparison";
import { decodeAfterTransfer, encodeForTransfer } from "./transfer";
import type { ProgressUpdate } from "../engine/progress";
import type { ColumnMapping, CompareSettings, FileMeta, Table } from "../engine/types";

/**
 * Runs one comparison off the main thread.
 *
 * The engine itself is unchanged and still synchronous -- it simply calls
 * the reporter as it goes, and here that reporter is a postMessage. The
 * main thread picks those up on its own event loop, which is the whole
 * point: it stays free to answer progress polls, health checks and other
 * users' requests while this thread is busy.
 */

export interface CompareJobInput {
  source: Table;
  sourceMeta: FileMeta;
  target: Table;
  targetMeta: FileMeta;
  settings: CompareSettings;
  mapping: ColumnMapping | null;
  user: string;
}

export type WorkerMessage =
  | { type: "progress"; update: ProgressUpdate }
  | { type: "done"; report: unknown }
  | { type: "error"; message: string };

if (!parentPort) {
  throw new Error("compareWorker must be run as a worker thread.");
}

const port = parentPort;

try {
  const input = decodeAfterTransfer<CompareJobInput>(workerData);

  const report = runComparison(
    input.source,
    input.sourceMeta,
    input.target,
    input.targetMeta,
    input.settings,
    input.mapping,
    input.user,
    (update: ProgressUpdate) => {
      const message: WorkerMessage = { type: "progress", update };
      port.postMessage(message);
    }
  );

  const message: WorkerMessage = { type: "done", report: encodeForTransfer(report) };
  port.postMessage(message);
} catch (err) {
  const message: WorkerMessage = {
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  };
  port.postMessage(message);
}
