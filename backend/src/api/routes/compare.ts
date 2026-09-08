import Decimal from "decimal.js";
import { Router } from "express";
import { fileCache, catalogCache, runCache, newRunId } from "../../cache/stores";
import {
  applyMapping,
  getMappingFor,
  mappingFromPairs,
  validateColumnsAgainstMapping,
} from "../../engine/catalog";
import { runComparisonInWorker } from "../../worker/runInWorker";
import { startCompareJob, getJob, cancelJob } from "../compareJobs";
import { defaultSettings } from "../../engine/types";
import type { ColumnMapping, CompareReport, CompareSettings, FileMeta, Table } from "../../engine/types";
import { buildExcelReport, EXCEL_MAX_ROWS } from "../../engine/report/buildExcelReport";
import { annotateForExcel, diffCellsForAnnotated, buildAnnotatedExcel } from "../../engine/report/annotate";
import { compareRateLimit, downloadRateLimit } from "../middleware/rateLimit";
import { acquireCompareSlot, releaseCompareSlot, compareSlotCount } from "../middleware/compareSlot";
import { currentUser } from "../middleware/currentUser";
import { compareToResponse } from "../toView";
import type { CompareRequest, CompareResultResponse, WriteToBlobResponse } from "../dto";
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

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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

    let srcTable: Table = srcCached.table;
    let srcMeta: FileMeta = srcCached.meta;
    let tgtTable: Table = tgtCached.table;
    let tgtMeta: FileMeta = tgtCached.meta;
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
      ({ table: srcTable, meta: srcMeta } = applyMapping(srcTable, srcMeta, "source", mapping, body.drop_unmapped ?? false));
      ({ table: tgtTable, meta: tgtMeta } = applyMapping(tgtTable, tgtMeta, "target", mapping, body.drop_unmapped ?? false));
    } else if (body.catalog_id && body.dataset_id) {
      const catCached = catalogCache.get(body.catalog_id);
      if (!catCached) throw new HttpError(404, "Catalog not in cache — re-upload.");
      mapping = getMappingFor(catCached.catalog, body.dataset_id);
      complianceWarnings = [
        ...validateColumnsAgainstMapping(srcMeta, mapping, "source"),
        ...validateColumnsAgainstMapping(tgtMeta, mapping, "target"),
      ];
      ({ table: srcTable, meta: srcMeta } = applyMapping(srcTable, srcMeta, "source", mapping, body.drop_unmapped ?? false));
      ({ table: tgtTable, meta: tgtMeta } = applyMapping(tgtTable, tgtMeta, "target", mapping, body.drop_unmapped ?? false));
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
        throw new HttpError(400, `enforced_dtypes[${JSON.stringify(col)}] must be 'id' or 'timestamp', got ${JSON.stringify(kind)}.`);
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
        source: srcTable,
        sourceMeta: srcMeta,
        target: tgtTable,
        targetMeta: tgtMeta,
        settings,
        mapping,
        user,
      },
      complianceWarnings,
    };
  }
}

/** Caches a finished run so its report and annotated downloads stay
 * available, and shapes the HTTP response. */
function storeRun(report: CompareReport, input: CompareJobInput, complianceWarnings: string[]): CompareResultResponse {
  const runId = newRunId();
  runCache.set(runId, {
    report,
    sourceTable: input.source,
    targetTable: input.target,
    sourceMeta: input.sourceMeta,
    targetMeta: input.targetMeta,
    mapping: input.mapping,
    cachedAt: Date.now(),
  });
  return compareToResponse(report, runId, complianceWarnings);
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
compareRouter.post("/compare/run", compareRateLimit, async (req, res, next) => {
  let slotHeld = false;
  try {
    const { input, complianceWarnings } = prepareCompare(req.body as CompareRequest, currentUser(req));

    slotHeld = await acquireCompareSlot();
    if (!slotHeld) {
      return res.status(503).set("Retry-After", "60").json({
        detail:
          `Server busy — ${compareSlotCount()} comparison(s) already running and ` +
          "the queue did not clear in time. Please retry shortly.",
      });
    }

    const report = await runComparisonInWorker(input);
    res.json(storeRun(report, input, complianceWarnings));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.message });
    if (err instanceof Error) return res.status(400).json({ detail: err.message });
    next(err);
  } finally {
    if (slotHeld) releaseCompareSlot();
  }
});

