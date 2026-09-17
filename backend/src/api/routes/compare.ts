import Decimal from "decimal.js";
import { Router, type Request } from "express";
import { fileCache, catalogCache, runCache, newRunId } from "../../cache/stores";
import {
  applyMapping,
  getMappingFor,
  mappingFromPairs,
  validateColumnsAgainstMapping,
} from "../../engine/catalog";
import { loadBytes } from "../../engine/fileLoad/loadBytes";
import { runComparisonInWorker, type WorkerComparison } from "../../worker/runInWorker";
import { startCompareJob, getJob, cancelJob } from "../compareJobs";
import { defaultSettings } from "../../engine/types";
import type { ColumnMapping, CompareReport, CompareSettings, FileMeta, Table } from "../../engine/types";
import { EXCEL_MAX_ROWS, ReportAbortedError, writeExcelReport } from "../../engine/report/buildExcelReport";
import { annotateForExcel, diffCellsForAnnotated, buildAnnotatedExcel } from "../../engine/report/annotate";
import { compareRateLimit, downloadRateLimit } from "../middleware/rateLimit";
import { acquireCompareSlot, releaseCompareSlot, compareSlotCount } from "../middleware/compareSlot";
import { currentUser } from "../middleware/currentUser";
import { currentSession } from "../middleware/session";
import { runIsolationEnabled } from "../../config/env";
import { compareToResponse } from "../toView";
import { compareRequestSchema } from "../schemas";
import { HttpError, respondWithError } from "../errors";
import { log } from "../middleware/requestLog";
import type { CompareRequest, CompareResultResponse } from "../dto";
import type { CompareJobInput } from "../../worker/compareWorker";

export const compareRouter = Router();

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function parseTolerance(raw: string | undefined): Decimal {
  const s = (raw ?? "").trim();
  if (s === "") return new Decimal(0);
  let d: Decimal;
  try {
    d = new Decimal(s);
  } catch {
    throw new HttpError(400, `numeric_tolerance not a decimal: ${JSON.stringify(s)}`);
  }
  if (d.isNegative()) throw new HttpError(400, "numeric_tolerance must be non-negative.");
  return d;
}

function getFileOr404(fileId: string, side: string) {
  const cached = fileCache.get(fileId);
  if (!cached) throw new HttpError(404, `${side} file not in cache — re-upload.`);
  return cached;
}

/**
 * Turns a compare request into everything the engine needs: the two
 * post-mapping tables, the settings, and any catalogue compliance
 * warnings. Shared by the synchronous route and the job route so the two
 * cannot drift apart. Throws HttpError for anything the caller got wrong.
 */
function prepareCompare(
  body: CompareRequest,
  user: string
): { input: CompareJobInput; complianceWarnings: string[] } {
  {
    const srcCached = getFileOr404(body.source_file_id, "Source");
    const tgtCached = getFileOr404(body.target_file_id, "Target");

    // Only the cached *metadata* is consulted here. Parsing and mapping
    // both happen in the worker, from the cached bytes, so no table is
    // ever built on this thread.
    const srcMeta: FileMeta = srcCached.meta;
    const tgtMeta: FileMeta = tgtCached.meta;
    let mapping: ColumnMapping | null = null;
    let complianceWarnings: string[] = [];

    const columnMap = body.column_map ?? {};
    if (Object.keys(columnMap).length > 0) {
      const pairs = new Map(Object.entries(columnMap).filter(([, t]) => t));
      const targets = [...pairs.values()];
      if (new Set(targets).size !== targets.length) {
        throw new HttpError(400, "Each target column can be mapped from at most one source column.");
      }
      mapping = mappingFromPairs(pairs);
    } else if (body.catalog_id && body.dataset_id) {
      const catCached = catalogCache.get(body.catalog_id);
      if (!catCached) throw new HttpError(404, "Catalog not in cache — re-upload.");
      mapping = getMappingFor(catCached.catalog, body.dataset_id);
      complianceWarnings = [
        ...validateColumnsAgainstMapping(srcMeta, mapping, "source"),
        ...validateColumnsAgainstMapping(tgtMeta, mapping, "target"),
      ];
    }

    if (body.decimal_precision != null && body.decimal_precision < 0) {
      throw new HttpError(400, "decimal_precision must be >= 0.");
    }

    const enforced = new Map<string, "id" | "timestamp">();
    if (mapping) {
      for (const e of mapping.entries) {
        const kind = (e.dtype ?? "").trim().toLowerCase();
        if (kind === "id" || kind === "timestamp") enforced.set(e.canonicalName, kind);
      }
    }
    for (const [col, kind] of Object.entries(body.enforced_dtypes ?? {})) {
      const k = kind.trim().toLowerCase();
      if (k !== "id" && k !== "timestamp") {
        throw new HttpError(
          400,
          `enforced_dtypes[${JSON.stringify(col)}] must be 'id' or 'timestamp', got ${JSON.stringify(kind)}.`
        );
      }
      enforced.set(col, k);
    }

    const settings: CompareSettings = defaultSettings({
      keyColumns: body.key_columns ?? [],
      caseSensitive: body.case_sensitive ?? true,
      trimWhitespace: body.trim_whitespace ?? true,
      numericTolerance: parseTolerance(body.numeric_tolerance),
      decimalPrecision: body.decimal_precision ?? null,
      treatBlankAsZero: body.treat_blank_as_zero ?? false,
      fuzzyColumnNames: body.fuzzy_column_names ?? false,
      controlTotalColumns: body.control_total_columns ?? [],
      enforcedDtypes: enforced,
    });

    return {
      input: {
        source: { bytes: srcCached.bytes, fileName: srcMeta.name, load: srcCached.load },
        target: { bytes: tgtCached.bytes, fileName: tgtMeta.name, load: tgtCached.load },
        settings,
        mapping,
        dropUnmapped: body.drop_unmapped ?? false,
        user,
        // Defaults on, so an existing caller that says nothing keeps the
        // behaviour it had.
        annotatedOutputs: body.annotated_outputs ?? true,
      },
      complianceWarnings,
    };
  }
}

