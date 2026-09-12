import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TestBed, ComponentFixture } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { ResultsComponent } from "./results.component";
import type { CompareResultResponse } from "../../shared/models/dto";

/**
 * Guards the cost of re-rendering a result that is already on screen.
 *
 * This is not a micro-benchmark for its own sake. While a result is
 * displayed, every unrelated event in the page runs Angular's change
 * detection -- and an upload emits progress events continuously. If
 * showing a result makes each of those cycles expensive, loading the next
 * pair of files crawls, which is exactly the symptom this was written
 * against.
 */

const ROWS = 1000;
const COLUMNS = 8;

function bigResult(): CompareResultResponse {
  const row = (i: number) => {
    const r: Record<string, unknown> = { _row: i };
    for (let c = 0; c < COLUMNS; c++) r[`col${c}`] = `value ${i}-${c}`;
    return r;
  };
  const rows = Array.from({ length: ROWS }, (_, i) => row(i));
  return {
    run_id: "run1",
    summary: {
      source_rows: ROWS,
      target_rows: ROWS,
      source_columns: COLUMNS,
      target_columns: COLUMNS,
      matched_equal: 0,
      matched_with_differences: 0,
      matched_with_tolerance: 0,
      source_only_rows: ROWS,
      target_only_rows: ROWS,
      cell_diffs: 0,
      control_totals_tied_out: 0,
      control_totals_not_tied_out: 0,
      source_duplicate_rows: 0,
      source_duplicate_keys: 0,
      target_duplicate_rows: 0,
      target_duplicate_keys: 0,
    },
    column_diff: {
      source_only: [],
      target_only: [],
      common: [],
      sequence_mismatches: [],
      dtype_mismatches: [],
    },
    source_only_rows: rows,
    target_only_rows: rows,
    value_differences: [],
    control_totals: [],
    warnings: [],
    audit: { rows: [], user: "", generated_at_utc: "", outcome: null },
    catalog_compliance_warnings: [],
    truncation: {
      limit: 1000,
      any_truncated: false,
      source_only_rows: { returned: ROWS, total: ROWS, truncated: false },
      target_only_rows: { returned: ROWS, total: ROWS, truncated: false },
      value_differences: { returned: 0, total: 0, truncated: false },
    },
    annotated_outputs: true,
  } as CompareResultResponse;
}

describe("ResultsComponent re-render cost", () => {
  let fixture: ComponentFixture<ResultsComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [ResultsComponent],
      imports: [HttpClientTestingModule, CommonModule, FormsModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
    fixture = TestBed.createComponent(ResultsComponent);
    fixture.componentInstance.result = bigResult();
    fixture.componentInstance.previewRows = ROWS;
    fixture.detectChanges(); // first paint: the expensive one, unavoidable
  });

  // The point of the fix: with nothing changed, a change-detection pass
  // over a displayed result must not rebuild the table. Before memoising,
  // each pass re-sliced the arrays and re-derived the column list once per
  // rendered row.
  it("costs almost nothing to re-check when nothing changed", () => {
    const started = performance.now();
    for (let i = 0; i < 20; i++) fixture.detectChanges();
    const perCycle = (performance.now() - started) / 20;

    // Generous: the pre-fix version took tens of milliseconds per cycle
    // for this size of result, so anything near that fails.
    console.log("AFTER: " + perCycle.toFixed(2) + " ms per change-detection cycle");
    expect(perCycle).toBeLessThan(5);
  });

  it("keeps the same row objects across a re-check, so the DOM is not rebuilt", () => {
    const first = fixture.componentInstance.previewedSourceOnly;
    fixture.detectChanges();
    const second = fixture.componentInstance.previewedSourceOnly;

    // Same array identity -- an *ngFor over a freshly-sliced array rebuilds
    // every row on every cycle, however unchanged the data.
    expect(second).toBe(first);
  });

  it("derives the column list once, not once per row", () => {
    const first = fixture.componentInstance.dynamicRowColumns;
    fixture.detectChanges();
    expect(fixture.componentInstance.dynamicRowColumns).toBe(first);
  });

  it("still recomputes when the result actually changes", () => {
    const before = fixture.componentInstance.previewedSourceOnly;
    const next = bigResult();
    next.source_only_rows = next.source_only_rows.slice(0, 3);
    fixture.componentInstance.result = next;
    fixture.detectChanges();

    expect(fixture.componentInstance.previewedSourceOnly).not.toBe(before);
    expect(fixture.componentInstance.previewedSourceOnly.length).toBe(3);
  });

  // OnPush's real risk: a component that stops re-rendering when it
  // should. A click inside it must still update the view.
  it("still switches tabs and redraws when the user clicks", () => {
    const el = fixture.nativeElement as HTMLElement;
    const tabs = Array.from(el.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Target-only")
    );
    const recordTab = tabs[tabs.length - 1] as HTMLButtonElement;

    recordTab.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.rowTab).toBe("target_only");
    // The derived column list follows the tab, so the table has headers.
    expect(fixture.componentInstance.dynamicRowColumns.length).toBe(COLUMNS);
    expect(el.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });

  it("still honours a change to the preview size", () => {
    fixture.componentInstance.previewRows = 10;
    fixture.detectChanges();
    expect(fixture.componentInstance.previewedSourceOnly.length).toBe(10);
  });
});