/** Starts a comparison in the background and hands back a job id to poll. */
compareRouter.post("/compare/jobs", compareRateLimit, (req, res, next) => {
  try {
    const user = currentUser(req);
    const { input, complianceWarnings } = prepareCompare(req.body as CompareRequest, user);
    const job = startCompareJob(input, { user, requestId: req.requestId, complianceWarnings });
    res.status(202).json({ job_id: job.id, status: job.status });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.message });
    if (err instanceof Error) return res.status(400).json({ detail: err.message });
    next(err);
  }
});

/** Live progress for a job, and the full result once it has finished. */
compareRouter.get("/compare/jobs/:jobId", (req, res) => {
  const job = getJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ detail: "Job not found — it may have expired." });
  res.json({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.status === "done" ? job.result : null,
    detail: job.error,
  });
});

/** Cancels a queued or running job. */
compareRouter.delete("/compare/jobs/:jobId", (req, res) => {
  const id = String(req.params.jobId);
  const job = getJob(id);
  if (!job) return res.status(404).json({ detail: "Job not found — it may have expired." });
  const cancelled = cancelJob(id);
  res.json({ job_id: id, status: cancelled ? "cancelled" : job.status, cancelled });
});

function getRunOr404(runId: string) {
  const cached = runCache.get(runId);
  if (!cached) throw new HttpError(404, "Run not found — it may have been evicted.");
  return cached;
}

compareRouter.get("/compare/:runId/report.xlsx", downloadRateLimit, async (req, res, next) => {
  try {
    const cached = getRunOr404(String(req.params.runId));
    const { buffer } = await buildExcelReport(cached.report);
    const fname = `reconciliation_${cached.report.audit.source.sha256.slice(0, 8)}_${cached.report.audit.target.sha256.slice(0, 8)}.xlsx`;
    res.set("Content-Type", XLSX_MIME).set("Content-Disposition", `attachment; filename="${fname}"`).send(buffer);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

compareRouter.get("/compare/:runId/annotated/:side", downloadRateLimit, async (req, res, next) => {
  try {
    const side = String(req.params.side);
    if (side !== "source" && side !== "target") {
      return res.status(400).json({ detail: "side must be 'source' or 'target'." });
    }
    const cached = getRunOr404(String(req.params.runId));
    const table = side === "source" ? cached.sourceTable : cached.targetTable;
    const meta = side === "source" ? cached.sourceMeta : cached.targetMeta;

    const annotated = annotateForExcel(table, side, cached.report, cached.report.audit.settings);
    const base = (meta.name.includes(".") ? meta.name.slice(0, meta.name.lastIndexOf(".")) : meta.name) + "_annotated";

    if (annotated.rows.length + 1 <= EXCEL_MAX_ROWS) {
      const cells = diffCellsForAnnotated(annotated, cached.report, cached.report.audit.settings);
      const buffer = await buildAnnotatedExcel(annotated, side, cells);
      res.set("Content-Type", XLSX_MIME).set("Content-Disposition", `attachment; filename="${base}.xlsx"`).send(buffer);
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
      const text = chunk.map((row) => annotated.columns.map((c) => escape(row[c])).join(",")).join("\n") + "\n";
      res.write(text);
    }
    res.end();
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// Blob storage is out of scope for this port -- literal stub matching the
// original's already-disabled state.
compareRouter.post("/compare/:runId/write-to-blob", compareRateLimit, (_req, res) => {
  const body: WriteToBlobResponse = { written: [], failed: [] };
  res.status(400).json({ detail: "Azure Storage is disabled on this server.", ...body });
});