/** Caches a finished run so its report and annotated downloads stay
 * available, and shapes the HTTP response. */
export function storeRun(
  outcome: WorkerComparison,
  body: CompareRequest,
  input: CompareJobInput,
  complianceWarnings: string[],
  session: string
): CompareResultResponse {
  const runId = newRunId();
  runCache.set(runId, {
    report: outcome.report,
    // File ids, not tables: an annotated download re-parses from the file
    // cache instead of this cache pinning two full tables per run.
    sourceFileId: body.source_file_id,
    targetFileId: body.target_file_id,
    sourceMeta: outcome.sourceMeta,
    targetMeta: outcome.targetMeta,
    mapping: input.mapping,
    dropUnmapped: input.dropUnmapped,
    annotatedOutputs: input.annotatedOutputs,
    session,
    cachedAt: Date.now(),
  });
  return compareToResponse(outcome.report, runId, complianceWarnings, input.annotatedOutputs);
}

/**
 * Synchronous comparison -- unchanged contract: one request, the whole
 * result. The engine now runs in a worker thread, so a long run no longer
 * blocks this process; health checks, uploads and other users' requests
 * keep being served while it works. The concurrency slot is taken here
 * rather than by the compareSlot middleware so it is held for the actual
 * work rather than merely until this response finishes.
 *
 * For a large comparison prefer POST /compare/jobs, which returns
 * immediately and reports live progress instead of holding a connection
 * open for minutes.
 */
compareRouter.post("/compare/run", compareRateLimit, async (req, res) => {
  let slotHeld = false;
  try {
    const body = compareRequestSchema.parse(req.body) as CompareRequest;
    const { input, complianceWarnings } = prepareCompare(body, currentUser(req));

    slotHeld = await acquireCompareSlot();
    if (!slotHeld) {
      return res
        .status(503)
        .set("Retry-After", "60")
        .json({
          detail:
            `Server busy — ${compareSlotCount()} comparison(s) already running and ` +
            "the queue did not clear in time. Please retry shortly.",
        });
    }

    const outcome = await runComparisonInWorker(input);
    res.json(storeRun(outcome, body, input, complianceWarnings, currentSession(req)));
  } catch (err) {
    respondWithError(req, res, err);
  } finally {
    if (slotHeld) releaseCompareSlot();
  }
});

/** Starts a comparison in the background and hands back a job id to poll. */
compareRouter.post("/compare/jobs", compareRateLimit, (req, res) => {
  try {
    const user = currentUser(req);
    const body = compareRequestSchema.parse(req.body) as CompareRequest;
    const { input, complianceWarnings } = prepareCompare(body, user);
    const job = startCompareJob(input, {
      user,
      session: currentSession(req),
      requestId: req.requestId,
      complianceWarnings,
      sourceFileId: body.source_file_id,
      targetFileId: body.target_file_id,
    });
    res.status(202).json({ job_id: job.id, status: job.status });
  } catch (err) {
    respondWithError(req, res, err);
  }
});

/** Live progress for a job, and the full result once it has finished. */
compareRouter.get("/compare/jobs/:jobId", (req, res) => {
  const job = getJob(String(req.params.jobId));
  if (!job || !ownsJob(job, req)) {
    return res.status(404).json({ detail: "Job not found — it may have expired." });
  }
  res.json({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.status === "done" ? job.result : null,
    detail: job.error,
  });
});

/** Whether this request's browser is the one that started the job. Same
 * reasoning as getRunOr404: a job that is not yours reads as missing. */
function ownsJob(job: { session: string }, req: Request): boolean {
  return !runIsolationEnabled() || job.session === currentSession(req);
}

/** Cancels a queued or running job. */
compareRouter.delete("/compare/jobs/:jobId", (req, res) => {
  const id = String(req.params.jobId);
  const job = getJob(id);
  if (!job || !ownsJob(job, req)) {
    return res.status(404).json({ detail: "Job not found — it may have expired." });
  }
  const cancelled = cancelJob(id);
  res.json({ job_id: id, status: cancelled ? "cancelled" : job.status, cancelled });
});

