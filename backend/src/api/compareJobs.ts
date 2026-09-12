import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { LRUCache } from "lru-cache";
import { runCache, newRunId } from "../cache/stores";
import { runComparisonInWorker, ComparisonCancelledError } from "../worker/runInWorker";
import { compareToResponse } from "./toView";
import { acquireCompareSlot, releaseCompareSlot, compareSlotCount } from "./middleware/compareSlot";
import { log } from "./middleware/requestLog";
import { PHASE_LABELS, type ProgressUpdate } from "../engine/progress";
import type { CompareJobInput } from "../worker/compareWorker";
import type { CompareResultResponse } from "./dto";

/**
 * Tracks comparisons that outlive the request that started them, so the UI
 * can show live progress instead of holding one HTTP connection open for
 * the length of the run.
 *
 * Jobs live in memory alongside the other caches, with the same
 * single-process caveat (see cache/stores.ts).
 */

export interface JobContext {
  user: string;
  requestId?: string;
  complianceWarnings: string[];
  /** Kept so a finished run can point the annotated downloads back at the
   * cached uploads instead of pinning parsed tables. */
  sourceFileId: string;
  targetFileId: string;
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobProgress {
  phase: string;
  label: string;
  done: number;
  total: number;
  /** 0-100 across the whole run, or null while a phase has no known total. */
  percent: number | null;
}

export interface CompareJob {
  id: string;
  status: JobStatus;
  progress: JobProgress | null;
  result: CompareResultResponse | null;
  error: string | null;
  user: string;
  createdAt: number;
  updatedAt: number;
  worker: Worker | null;
}

/**
 * Weighting used to turn per-phase counts into one overall percentage.
 * Rough by design, but proportioned from a measured run rather than
 * guessed: on a 150k-row keyed comparison the split was roughly 12%
 * indexing, 48% matching-and-comparing, 40% footing the control totals
 * (which re-normalises every cell of every numeric column on both sides).
 * An earlier weighting that treated control totals as a 3% tail left the
 * bar sitting at 95% for the better part of a minute.
 */
const PHASE_WEIGHTS: Record<string, { start: number; span: number }> = {
  indexing_source: { start: 0, span: 10 },
  indexing_target: { start: 10, span: 10 },
  matching: { start: 20, span: 2 },
  comparing: { start: 22, span: 38 },
  control_totals: { start: 60, span: 37 },
  reporting: { start: 97, span: 3 },
};

function toJobProgress(u: ProgressUpdate): JobProgress {
  const weight = PHASE_WEIGHTS[u.phase];
  let percent: number | null = null;
  if (weight) {
    const within = u.total > 0 ? Math.min(1, u.done / u.total) : 0;
    percent = Math.min(100, Math.round(weight.start + within * weight.span));
  }
  return {
    phase: u.phase,
    label: PHASE_LABELS[u.phase as keyof typeof PHASE_LABELS] ?? u.phase,
    done: u.done,
    total: u.total,
    percent,
  };
}

/** Finished jobs are kept briefly so the UI can collect the result after
 * its last progress poll; the cap bounds memory the same way runCache
 * does, since a done job holds a full response. */
const jobs = new LRUCache<string, CompareJob>({ max: 40, ttl: 30 * 60 * 1000 });

export function getJob(id: string): CompareJob | undefined {
  return jobs.get(id);
}

export function jobCount(): number {
  return jobs.size;
}

/**
 * Starts a comparison in the background and returns its job id
 * immediately. The concurrency slot is acquired inside the job, so a
 * queued job reports "queued" rather than blocking the caller.
 */
export function startCompareJob(input: CompareJobInput, ctx: JobContext): CompareJob {
  const job: CompareJob = {
    id: randomUUID().replace(/-/g, "").slice(0, 16),
    status: "queued",
    progress: null,
    result: null,
    error: null,
    user: ctx.user,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    worker: null,
  };
  jobs.set(job.id, job);

  void run(job, input, ctx);
  return job;
}

async function run(job: CompareJob, input: CompareJobInput, ctx: JobContext): Promise<void> {
  const queuedFrom = performance.now();
  const acquired = await acquireCompareSlot();
  if (!acquired) {
    touch(job, {
      status: "error",
      error:
        `Server busy — ${compareSlotCount()} comparison(s) already running and ` +
        "the queue did not clear in time. Please retry shortly.",
    });
    return;
  }

  // Cancelled while it sat in the queue: give the slot straight back.
  if (job.status === "cancelled") {
    releaseCompareSlot();
    return;
  }

  touch(job, { status: "running" });
  log.info(
    {
      ctx_request_id: ctx.requestId,
      ctx_user: ctx.user,
      ctx_job: job.id,
      ctx_queued_ms: Math.round(performance.now() - queuedFrom),
    },
    "compare.job_started"
  );

  const startedAt = performance.now();
  try {
    const outcome = await runComparisonInWorker(input, {
      onProgress: (u) => touch(job, { progress: toJobProgress(u) }),
      onStart: (worker) => {
        job.worker = worker;
      },
    });

    const runId = newRunId();
    runCache.set(runId, {
      report: outcome.report,
      sourceFileId: ctx.sourceFileId,
      targetFileId: ctx.targetFileId,
      sourceMeta: outcome.sourceMeta,
      targetMeta: outcome.targetMeta,
      mapping: input.mapping,
      dropUnmapped: input.dropUnmapped,
      annotatedOutputs: input.annotatedOutputs,
      cachedAt: Date.now(),
    });

    touch(job, {
      status: "done",
      result: compareToResponse(outcome.report, runId, ctx.complianceWarnings, input.annotatedOutputs),
      progress: { phase: "done", label: "Complete", done: 1, total: 1, percent: 100 },
    });
    log.info(
      {
        ctx_request_id: ctx.requestId,
        ctx_user: ctx.user,
        ctx_job: job.id,
        ctx_duration_ms: Math.round(performance.now() - startedAt),
      },
      "compare.job_done"
    );
  } catch (err) {
    if (err instanceof ComparisonCancelledError || statusOf(job) === "cancelled") {
      touch(job, { status: "cancelled", error: null });
    } else {
      touch(job, { status: "error", error: err instanceof Error ? err.message : String(err) });
      log.warn({ ctx_request_id: ctx.requestId, ctx_job: job.id, err: String(err) }, "compare.job_failed");
    }
  } finally {
    job.worker = null;
    releaseCompareSlot();
  }
}

/**
 * Reads the status through a call so the compiler does not carry an
 * earlier narrowing across the await: cancelJob() mutates the job from
 * outside this flow, so "cancelled" really is reachable here even where
 * control-flow analysis has ruled it out.
 */
function statusOf(job: CompareJob): JobStatus {
  return job.status;
}

function touch(job: CompareJob, patch: Partial<CompareJob>): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
  // Re-set so the LRU treats an actively-updating job as recently used and
  // does not evict a long run out from under its own progress polling.
  jobs.set(job.id, job);
}

/** Stops a running or queued job. Returns false if there was nothing to
 * stop (already finished, or no such job). */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") return false;

  const worker = job.worker;
  touch(job, { status: "cancelled" });
  if (worker) void worker.terminate();
  return true;
}
