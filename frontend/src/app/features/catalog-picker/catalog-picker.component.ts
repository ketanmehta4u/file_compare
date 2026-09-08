import { Component } from "@angular/core";
import { ApiService } from "../../core/api.service";
import { CompareStateService } from "../../core/compare-state.service";
import type { CatalogUploadResponse, MappingView } from "../../shared/models/dto";

/** Port of the original's CatalogPicker.tsx: upload a catalogue workbook,
 * pick a dataset, fetch its mapping, and push it into the shared
 * CompareStateService (which pre-fills key columns and comparison
 * settings). */
@Component({
  selector: "app-catalog-picker",
  templateUrl: "./catalog-picker.component.html",
})
export class CatalogPickerComponent {
  catalog: CatalogUploadResponse | null = null;
  datasetId = "";
  mapping: MappingView | null = null;

  uploading = false;
  uploadError = "";
  mappingLoading = false;
  mappingError = "";

  constructor(private readonly api: ApiService, readonly state: CompareStateService) {}

  templateUrl(): string {
    return this.api.catalogTemplateUrl();
  }

  onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading = true;
    this.uploadError = "";
    this.api.uploadCatalog(file).subscribe({
      next: (res) => {
        this.uploading = false;
        this.catalog = res;
        this.datasetId = "";
        this.mapping = null;
        this.state.setDatasetMapping(null, null, null);
      },
      error: (err) => {
        this.uploading = false;
        this.uploadError = err?.error?.detail ?? "Upload failed.";
      },
    });
    input.value = "";
  }

  onDatasetChange(datasetId: string): void {
    this.datasetId = datasetId;
    if (!this.catalog || !datasetId) {
      this.mapping = null;
      this.state.setDatasetMapping(null, null, this.catalog?.catalog_id ?? null);
      return;
    }
    this.mappingLoading = true;
    this.mappingError = "";
    this.api.getMapping(this.catalog.catalog_id, datasetId).subscribe({
      next: (mapping) => {
        this.mappingLoading = false;
        this.mapping = mapping;
        this.state.setDatasetMapping(mapping, mapping.dataset, this.catalog!.catalog_id);
      },
      error: (err) => {
        this.mappingLoading = false;
        this.mappingError = err?.error?.detail ?? "Failed to load mapping.";
      },
    });
  }

  onDropUnmappedChange(checked: boolean): void {
    this.state.setDropUnmapped(checked);
  }
}
