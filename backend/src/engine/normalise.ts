import { toDecimal } from "./decimal";
import { parseDate, parseDatetime } from "./dates";
import type { CellKind, CompareSettings, NormalisedCell } from "./types";

const NULL_TOKENS = new Set(["nan", "none", "null"]);

/**
 * Port of comparison.py's `_normalise_cell`. Dispatch order verified
 * against source: null/NaN-token check first, then per-column `enforced`
 * override (id = never coerce, preserve exact text incl. leading zeros;
 * timestamp = force a full datetime parse of the value, preferring the
 * raw value over the trimmed string so an Excel datetime cell's
 * fractional time-of-day survives), then the default order --
 * numeric first, then date, else text.
 */
export function normaliseCell(
  raw: unknown,
  settings: CompareSettings,
  enforced?: "id" | "timestamp"
): NormalisedCell {
  if (raw === null || raw === undefined) return { kind: "null", value: null };
  if (typeof raw === "number" && Number.isNaN(raw)) return { kind: "null", value: null };

  let s = typeof raw === "string" ? raw : String(raw);
  if (settings.trimWhitespace) s = s.trim();
  if (s === "" || NULL_TOKENS.has(s.toLowerCase())) {
    return { kind: "null", value: null };
  }

  if (enforced === "id") {
    return { kind: "text", value: settings.caseSensitive ? s : s.toLowerCase() };
  }

  if (enforced === "timestamp") {
    const source = typeof raw === "string" ? s : raw;
    const ts = parseDatetime(source);
    if (ts) return { kind: "timestamp", value: ts };
    return { kind: "text", value: settings.caseSensitive ? s : s.toLowerCase() };
  }

  const asDecimal = toDecimal(s);
  if (asDecimal !== null) return { kind: "numeric", value: asDecimal };

  const asDate = parseDate(s);
  if (asDate !== null) return { kind: "date", value: asDate };

  return { kind: "text", value: settings.caseSensitive ? s : s.toLowerCase() };
}

export function isNonNullKind(kind: CellKind): boolean {
  return kind !== "null";
}
