import iconv from "iconv-lite";
import Papa from "papaparse";
import { toDecimal } from "../decimal";
import { parseDate } from "../dates";
import type { FileMeta, Table } from "../types";
import { sha256Hex } from "./hash";
import { InputError } from "../errors";

/** Port of comparison.py's ENCODING_CANDIDATES tried in
 * `_decode_with_fallback`. Note: "utf-8-sig" and "utf-8" have identical
 * success/failure behaviour for any given byte sequence in Python -- the
 * only difference is BOM stripping -- so "utf-8-sig" (tried first) always
 * wins for any input plain "utf-8" would also accept. Ported as a single
 * strict-UTF-8 attempt with BOM stripping, reporting "utf-8-sig" when a
 * BOM was present and "utf-8" otherwise, then windows-1252, then
 * iso-8859-1 (which accepts any byte sequence and therefore never fails). */
export function decodeWithFallback(data: Buffer): { text: string; encoding: string } {
  try {
    // ignoreBOM: true is required here -- TextDecoder strips a leading BOM
    // automatically by default, which would make this check never fire.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    if (text.charCodeAt(0) === 0xfeff) {
      return { text: text.slice(1), encoding: "utf-8-sig" };
    }
    return { text, encoding: "utf-8" };
  } catch {
    // fall through
  }
  try {
    return { text: iconv.decode(data, "windows-1252"), encoding: "cp1252" };
  } catch {
    // fall through -- iso-8859-1 below never throws
  }
  return { text: iconv.decode(data, "iso-8859-1"), encoding: "latin-1" };
}

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];

/**
 * Port of comparison.py's `_sniff_delimiter`, heuristic branch only. The
 * source tries Python's `csv.Sniffer()` first and falls back to this
 * heuristic on `csv.Error` -- replicating `csv.Sniffer()`'s dialect
 * detection exactly has no direct JS equivalent, and the source's own
 * design already treats this heuristic as an acceptable fallback, so it's
 * used here as the sole method. For each candidate: score = count*10 if
 * the candidate appears a consistent non-zero number of times across every
 * sampled line (strong signal), else score = the raw total count (weak
 * signal); highest score wins, ties broken by candidate order, default ",".
 */
export function sniffDelimiter(sample: string): string {
  const lines = sample.split(/\r\n|\r|\n/).slice(0, 10);
  if (lines.length === 0) return ",";
  const scores = new Map<string, number>();
  for (const d of DELIMITER_CANDIDATES) {
    const counts = lines.filter((ln) => ln !== "").map((ln) => ln.split(d).length - 1);
    if (counts.length === 0) continue;
    const min = Math.min(...counts);
    const allSame = counts.every((c) => c === counts[0]);
    if (min > 0 && allSame) {
      scores.set(d, counts[0] * 10);
    } else {
      const sum = counts.reduce((a, b) => a + b, 0);
      if (sum > 0) scores.set(d, sum);
    }
  }
  if (scores.size === 0) return ",";
  let best = DELIMITER_CANDIDATES[0];
  let bestScore = -1;
  for (const d of DELIMITER_CANDIDATES) {
    const s = scores.get(d) ?? -1;
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return best;
}

/** Port of comparison.py's `_post_load_cleanup`: pandas auto-names a blank
 * header cell "Unnamed: N" (0-based N); this renames those to
 * "(blank_N)" and disambiguates duplicate column names with __2, __3, ... */
export function cleanupColumnNames(rawColumns: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const result: string[] = [];
  rawColumns.forEach((raw, i) => {
    const name = raw === "" ? `Unnamed: ${i}` : raw;
    const cleaned = name.startsWith("Unnamed:") ? `(blank_${name.split(":").pop()!.trim()})` : name;
    const count = seen.get(cleaned) ?? 0;
    seen.set(cleaned, count + 1);
    result.push(count === 0 ? cleaned : `${cleaned}__${count + 1}`);
  });
  return result;
}

export function inferColumnDtype(values: readonly string[]): "numeric" | "date" | "text" | "empty" {
  const sample = values.filter((v) => v !== "" && v !== undefined && v !== null).slice(0, 50);
  if (sample.length === 0) return "empty";
  const numericHits = sample.filter((v) => toDecimal(v) !== null).length;
  if (numericHits >= Math.max(1, Math.floor(0.8 * sample.length))) return "numeric";
  const dateHits = sample.filter((v) => parseDate(v) !== null).length;
  if (dateHits >= Math.max(1, Math.floor(0.8 * sample.length))) return "date";
  return "text";
}

export interface LoadCsvOptions {
  hasHeader?: boolean;
  delimiter?: string | null;
}

/**
 * Port of comparison.py's `load_csv`. Every column is read as a raw
 * string -- normalisation (currency/date/etc.) happens later via
 * normaliseCell, never here. Only a truly-empty field is treated as
 * missing (an empty string, matching pandas' `na_values=[""]` combined
 * with `keep_default_na=False`); other tokens like "NA"/"null" are left
 * as literal text for normaliseCell to interpret.
 */
export function loadCsv(
  data: Buffer,
  fileName: string,
  options: LoadCsvOptions = {}
): { table: Table; meta: FileMeta } {
  if (data.length === 0) throw new InputError(`${fileName}: file is empty (0 bytes).`);

  const hasHeader = options.hasHeader ?? true;
  const { text, encoding } = decodeWithFallback(data);
  const delimiter = options.delimiter ?? sniffDelimiter(text.slice(0, 8192));

  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    skipEmptyLines: false,
    newline: undefined, // auto-detect
  });

  let rawRows = parsed.data.filter((r) => !(r.length === 1 && r[0] === ""));
  if (rawRows.length === 0) {
    const meta: FileMeta = {
      name: fileName,
      sha256: sha256Hex(data),
      sizeBytes: data.length,
      rowCount: 0,
      columnCount: 0,
      columns: [],
      dtypes: [],
      encoding,
      delimiter,
      hasHeader,
    };
    return { table: { columns: [], rows: [] }, meta };
  }

  let headerRow: string[];
  let dataRows: string[][];
  if (hasHeader) {
    headerRow = rawRows[0];
    dataRows = rawRows.slice(1);
  } else {
    const width = Math.max(...rawRows.map((r) => r.length));
    headerRow = Array.from({ length: width }, (_, i) => `col_${i + 1}`);
    dataRows = rawRows;
  }

  const columns = hasHeader ? cleanupColumnNames(headerRow) : headerRow;
  const rows: Array<Record<string, unknown>> = dataRows.map((r) => {
    const row: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      row[c] = r[i] ?? "";
    });
    return row;
  });

  const dtypes: Array<readonly [string, string]> = columns.map((c) => [
    c,
    inferColumnDtype(rows.map((r) => String(r[c] ?? ""))),
  ]);

  const meta: FileMeta = {
    name: fileName,
    sha256: sha256Hex(data),
    sizeBytes: data.length,
    rowCount: rows.length,
    columnCount: columns.length,
    columns,
    dtypes,
    encoding,
    delimiter,
    hasHeader,
  };

  return { table: { columns, rows }, meta };
}
