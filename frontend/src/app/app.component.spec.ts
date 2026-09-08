import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { AppComponent } from "./app.component";

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

  it("renders the themed product name in the header", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector("h1")?.textContent).toContain("Financial File Reconciliation");
  });

  it("disables Run until both files are loaded", () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.canRun(app.compareState.value)).toBe(false);
  });
});
