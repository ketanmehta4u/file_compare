import { Router } from "express";
import { catalogCache } from "../../cache/stores";
import { loadCatalog, getMappingFor, keyCanonicalNames, canonicalNames } from "../../engine/catalog";
import { buildCatalogTemplate } from "../../engine/catalogTemplate";
import { uploadSingle } from "../upload";
import { uploadRateLimit } from "../middleware/rateLimit";
import { datasetToView, mappingEntryToView } from "../toView";
import type { CatalogUploadResponse, MappingView } from "../dto";
import { respondWithError } from "../errors";

export const catalogRouter = Router();

/**
 * The optional dataset catalogue: a workbook describing known datasets --
 * canonical column names, which source column feeds each one, which are
 * keys, per-column dtypes (including the `id` and `timestamp` overrides
 * the engine enforces), and per-dataset comparison defaults.
 *
 * Entirely optional. Two files with matching column names compare without
 * any of this; a catalogue just pre-fills the mapping, the key columns and
 * the settings, and lets the run report where an uploaded file departs
 * from what the catalogue says it should contain.
 */

/** Blank catalogue workbook, generated on the fly, for users starting from
 * scratch rather than editing an existing one. */
catalogRouter.get("/catalog/template", async (req, res) => {
  try {
    const buffer = await buildCatalogTemplate();
    res
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="catalog_template.xlsx"')
      .send(buffer);
  } catch (err) {
    respondWithError(req, res, err);
  }
});

/** Parses an uploaded catalogue and caches it under a content hash, so a
 * later compare request can name it by `catalog_id`. */
catalogRouter.post("/catalog/upload", uploadRateLimit, uploadSingle("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: "No file uploaded." });
    const data = req.file.buffer;
    if (data.length === 0) return res.status(400).json({ detail: "Uploaded file is empty." });

    const catalog = await loadCatalog(data, req.file.originalname);
    const catalogId = catalog.sha256.slice(0, 16);
    catalogCache.set(catalogId, { catalog, cachedAt: Date.now() });

    const body: CatalogUploadResponse = {
      catalog_id: catalogId,
      sha256: catalog.sha256,
      filename: req.file.originalname,
      datasets: catalog.datasets.map(datasetToView),
    };
    res.json(body);
  } catch (err) {
    respondWithError(req, res, err);
  }
});

/** The column mapping for one dataset: what the settings panel pre-fills
 * itself from, and what the compare request refers to by dataset_id. */
catalogRouter.get("/catalog/:catalogId/datasets/:datasetId/mapping", (req, res) => {
  const cached = catalogCache.get(req.params.catalogId);
  if (!cached) return res.status(404).json({ detail: "Catalog not found — re-upload." });

  const mapping = getMappingFor(cached.catalog, req.params.datasetId);
  if (mapping.entries.length === 0) {
    return res.status(404).json({ detail: `Dataset '${req.params.datasetId}' not found in this catalog.` });
  }

  const body: MappingView = {
    dataset_id: req.params.datasetId,
    dataset: mapping.dataset ? datasetToView(mapping.dataset) : null,
    entries: mapping.entries.map(mappingEntryToView),
    canonical_names: canonicalNames(mapping),
    default_key_columns: keyCanonicalNames(mapping),
    sha256: mapping.sha256,
  };
  res.json(body);
});
