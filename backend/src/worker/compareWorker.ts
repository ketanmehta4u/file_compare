import { parentPort, workerData } from "node:worker_threads";
import { runComparison } from "../engine/runComparison";
import { loadBytes, type LoadOptions } from "../engine/fileLoad/loadBytes";
import { applyMapping } from "../engine/catalog";
import { decodeAfterTransfer, encodeForTransfer } from "./transfer";
import type { ProgressUpdate } from "../engine/progress";
import type { ColumnMapping, CompareSettings, FileMeta } from "../engine/types";

/**
 * Runs one comparison off the main thread.
 *
 * The worker takes the two files as *bytes* and parses them here, so the
 * parsed tables -- which cost roughly 12x their source bytes -- never
 * exist in the main thread's heap at all. They live for the length of this
 * thread and die with it.
 *
 * The engine itself is unchanged and still synchronous; it simply calls
 * the reporter as it goes, and here that reporter is a postMessage. The
 * main thread picks those up on its own event loop, which is the point:
 * it stays free to answer progress polls, health checks and other users'
 * requests while this thread is busy.
 */

export interface CompareFileInput {
  bytes: Buffer;
  fileName: string;
  load: LoadOptions;
}

export interface CompareJobInput {
  source: CompareFileInput;
  target: CompareFileInput;
  settings: CompareSettings;
  mapping: ColumnMapping | null;
  dropUnmapped: boolean;
  user: string;
  /** When false the per-row status maps are dropped before the report is
   * sent back: they are only ever read by the annotated export, and on a
   * large run they are hundreds of thousands of entries to clone and then
   * hold for the life of the cached run. */
  annotatedOutputs: boolean;
}

export type WorkerMessage =
  | { type: "progress"; update: ProgressUpdate }
  | { type: "done"; report: unknown; sourceMeta: unknown; targetMeta: unknown }
  | { type: "error"; message: string };

if (!parentPort) {
  throw new Error("compareWorker must be run as a worker thread.");
}

const port = parentPort;

async function main(): Promise<void> {
  const input = decodeAfterTransfer<CompareJobInput>(workerData);

  const src = await loadBytes(input.source.bytes, input.source.fileName, input.source.load);
  const tgt = await loadBytes(input.target.bytes, input.target.fileName, input.target.load);

  let sourceTable = src.table;
  let sourceMeta: FileMeta = src.meta;
  let targetTable = tgt.table;
  let targetMeta: FileMeta = tgt.meta;

  // Mapping is applied here rather than in the request handler, because
  // applying it means rewriting every row -- work that belongs on this
  // thread with the tables it rewrites.
  if (input.mapping) {
    ({ table: sourceTable, meta: sourceMeta } = applyMapping(
      sourceTable,
      sourceMeta,
      "source",
      input.mapping,
      input.dropUnmapped
    ));
    ({ table: targetTable, meta: targetMeta } = applyMapping(
      targetTable,
      targetMeta,
      "target",
      input.mapping,
      input.dropUnmapped
    ));
  }

  const report = runComparison(
    sourceTable,
    sourceMeta,
    targetTable,
    targetMeta,
    input.settings,
    input.mapping,
    input.user,
    (update: ProgressUpdate) => {
      const message: WorkerMessage = { type: "progress", update };
      port.postMessage(message);
    }
  );

  if (!input.annotatedOutputs) {
    report.sourceRowStatus = new Map();
    report.targetRowStatus = new Map();
  }

  const message: WorkerMessage = {
    type: "done",
    report: encodeForTransfer(report),
    // Post-mapping metadata: column names and dtypes, no row data. The
    // annotated downloads need it and it is cheap to carry back.
    sourceMeta: encodeForTransfer(sourceMeta),
    targetMeta: encodeForTransfer(targetMeta),
  };
  port.postMessage(message);
}

main().catch((err: unknown) => {
  const message: WorkerMessage = {
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  };
  port.postMessage(message);
});
