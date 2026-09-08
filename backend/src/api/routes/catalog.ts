import { Router } from "express";
import { catalogCache } from "../../cache/stores";
import { loadCatalog, getMappingFor, keyCanonicalNames, canonicalNames } from "../../engine/catalog";
import { buildCatalogTemplate } from "../../engine/catalogTemplate";
import { uploadSingle } from "../upload";
import { uploadRateLimit } from "../middleware/rateLimit";
import { datasetToView, mappingEntryToView } from "../toView";
import type { CatalogUploadResponse, MappingView } from "../dto";

export const catalogRouter = Router();

catalogRouter.get("/catalog/template", async (_req, res, next) => {
  try {
    const buffer = await buildCatalogTemplate();
    res
      .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="catalog_template.xlsx"')
      .send(buffer);
  } catch (err) {
    next(err);
  }
});

catalogRouter.post("/catalog/upload", uploadRateLimit, uploadSingle("file"), async (req, res, next) => {
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
    if (err instanceof Error) return res.status(400).json({ detail: err.message });
    next(err);
  }
});

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
