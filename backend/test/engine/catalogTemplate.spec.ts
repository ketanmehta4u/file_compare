import { describe, it, expect } from "vitest";
import { buildCatalogTemplate } from "../../src/engine/catalogTemplate";
import { loadCatalog, getMappingFor } from "../../src/engine/catalog";

// Ported from tests/test_comparison.py::TestCatalogTemplate (the round-trip
// guarantee is the whole point of this generator).
describe("buildCatalogTemplate", () => {
  it("produces a valid xlsx", async () => {
    const buffer = await buildCatalogTemplate();
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
  });

  it("round-trips through loadCatalog unedited", async () => {
    const buffer = await buildCatalogTemplate();
    const catalog = await loadCatalog(buffer, "catalog_template.xlsx");
    const ids = catalog.datasets.map((d) => d.datasetId);
    expect(ids).toEqual(["MY_DATASET"]);

    const mapping = getMappingFor(catalog, "MY_DATASET");
    expect(mapping.entries.length).toBeGreaterThan(0);
    // The example dataset demonstrates a key and every dtype hint.
    const dtypes = new Set(mapping.entries.map((e) => e.dtype));
    expect(dtypes).toEqual(new Set(["text", "date", "money", "numeric", "id", "timestamp"]));
  });
});
