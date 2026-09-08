import { Worker } from "node:worker_threads";
import path from "node:path";
import { decodeAfterTransfer, encodeForTransfer } from "./transfer";
import type { CompareJobInput, WorkerMessage } from "./compareWorker";
import type { ProgressUpdate } from "../engine/progress";
import type { CompareReport } from "../engine/types";

export interface RunInWorkerOptions {
  onProgress?: (update: ProgressUpdate) => void;
  /** Resolves the worker handle so a caller can cancel the run. */
  onStart?: (worker: Worker) => void;
}

/**
 * Resolves the worker entry point for however this process is running.
 *
 * Compiled, `__filename` is .js and the sibling .js worker is loaded
 * directly. Under tsx (`npm run dev`) or vitest, `__filename` is .ts and
 * Node cannot load TypeScript in a worker by itself -- so the tsx loader
 * is passed through `execArgv`, which is what lets dev and the test suite
 * exercise the real worker instead of a stand-in.
 */
function workerEntry(): { file: string; execArgv: string[] | undefined } {
  const ext = path.extname(__filename);
  const file = path.resolve(__dirname, `compareWorker${ext}`);
  return { file, execArgv: ext === ".ts" ? ["--import", "tsx"] : undefined };
}

export class ComparisonCancelledError extends Error {
  constructor() {
    super("Comparison cancelled.");
    this.name = "ComparisonCancelledError";
  }
}

/**
 * Runs one comparison in a worker thread and resolves with the report.
 *
 * The input is Decimal-encoded on the way in and decoded on the way out
 * (see transfer.ts) -- a structured clone would otherwise strip Decimal's
 * prototype and leave money values as inert objects.
 */
export function runComparisonInWorker(
  input: CompareJobInput,
  options: RunInWorkerOptions = {}
): Promise<CompareReport> {
  const { file, execArgv } = workerEntry();

  return new Promise<CompareReport>((resolve, reject) => {
    const worker = new Worker(file, {
      workerData: encodeForTransfer(input),
      ...(execArgv ? { execArgv } : {}),
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      fn();
    };

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") {
        options.onProgress?.(message.update);
        return;
      }
      if (message.type === "done") {
        const report = decodeAfterTransfer<CompareReport>(message.report);
        finish(() => resolve(report));
        return;
      }
      finish(() => reject(new Error(message.message)));
    });

    worker.on("error", (err) => finish(() => reject(err)));

    worker.on("exit", (code) => {
      // A worker terminated by a cancel request exits before sending
      // anything; only treat an exit as a failure if nothing settled it.
      if (settled) return;
      settled = true;
      reject(code === 0 ? new ComparisonCancelledError() : new Error(`Comparison worker exited with code ${code}.`));
    });

    options.onStart?.(worker);
  });
}
