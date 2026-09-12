import { ChangeDetectionStrategy, Component, Input } from "@angular/core";
import { ApiService } from "../../core/api.service";
import type { CompareResultResponse, ValueDifferenceView } from "../../shared/models/dto";

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
  // A displayed result is the largest thing on the page -- up to a
  // thousand rows of table. Without OnPush, every unrelated event in the
  // app re-checks all of it, and an upload emits progress events
  // continuously: loading the next file while a result was on screen ran
  // at roughly 15ms of change detection per event. Nothing here depends on
  // outside mutation, so re-checking on input change and on this
  // component's own clicks is enough.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultsComponent {
  /**
   * Setters rather than plain inputs plus ngOnChanges: the derived values
   * below must never be able to go stale, and ngOnChanges only fires for
   * template-bound inputs -- assigning the property directly would leave
   * the component showing the previous result's rows.
   */
  @Input() set result(value: CompareResultResponse) {
    this.currentResult = value;
    this.recompute();
  }
  get result(): CompareResultResponse {
    return this.currentResult;
  }

  @Input() set previewRows(value: number) {
    this.rowLimit = value;
    this.recompute();
  }
  get previewRows(): number {
    return this.rowLimit;
  }

  private currentResult!: CompareResultResponse;
  private rowLimit = 100;

  colTab: ColTab = "source_only";
  rowTab: RowTab = "source_only";

  /**
   * Everything below is derived once, when the result or the preview size
   * changes, rather than by a getter the template calls on every cycle.
   * A getter returning `rows.slice(...)` hands *ngFor a new array each
   * time, so it rebuilds every row's DOM however unchanged the data --
   * and `dynamicRowColumns` was evaluated once per rendered row on top of
   * that.
   */
  previewedSourceOnly: Array<Record<string, unknown>> = [];
  previewedTargetOnly: Array<Record<string, unknown>> = [];
  previewedValueDiffs: ValueDifferenceView[] = [];
  dynamicRowColumns: string[] = [];
  isTruncated = false;
  truncatedSections: Array<{ name: string; returned: number; total: number }> = [];

  constructor(private readonly api: ApiService) {}

  /** Switching tab changes which rows are shown, so the derived column
   * list has to follow it. */
  setRowTab(tab: RowTab): void {
    this.rowTab = tab;
    this.dynamicRowColumns = this.columnsForRowTab();
  }

  private recompute(): void {
    // previewRows can be set before result; nothing to derive yet.
    if (!this.currentResult) return;
    const limit = this.rowLimit;
    this.previewedSourceOnly = this.currentResult.source_only_rows.slice(0, limit);
    this.previewedTargetOnly = this.currentResult.target_only_rows.slice(0, limit);
    this.previewedValueDiffs = this.currentResult.value_differences.slice(0, limit);
    this.dynamicRowColumns = this.columnsForRowTab();

    const t = this.currentResult.truncation;
    this.isTruncated = t?.any_truncated ?? false;
    this.truncatedSections = !t
      ? []
      : [
          { name: "source-only rows", info: t.source_only_rows },
          { name: "target-only rows", info: t.target_only_rows },
          { name: "cell differences", info: t.value_differences },
        ]
          .filter((s) => s.info.truncated)
          .map((s) => ({ name: s.name, returned: s.info.returned, total: s.info.total }));
  }

  private columnsForRowTab(): string[] {
    const rows = this.rowTab === "source_only" ? this.previewedSourceOnly : this.previewedTargetOnly;
    return rows.length > 0 ? Object.keys(rows[0]).filter((c) => !c.startsWith("_")) : [];
  }

  /** Identity for *ngFor: rows are never reordered or edited in place, so
   * the index is stable and lets Angular reuse the DOM it already built. */
  trackByIndex(index: number): number {
    return index;
  }

  keyColumnsOf(vd: { key: Record<string, unknown> }): string[] {
    return Object.keys(vd.key);
  }

  reportUrl(): string {
    return this.api.reportXlsxUrl(this.result.run_id);
  }

}
