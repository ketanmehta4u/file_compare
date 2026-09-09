import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TestBed, ComponentFixture } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { ResultsComponent } from "./results.component";
import type { CompareResultResponse, ResponseTruncation } from "../../shared/models/dto";

function truncation(over: Partial<ResponseTruncation> = {}): ResponseTruncation {
  return {
    limit: 1000,
    any_truncated: false,
    source_only_rows: { returned: 2, total: 2, truncated: false },
    target_only_rows: { returned: 0, total: 0, truncated: false },
    value_differences: { returned: 0, total: 0, truncated: false },
    ...over,
  };
}

function result(over: Partial<CompareResultResponse> = {}): CompareResultResponse {
  return {
    run_id: "run1",
    summary: {
      source_rows: 10,
      target_rows: 10,
      source_columns: 2,
      target_columns: 2,
      matched_equal: 0,
      matched_with_differences: 0,
      matched_with_tolerance: 0,
      source_only_rows: 2,
      target_only_rows: 0,
      cell_diffs: 0,
      control_totals_tied_out: 0,
      control_totals_not_tied_out: 0,
      source_duplicate_rows: 0,
      target_duplicate_rows: 0,
    },
    column_diff: { source_only: [], target_only: [], common: [], sequence_mismatches: [], dtype_mismatches: [] },
    source_only_rows: [{ id: "a" }, { id: "b" }],
    target_only_rows: [],
    value_differences: [],
    control_totals: [],
    warnings: [],
    audit: { rows: [], user: "", generated_at_utc: "", outcome: null },
    catalog_compliance_warnings: [],
    truncation: truncation(),
    ...over,
  } as CompareResultResponse;
}

describe("ResultsComponent truncation notice", () => {
  let fixture: ComponentFixture<ResultsComponent>;

  function render(res: CompareResultResponse) {
    fixture = TestBed.createComponent(ResultsComponent);
    fixture.componentInstance.result = res;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [ResultsComponent],
      imports: [HttpClientTestingModule, CommonModule, FormsModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
  });

  it("says nothing when the whole result was returned", () => {
    const el = render(result());
    expect(el.textContent).not.toContain("partial view");
    expect(fixture.componentInstance.isTruncated).toBe(false);
  });

  it("warns that the view is incomplete and points at the downloads", () => {
    const el = render(
      result({
        summary: { ...result().summary, source_only_rows: 150000, cell_diffs: 21428 },
        truncation: truncation({
          any_truncated: true,
          source_only_rows: { returned: 1000, total: 150000, truncated: true },
          value_differences: { returned: 1000, total: 21428, truncated: true },
        }),
      })
    );

    const text = el.textContent ?? "";
    expect(text).toContain("partial view");
    expect(text).toContain("150,000");
    expect(text).toContain("21,428");
    expect(text).toContain("audit workbook");
  });

  // Duplicate rows are computed by the engine and written into the audit
  // workbook; the on-screen summary used to omit them entirely, which hid
  // the fact that rows beyond the first per key are never compared.
  it("shows duplicate row counts in the summary", () => {
    const el = render(
      result({
        summary: { ...result().summary, source_duplicate_rows: 2, target_duplicate_rows: 0 },
      })
    );
    const text = el.textContent ?? "";
    expect(text).toContain("Source duplicate rows");
    expect(text).toContain("Target duplicate rows");

    const tiles = Array.from(el.querySelectorAll(".metric"));
    const sourceTile = tiles.find((t) => t.textContent?.includes("Source duplicate rows"));
    expect(sourceTile?.querySelector(".metric-value")?.textContent?.trim()).toBe("2");
    // Non-zero duplicates are flagged; a clean zero is not.
    expect(sourceTile?.querySelector(".metric-value")?.classList.contains("bad")).toBe(true);
    const targetTile = tiles.find((t) => t.textContent?.includes("Target duplicate rows"));
    expect(targetTile?.querySelector(".metric-value")?.classList.contains("bad")).toBe(false);
  });

  it("lists only the sections that were actually cut", () => {
    const component = render(
      result({
        truncation: truncation({
          any_truncated: true,
          value_differences: { returned: 1000, total: 5000, truncated: true },
        }),
      })
    );
    void component;
    const names = fixture.componentInstance.truncatedSections.map((s) => s.name);
    expect(names).toEqual(["cell differences"]);
  });

  // The arrays are a capped preview, so counting them would understate the
  // result; the tab labels must come from the summary totals instead.
  it("labels the tabs with the true totals, not the previewed array lengths", () => {
    const el = render(
      result({
        summary: { ...result().summary, source_only_rows: 150000 },
        source_only_rows: [{ id: "a" }, { id: "b" }],
        truncation: truncation({
          any_truncated: true,
          source_only_rows: { returned: 2, total: 150000, truncated: true },
        }),
      })
    );
    // "Source-only" labels both the column-diff tab and the record-diff
    // tab; the record one is the later of the two.
    const sourceTabs = Array.from(el.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Source-only")
    );
    expect(sourceTabs.length).toBeGreaterThan(1);
    expect(sourceTabs[sourceTabs.length - 1].textContent).toContain("150,000");
  });
});
