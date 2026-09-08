import { LRUCache } from "lru-cache";
import type { ColumnMapping, DatasetCatalog, FileMeta, Table } from "../engine/types";
import type { CompareReport } from "../engine/types";

export interface CachedFile {
  table: Table;
  meta: FileMeta;
  cachedAt: number;
}

export interface CachedCatalog {
  catalog: DatasetCatalog;
  cachedAt: number;
}

export interface CachedRun {
  report: CompareReport;
  sourceTable: Table;
  targetTable: Table;
  sourceMeta: FileMeta;
  targetMeta: FileMeta;
  mapping: ColumnMapping | null;
  cachedAt: number;
}

/**
 * Sizing carried over from the original Python app's multi-user review
 * (backend/cache.py there): run_cache is the dominant memory consumer
 * because a CachedRun pins both post-mapping tables for the annotated
 * downloads, so it's kept smallest; catalog_cache holds the lightest
 * objects (column definitions, not row data) so it's kept largest to
 * avoid one user's uploads evicting another's mid-session; file_cache
 * sits in between, keyed by content SHA-256 so identical files across
 * users share one entry rather than duplicating it.
 *
 * Single-process only, same caveat as the original: these are in-memory
 * module-level singletons. Running multiple Node processes (PM2 cluster
 * mode, multiple container replicas) breaks cache lookups the same way
 * Python multi-worker did -- a file uploaded to process A is invisible
 * to process B.
 */
export const fileCache = new LRUCache<string, CachedFile>({ max: 50 });
export const catalogCache = new LRUCache<string, CachedCatalog>({ max: 60 });
export const runCache = new LRUCache<string, CachedRun>({ max: 10 });

export function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
