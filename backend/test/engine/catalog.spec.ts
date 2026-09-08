import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadCatalog,
  getMappingFor,
  keyCanonicalNames,
  mappingFromPairs,
  applyMapping,
  validateColumnsAgainstMapping,
} from "../../src/engine/catalog";
import { loadCsv } from "../../src/engine/fileLoad/csv";
import { runComparison } from "../../src/engine/runComparison";
import { defaultSettings } from "../../src/engine/types";
import type { FileMeta, Table } from "../../src/engine/types";

const FIXTURES = join(__dirname, "../../../fixtures");

async function loadSampleCatalog() {
  const data = readFileSync(join(FIXTURES, "sample_catalog.xlsx"));
  return loadCatalog(data, "sample_catalog.xlsx");
}

// Ported from tests/test_comparison.py::TestCatalogue.
describe("loadCatalog + mapping projection (real sample_catalog.xlsx)", () => {
  it("returns the expected datasets", async () => {
    const cat = await loadSampleCatalog();
    const ids = new Set(cat.datasets.map((d) => d.datasetId));
    expect(ids.has("GL_MONTHLY")).toBe(true);
    expect(ids.has("AP_INVOICES")).toBe(true);
  });

  it("key role precedence: surrogate beats composite", async () => {
    const cat = await loadSampleCatalog();
    const mapping = getMappingFor(cat, "AP_INVOICES");
    // AP_INVOICES has both a composite (invoice_number+vendor_id) key AND
    // a surrogate (internal_hash) key -- surrogate must win.
    expect(keyCanonicalNames(mapping)).toEqual(["internal_hash"]);
  });

  it("primary key for GL_MONTHLY is transaction_id", async () => {
    const cat = await loadSampleCatalog();
    const mapping = getMappingFor(cat, "GL_MONTHLY");
    expect(keyCanonicalNames(mapping)).toEqual(["transaction_id"]);
  });

  it("apply_mapping renames source columns, target is a no-op rename", async () => {
    const cat = await loadSampleCatalog();
    const mapping = getMappingFor(cat, "GL_MONTHLY");

    const src = loadCsv(readFileSync(join(FIXTURES, "sample_source.csv")), "sample_source.csv");
    const srcMapped = applyMapping(src.table, src.meta, "source", mapping);
    expect(srcMapped.meta.columns).toContain("transaction_id");
    expect(srcMapped.meta.columns).not.toContain("txn_id");

    const tgt = loadCsv(readFileSync(join(FIXTURES, "sample_target.csv")), "sample_target.csv");
    const originalCols = new Set(tgt.meta.columns);
    const tgtMapped = applyMapping(tgt.table, tgt.meta, "target", mapping);
    expect(new Set(tgtMapped.meta.columns)).toEqual(originalCols);
  });

  it("validate_columns_against_mapping surfaces extra source columns", async () => {
    const cat = await loadSampleCatalog();
    const mapping = getMappingFor(cat, "GL_MONTHLY");
    const src = loadCsv(readFileSync(join(FIXTURES, "sample_source.csv")), "sample_source.csv");
    const warns = validateColumnsAgainstMapping(src.meta, mapping, "source");
    expect(warns.some((w) => w.includes("debit") && w.includes("credit"))).toBe(true);
  });
});

describe("mappingFromPairs (inline UI column mapping, no catalogue)", () => {
  it("aligns differently-named source/target columns", () => {
    const sTable: Table = {
      columns: ["txn_id", "amt"],
      rows: [
        { txn_id: "A", amt: "10" },
        { txn_id: "B", amt: "20" },
      ],
    };
    const tTable: Table = {
      columns: ["transaction_id", "amount"],
      rows: [
        { transaction_id: "A", amount: "10" },
        { transaction_id: "B", amount: "99" },
      ],
    };
    const sMeta: FileMeta = {
      name: "s",
      sha256: "",
      sizeBytes: 0,
      rowCount: 2,
      columnCount: 2,
      columns: ["txn_id", "amt"],
      dtypes: [],
    };
    const tMeta: FileMeta = {
      name: "t",
      sha256: "",
      sizeBytes: 0,
      rowCount: 2,
      columnCount: 2,
      columns: ["transaction_id", "amount"],
      dtypes: [],
    };

    const inline = mappingFromPairs(
      new Map([
        ["txn_id", "transaction_id"],
        ["amt", "amount"],
      ])
    );
    const sMapped = applyMapping(sTable, sMeta, "source", inline, true);
    const tMapped = applyMapping(tTable, tMeta, "target", inline, true);
    expect(new Set(sMapped.meta.columns)).toEqual(new Set(["transaction_id", "amount"]));

    const report = runComparison(
      sMapped.table,
      sMapped.meta,
      tMapped.table,
      tMapped.meta,
      defaultSettings({ keyColumns: ["transaction_id"] })
    );
    expect(report.matchedEqualCount).toBe(1); // A matches
    expect(report.matchedWithDifferencesCount).toBe(1); // B differs (20 vs 99)
  });
});
