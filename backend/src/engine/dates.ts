import { parse as parseDateFns, isValid } from "date-fns";

/**
 * Port of comparison.py's `_parse_date`/`_parse_datetime`. Verified against
 * source: Excel serial epoch is `datetime(1899, 12, 30)` (comparison.py
 * lines 1675 and 1752) -- deliberately reproduces Excel's fake 1900 leap
 * day rather than "fixing" it.
 *
 * Format list order encodes ambiguity resolution: ISO-like first, then
 * DMY numeric formats BEFORE MDY (so "03/04/2024" parses as 3 April, not
 * March 4), then month-name formats, then two ISO-datetime formats.
 * date-fns tokens: yyyy=4-digit year, M/MM=month, d/dd=day, MMM=short
 * month name, MMMM=full month name, H/HH=hour, mm=minute, ss=second.
 * Flexible (unpadded) tokens are used throughout to mirror Python's
 * strptime, which accepts both "5" and "05" for %d/%m.
 */
const DATE_FORMATS: readonly string[] = [
  "yyyy-M-d",
  "yyyy/M/d",
  "yyyy.M.d",
  "d-M-yyyy",
  "d/M/yyyy",
  "d.M.yyyy",
  "M-d-yyyy",
  "M/d/yyyy",
  "M.d.yyyy",
  "d-MMM-yyyy",
  "d MMM yyyy",
  "MMM d, yyyy",
  "d-MMMM-yyyy",
  "MMMM d, yyyy",
  "yyyy-M-d H:mm:ss",
  "yyyy-M-d'T'H:mm:ss",
];

const TIME_ONLY_RE = /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([AaPp][Mm])?$/;

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // month is 0-indexed: 11 = December
const MS_PER_DAY = 86_400_000;

function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH_MS + serial * MS_PER_DAY);
}

/** Strict format-list parse, in the exact order declared above -- first
 * format that both matches the full input (no trailing garbage) AND
 * produces an in-range date wins. Verified directly (not just by reading
 * date-fns' docs) that `isValid()` already rejects separator mismatches,
 * trailing garbage, and out-of-range day/month values on its own -- e.g.
 * "d/M/yyyy" against "99/99/2026" or "03/01/2026extra" both come back
 * invalid -- so no additional round-trip check is needed here. */
function tryStrictFormats(s: string): Date | null {
  for (const fmt of DATE_FORMATS) {
    const candidate = parseDateFns(s, fmt, new Date(2000, 0, 1));
    if (isValid(candidate)) return candidate;
  }
  return null;
}

/**
 * Last-resort lenient fallback for numeric dates not covered by the exact
 * format list above -- the closest practical equivalent to the source's
 * `pd.to_datetime(s, dayfirst=False)` then retry `dayfirst=True`. Handles
 * a single generic `<g1><sep><g2><sep><g3>` numeric shape with an optional
 * trailing time; validates day/month ranges rather than guessing blindly.
 * This is the one piece of the original algorithm with no direct library
 * equivalent -- flagged in the implementation plan as needing its own
 * dedicated tests.
 */
const LENIENT_RE =
  /^(\d{1,4})[/\-. ](\d{1,2})[/\-. ](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function tryLenientFallback(s: string): Date | null {
  const m = LENIENT_RE.exec(s);
  if (!m) return null;
  const [, g1, g2, g3, hh, mm, ss] = m;
  const hour = hh ? Number(hh) : 0;
  const minute = mm ? Number(mm) : 0;
  const second = ss ? Number(ss) : 0;

  const candidates: Array<{ y: number; mo: number; d: number }> = [];

  if (g1.length === 4) {
    // yyyy-g2-g3: unambiguous, g2=month, g3=day.
    candidates.push({ y: Number(g1), mo: Number(g2), d: Number(g3) });
  } else if (g3.length === 4) {
    const year = Number(g3);
    // dayfirst=false first (month, day), then dayfirst=true (day, month).
    candidates.push({ y: year, mo: Number(g1), d: Number(g2) });
    candidates.push({ y: year, mo: Number(g2), d: Number(g1) });
  } else {
    return null; // no 4-digit year group -- too ambiguous to guess.
  }

  for (const { y, mo, d } of candidates) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const dt = new Date(y, mo - 1, d, hour, minute, second);
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
      return dt;
    }
  }
  return null;
}

function normaliseInput(raw: unknown): { kind: "excel-serial"; value: number } | { kind: "string"; value: string } | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return { kind: "string", value: "" }; // handled by caller before this
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return null;
    return { kind: "excel-serial", value: raw };
  }
  const s = String(raw).trim();
  if (s === "") return null;
  return { kind: "string", value: s };
}

/**
 * NOTE for later phases (DTO serialisation, report generation): every Date
 * returned by this module is constructed and must be read using *local*
 * getters (getFullYear/getMonth/getDate), never `.toISOString()` or other
 * UTC conversion -- a local-midnight Date shifts to the previous day once
 * converted to UTC in any timezone ahead of UTC. Internally consistent as
 * long as construction and reading both stay local; only becomes a bug if
 * something downstream mixes in a UTC conversion.
 */

/** Returns midnight-truncated date-only value, or null. */
export function parseDate(raw: unknown): Date | null {
  const dt = parseDatetime(raw);
  if (!dt) return null;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** Returns the full datetime (date + time-of-day), or null. */
export function parseDatetime(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;

  const norm = normaliseInput(raw);
  if (norm === null) return null;

  if (norm.kind === "excel-serial") {
    try {
      return excelSerialToDate(norm.value);
    } catch {
      return null;
    }
  }

  const s = norm.value;
  if (TIME_ONLY_RE.test(s)) return null; // bare time -- never anchor to "today"

  const strict = tryStrictFormats(s);
  if (strict) return strict;

  return tryLenientFallback(s);
}
