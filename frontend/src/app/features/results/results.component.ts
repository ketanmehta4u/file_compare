import { Component, Input } from "@angular/core";
import { ApiService } from "../../core/api.service";
import type { CompareResultResponse, ConfigInfo } from "../../shared/models/dto";

type ColTab = "source_only" | "target_only" | "common" | "sequence" | "dtype";
type RowTab = "source_only" | "target_only" | "value_diffs";

/** Port of the original's Results.tsx. Kept as one component -- same call
 * the original made ("splitting further would add ceremony" per its own
 * comment) -- but organised internally into clear template sections
 * mirroring its panel structure: verdict banner, summary grid, audit
 * table, column-diff tabs, record-diff tabs, control totals, downloads. */
@Component({
  selector: "app-results",
  templateUrl: "./results.component.html",
})
export class ResultsComponent {
  @Input() result!: CompareResultResponse;
  @Input() config!: ConfigInfo;
  @Input() previewRows = 100;

  colTab: ColTab = "source_only";
  rowTab: RowTab = "source_only";

  blobWriting = false;
  blobWriteResult: { written: string[]; failed: Array<[string, string]> } | null = null;
  blobWriteError = "";

  constructor(private readonly api: ApiService) {}

  get dynamicRowColumns(): string[] {
    const rows = this.rowTab === "source_only" ? this.result.source_only_rows : this.result.target_only_rows;
    return rows.length > 0 ? Object.keys(rows[0]).filter((c) => !c.startsWith("_")) : [];
  }

  get previewedSourceOnly() {
    return this.result.source_only_rows.slice(0, this.previewRows);
  }
  get previewedTargetOnly() {
    return this.result.target_only_rows.slice(0, this.previewRows);
  }
  get previewedValueDiffs() {
    return this.result.value_differences.slice(0, this.previewRows);
  }

  keyColumnsOf(vd: { key: Record<string, unknown> }): string[] {
    return Object.keys(vd.key);
  }

  reportUrl(): string {
    return this.api.reportXlsxUrl(this.result.run_id);
  }
  annotatedUrl(side: "source" | "target"): string {
    return this.api.annotatedUrl(this.result.run_id, side);
  }

  writeToBlob(): void {
    this.blobWriting = true;
    this.blobWriteError = "";
    this.api.writeToBlob(this.result.run_id).subscribe({
      next: (res) => {
        this.blobWriting = false;
        this.blobWriteResult = res;
      },
      error: (err) => {
        this.blobWriting = false;
        this.blobWriteError = err?.error?.detail ?? "Write to blob failed.";
      },
    });
  }
}
