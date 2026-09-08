import { LRUCache } from "lru-cache";
import type { ColumnMapping, DatasetCatalog, FileMeta } from "../engine/types";
import type { LoadOptions } from "../engine/fileLoad/loadBytes";
import { cacheBudgetBytes } from "../config/env";
import type { CompareReport } from "../engine/types";

export interface CachedFile {
  /** The uploaded bytes, kept instead of the parsed table: a parsed table
   * costs roughly 12x its source bytes (measured), so caching the parse
   * would make steady-state memory a large multiple of what users
   * actually uploaded. Consumers re-parse on demand -- about 200ms for a
   * 150k-row file, against comparisons measured in minutes. */
  bytes: Buffer;
  /** Metadata from the upload-time parse: columns, dtypes, row counts and
   * the hidden-data notices. Small, and what the UI needs. */
  meta: FileMeta;
  /** The options this file was read with, so every later parse of it
   * yields exactly the columns the user was shown. */
  load: LoadOptions;
  cachedAt: number;
}

export interface CachedCatalog {
  catalog: DatasetCatalog;
  cachedAt: number;
}

export interface CachedRun {
  report: CompareReport;
  /** File ids rather than the tables themselves. The annotated downloads
   * re-parse from fileCache when asked; pinning two post-mapping tables
   * per run made this cache the single largest memory consumer in the
   * process for data that was usually never downloaded. */
  sourceFileId: string;
  targetFileId: string;
  /** Post-mapping metadata (column names and dtypes only -- no rows). */
  sourceMeta: FileMeta;
  targetMeta: FileMeta;
  mapping: ColumnMapping | null;
  dropUnmapped: boolean;
  cachedAt: number;
}

/**
 * The file cache is keyed by content SHA-256, so identical files uploaded
 * by different users share one entry rather than duplicating it.
 *
 * Single-process only, same caveat as the original: these are in-memory
 * module-level singletons. Running multiple Node processes (PM2 cluster
 * mode, multiple container replicas) breaks cache lookups the same way
 * Python multi-worker did -- a file uploaded to process A is invisible
 * to process B.
 */
/**
 * The upload cache evicts on *bytes*, not entry count. Counting entries
 * said "50 files" whether those were 20 KB or 50 MB each, so a handful of
 * large uploads could exhaust memory long before any single-file limit
 * tripped. The budget follows the machine (see cacheBudgetBytes), so the
 * same build sizes itself sensibly on a laptop and inside a small
 * container.
 */
export const fileCache = new LRUCache<string, CachedFile>({
  maxSize: cacheBudgetBytes(),
  sizeCalculation: (value) => value.bytes.byteLength || 1,
});

export const catalogCache = new LRUCache<string, CachedCatalog>({ max: 60 });

/** Runs hold a report (whose size follows the number of differences found)
 * plus small metadata -- no row data from the input files any more. */
export const runCache = new LRUCache<string, CachedRun>({ max: 10 });

export function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