/**
 * A run belongs to the browser session that produced it (see
 * api/middleware/session.ts). Another session is answered 404 rather than
 * 403: this deployment is shared and anonymous, so to anyone else the run
 * may as well not exist, and "forbidden" would confirm the id is real.
 */
function getRunOr404(runId: string, session: string) {
  const cached = runCache.get(runId);
  const notFound = new HttpError(404, "Run not found — it may have been evicted.");
  if (!cached) throw notFound;
  if (runIsolationEnabled() && cached.session !== session) throw notFound;
  return cached;
}

// Streamed: the workbook is written into the response as it is built, so a
// multi-million-row result is never held whole in memory, and nothing is
// dropped -- rows beyond one sheet's limit continue on further sheets.
compareRouter.get("/compare/:runId/report.xlsx", downloadRateLimit, async (req, res) => {
  let cached;
  try {
    cached = getRunOr404(String(req.params.runId), currentSession(req));
  } catch (err) {
    return respondWithError(req, res, err);
  }

  const fname = `reconciliation_${cached.report.audit.source.sha256.slice(0, 8)}_${cached.report.audit.target.sha256.slice(0, 8)}.xlsx`;
  res.set("Content-Type", XLSX_MIME).set("Content-Disposition", `attachment; filename="${fname}"`);
  try {
    await writeExcelReport(cached.report, res);
  } catch (err) {
    if (err instanceof ReportAbortedError) return; // the client went away; nothing to answer
    if (!res.headersSent) {
      res.removeHeader("Content-Disposition");
      return respondWithError(req, res, err);
    }
    // Part of the file has already gone out, so no error status can be sent.
    // Cutting the connection makes the download fail visibly, where ending it
    // normally would hand the user a truncated workbook as if it were whole.
    log.error(
      {
        ctx_request_id: req.requestId,
        ctx_path: req.originalUrl.split("?")[0],
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
      "report.stream_failed"
    );
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  }
});

compareRouter.get("/compare/:runId/annotated/:side", downloadRateLimit, async (req, res) => {
  try {
    const side = String(req.params.side);
    if (side !== "source" && side !== "target") {
      return res.status(400).json({ detail: "side must be 'source' or 'target'." });
    }
    const cached = getRunOr404(String(req.params.runId), currentSession(req));
    if (!cached.annotatedOutputs) {
      throw new HttpError(
        400,
        "Annotated files were not produced for this run — tick “Annotated source/target files” before running the comparison to enable them."
      );
    }
    const meta = side === "source" ? cached.sourceMeta : cached.targetMeta;

    // Re-parsed on demand from the cached upload rather than kept resident
    // for the life of the run: annotated downloads are occasional, and
    // holding two post-mapping tables per cached run was the process's
    // largest memory consumer. The table lives only for this response.
    const fileId = side === "source" ? cached.sourceFileId : cached.targetFileId;
    const file = fileCache.get(fileId);
    if (!file) {
      throw new HttpError(
        404,
        `The ${side} file is no longer cached, so it cannot be annotated — re-upload it and run the comparison again.`
      );
    }
    const loaded = await loadBytes(file.bytes, file.meta.name, file.load);
    const table = cached.mapping
      ? applyMapping(loaded.table, loaded.meta, side, cached.mapping, cached.dropUnmapped).table
      : loaded.table;

    const annotated = annotateForExcel(table, side, cached.report, cached.report.audit.settings);
    const base =
      (meta.name.includes(".") ? meta.name.slice(0, meta.name.lastIndexOf(".")) : meta.name) + "_annotated";

    if (annotated.rows.length + 1 <= EXCEL_MAX_ROWS) {
      const cells = diffCellsForAnnotated(annotated, cached.report, cached.report.audit.settings);
      const buffer = await buildAnnotatedExcel(annotated, side, cells);
      res
        .set("Content-Type", XLSX_MIME)
        .set("Content-Disposition", `attachment; filename="${base}.xlsx"`)
        .send(buffer);
      return;
    }

    // Oversize -> stream as CSV in chunks rather than buffering the whole
    // thing, matching the original's _stream_csv behaviour.
    res.set("Content-Type", "text/csv").set("Content-Disposition", `attachment; filename="${base}.csv"`);
    const escape = (v: unknown) => {
      const s = v === undefined || v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.write(annotated.columns.map(escape).join(",") + "\n");
    const CHUNK = 10_000;
    for (let i = 0; i < annotated.rows.length; i += CHUNK) {
      const chunk = annotated.rows.slice(i, i + CHUNK);
      const text =
        chunk.map((row) => annotated.columns.map((c) => escape(row[c])).join(",")).join("\n") + "\n";
      res.write(text);
    }
    res.end();
  } catch (err) {
    respondWithError(req, res, err);
  }
});
