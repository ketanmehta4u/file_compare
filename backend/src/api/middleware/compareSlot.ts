import type { NextFunction, Request, Response } from "express";
import { compareQueueTimeoutMs, maxConcurrentComparisons } from "../../config/env";
import { log } from "./requestLog";
import { currentUser } from "./currentUser";

/**
 * Process-wide cap on simultaneous comparisons -- the same concurrency
 * gate added to the original Python app's shared-VM hardening pass,
 * ported to this Node backend. `/api/compare/run` runs synchronously in
 * Express's single-threaded event loop, but the underlying engine work is
 * CPU-heavy; without a cap, N concurrent large comparisons is N times the
 * peak memory the engine holds per run.
 *
 * Implemented as a small counting semaphore with a queue timeout: callers
 * beyond the cap wait for a slot, and only get a 503 if none frees up
 * within COMPARE_QUEUE_TIMEOUT_S. Read at startup (a fixed-size semaphore
 * can't be resized), so MAX_CONCURRENT_COMPARISONS needs a restart to
 * change; the queue timeout is read per call and can be tuned live.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.available > 0) {
      this.available--;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(onGranted);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      const onGranted = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(onGranted);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}

const totalSlots = maxConcurrentComparisons();
const semaphore = new Semaphore(totalSlots);

/** How many comparisons may run at once. */
export function compareSlotCount(): number {
  return totalSlots;
}

/**
 * Programmatic access to the same gate the middleware uses, for work that
 * outlives its HTTP request. A queued comparison job holds a slot for as
 * long as it actually runs, not just until the POST that created it
 * responds -- releasing on response-finish (as the middleware does) would
 * free the slot immediately and let the cap be exceeded.
 *
 * Every acquire that returns true must be paired with exactly one
 * release, including on the failure and cancellation paths.
 */
export function acquireCompareSlot(timeoutMs = compareQueueTimeoutMs()): Promise<boolean> {
  return semaphore.acquire(timeoutMs);
}

export function releaseCompareSlot(): void {
  semaphore.release();
}

export async function compareSlot(req: Request, res: Response, next: NextFunction): Promise<void> {
  const waitedFrom = performance.now();
  const acquired = await semaphore.acquire(compareQueueTimeoutMs());
  if (!acquired) {
    log.warn(
      {
        ctx_request_id: req.requestId,
        ctx_user: currentUser(req),
        ctx_waited_ms: Math.round(performance.now() - waitedFrom),
        ctx_slots: totalSlots,
      },
      "compare.rejected_busy"
    );
    res
      .status(503)
      .set("Retry-After", "60")
      .json({
        detail: `Server busy — ${totalSlots} comparison(s) already running and the queue did not clear in time. Please retry shortly.`,
      });
    return;
  }

  const queuedMs = Math.round(performance.now() - waitedFrom);
  if (queuedMs > 0) {
    log.info(
      {
        ctx_request_id: req.requestId,
        ctx_user: currentUser(req),
        ctx_queued_ms: queuedMs,
        ctx_slots: totalSlots,
      },
      "compare.slot_acquired"
    );
  }

  // Both "finish" and "close" can fire for the same request (close often
  // follows finish once the socket tears down) -- guard against releasing
  // the same slot twice, which would silently let one extra comparison
  // past the intended cap.
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    semaphore.release();
  };
  res.on("finish", releaseOnce);
  res.on("close", releaseOnce);
  next();
}
