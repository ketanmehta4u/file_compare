import type { AuditHeader, ReconciliationOutcome } from "../types";

export type Row = readonly [string, string];

function printableDelimiter(d: string | null | undefined): string {
  if (d === null || d === undefined) return "";
  const map: Record<string, string> = {
    "\t": "\\t (tab)",
    ",": ", (comma)",
    ";": "; (semicolon)",
    "|": "| (pipe)",
  };
  return map[d] ?? d;
}

/** Port of ReconciliationOutcome.to_rows. */
export function outcomeToRows(o: ReconciliationOutcome): Row[] {
  const rows: Row[] = [
    ["Reconciliation result", o.verdict],
    ["Source-only rows (missing from target)", String(o.sourceOnlyRows)],
    ["Target-only rows (missing from source)", String(o.targetOnlyRows)],
    ["Matched rows with value differences", String(o.matchedWithDifferences)],
    ["Cell-level differences", String(o.cellDifferences)],
  ];
  if (o.matchedWithinTolerance) {
    rows.push(["Matched within tolerance (flagged)", String(o.matchedWithinTolerance)]);
  }
  if (o.controlTotalsNotTiedOut) {
    rows.push(["Control totals NOT tied out", String(o.controlTotalsNotTiedOut)]);
  }
  return rows;
}

/** Port of AuditHeader.to_rows -- flattens the audit header to
 * [(label, value), ...] rows for the Audit Header sheet. The
 * reconciliation outcome leads when present so the report opens with its
 * conclusion, not file plumbing. */
export function auditHeaderToRows(audit: AuditHeader): Row[] {
  const rows: Row[] = [];
  if (audit.outcome) {
    rows.push(...outcomeToRows(audit.outcome));
    rows.push(["", ""]);
  }

  rows.push(
    ["Tool version", "1.0.0"],
    ["Generated at (UTC)", audit.generatedAtUtc],
    ["Run by", audit.user || "(unauthenticated)"],
    ["", ""],
    ["Source file name", audit.source.name],
    ["Source SHA-256", audit.source.sha256],
    ["Source size (bytes)", String(audit.source.sizeBytes)],
    ["Source sheet", audit.source.sheetName ?? ""],
    ["Source encoding", audit.source.encoding ?? ""],
    ["Source delimiter", printableDelimiter(audit.source.delimiter)],
    ["Source rows", String(audit.source.rowCount)],
    ["Source columns (post-mapping)", String(audit.source.columnCount)]
  );
  if (audit.source.originalColumns && audit.source.originalColumns.length > 0) {
    rows.push(["Source columns (pre-mapping)", audit.source.originalColumns.join(", ")]);
  }

  rows.push(
    ["", ""],
    ["Target file name", audit.target.name],
    ["Target SHA-256", audit.target.sha256],
    ["Target size (bytes)", String(audit.target.sizeBytes)],
    ["Target sheet", audit.target.sheetName ?? ""],
    ["Target encoding", audit.target.encoding ?? ""],
    ["Target delimiter", printableDelimiter(audit.target.delimiter)],
    ["Target rows", String(audit.target.rowCount)],
    ["Target columns (post-mapping)", String(audit.target.columnCount)]
  );
  if (audit.target.originalColumns && audit.target.originalColumns.length > 0) {
    rows.push(["Target columns (pre-mapping)", audit.target.originalColumns.join(", ")]);
  }

  const s = audit.settings;
  rows.push(
    ["", ""],
    ["Key columns", s.keyColumns.join(", ") || "(full row)"],
    ["Case sensitive", String(s.caseSensitive)],
    ["Trim whitespace", String(s.trimWhitespace)],
    ["Numeric tolerance", s.numericTolerance.toString()],
    [
      "Decimal precision",
      s.decimalPrecision === null ? "exact (full precision)" : `${s.decimalPrecision} place(s)`,
    ],
    ["Treat blank as zero", String(s.treatBlankAsZero)],
    ["Fuzzy column names", String(s.fuzzyColumnNames)],
    ["Control-total columns", s.controlTotalColumns.join(", ") || "(auto: all numeric)"]
  );
  if (s.enforcedDtypes.size > 0) {
    rows.push([
      "Enforced column types",
      [...s.enforcedDtypes.entries()].map(([col, kind]) => `${col}=${kind}`).join(", "),
    ]);
  }

  if (audit.mapping && audit.mapping.entries.length > 0) {
    rows.push(
      ["", ""],
      ["Mapping / catalogue file", audit.mapping.sourceName || "(in-memory)"],
      ["Mapping SHA-256", audit.mapping.sha256],
      ["Mapping entries", String(audit.mapping.entries.length)]
    );
    const ds = audit.mapping.dataset;
    if (ds) {
      rows.push(
        ["Dataset id", ds.datasetId],
        ["Dataset name", ds.datasetName],
        ["Owner", ds.owner],
        ["Source system", ds.sourceSystem],
        ["Frequency", ds.frequency]
      );
      if (ds.description) rows.push(["Dataset description", ds.description]);
    }
    for (const e of audit.mapping.entries) {
      const role = e.keyRole || (e.isKey ? "key" : "");
      const value =
        `source='${e.sourceColumn || e.canonicalName}'` +
        (role ? `, role=${role}` : "") +
        (e.dtype ? `, dtype=${e.dtype}` : "");
      rows.push([`  canonical:${e.canonicalName}`, value]);
    }
  }

  return rows;
}
