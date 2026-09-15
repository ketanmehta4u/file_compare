import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { AppComponent } from "./app.component";
import { CompareStateService } from "./core/compare-state.service";
import type { FileMetaView } from "./shared/models/dto";

// CUSTOM_ELEMENTS_SCHEMA lets Angular ignore the child feature components'
// own selectors/inputs here -- this is a smoke test for the shell itself
// (bootstraps without error, renders the branded header), not an
// integration test of the whole page; each feature component gets its
// own focused tests instead of re-declaring their dependency chains here.
describe("AppComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AppComponent],
      imports: [HttpClientTestingModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();
  });

  it("creates the app", () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("shows the logo and the product name in the blue strip", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const strip = (fixture.nativeElement as HTMLElement).querySelector(".utility-bar")!;

    expect(strip.querySelector("img.logo")?.getAttribute("src")).toBe("assets/wbg-logo-white.svg");
    expect(strip.querySelector("h1")?.textContent?.trim()).toBe("File Reconciliation");
    expect(strip.textContent).not.toContain("The World Bank"); // the logo replaces the text
  });

  it("goes straight from the strip to the page, with no second title or logo", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelectorAll("h1").length).toBe(1);
    expect(compiled.querySelectorAll("img.logo").length).toBe(1);
    expect(compiled.querySelector(".app-header")).toBeNull();
  });

  it("shows the disclaimer at the bottom of the page", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const footer = (fixture.nativeElement as HTMLElement).querySelector("footer.app-footer")!;

    expect(footer.querySelector(".disclaimer")?.textContent?.trim()).toBe(
      "Compare and reconcile two financial-reporting files. Outputs an audit-ready report. " +
        "This tool assists reconciliation but does not replace independent verification or sign-off."
    );
  });

  // The indicator is derived from state, so it follows the user through
  // the page: upload first, then settings once both files are in.
  it("walks the step indicator from uploading to reviewing settings", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const current = () =>
      (fixture.nativeElement as HTMLElement).querySelector('.step[aria-current="step"]')?.textContent ?? "";
    expect(current()).toContain("Upload files");

    const state = TestBed.inject(CompareStateService);
    const meta = (id: string) =>
      ({
        file_id: id,
        filename: `${id}.csv`,
        columns: ["id"],
        dtypes: [["id", "text"]],
      }) as unknown as FileMetaView;
    state.setSourceFile(meta("src"));
    state.setTargetFile(meta("tgt"));
    fixture.detectChanges();

    expect(current()).toContain("Review settings");
    const done = (fixture.nativeElement as HTMLElement).querySelectorAll(".step-done");
    expect(done.length).toBe(1);
    expect(done[0].textContent).toContain("Upload files");
  });

  it("disables Run until both files are loaded", () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.canRun(app.compareState.value)).toBe(false);
  });
});
