import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TestBed, ComponentFixture } from "@angular/core/testing";
import { SettingsPanelComponent } from "./settings-panel.component";
import { CompareStateService } from "../../core/compare-state.service";

describe("SettingsPanelComponent", () => {
  let fixture: ComponentFixture<SettingsPanelComponent>;
  let component: SettingsPanelComponent;
  let state: CompareStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [SettingsPanelComponent],
      imports: [CommonModule, FormsModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
    fixture = TestBed.createComponent(SettingsPanelComponent);
    component = fixture.componentInstance;
    state = TestBed.inject(CompareStateService);
    fixture.detectChanges();
  });

  it("keeps the matching options folded away until asked for", () => {
    expect(component.advancedOpen).toBe(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain("Numeric tolerance");

    component.toggleAdvanced();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Numeric tolerance");
  });

  // The annotated source/target files are not offered in the UI, so the
  // panel must not advertise them -- and a run must not pay for status
  // maps nothing will read.
  it("does not offer annotated outputs, and does not request them", () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain("Annotated");
    expect(state.value.annotatedOutputs).toBe(false);
  });

  it("summarises the hidden options so nothing is silently in force", () => {
    expect(component.optionsSummary).toContain("case sensitive");

    state.patch({ caseSensitive: false, treatBlankAsZero: true, numericTolerance: "0.01" });
    component.state = state.value;
    expect(component.optionsSummary).toContain("case insensitive");
    expect(component.optionsSummary).toContain("blank = 0");
    expect(component.optionsSummary).toContain("tolerance 0.01");
  });

  it("leaves a default tolerance of 0 out of the summary", () => {
    expect(component.optionsSummary).not.toContain("tolerance");
  });

  // The server caps rows per section, so an input promising more would
  // describe rows the response does not contain.
  it("will not set a preview size larger than the server will send", () => {
    component.maxPreviewRows = 1000;
    component.setPreviewRows("5000");
    expect(state.value.previewRows).toBe(1000);
  });

  it("accepts a preview size within the server's cap", () => {
    component.maxPreviewRows = 1000;
    component.setPreviewRows("250");
    expect(state.value.previewRows).toBe(250);
  });

  it("falls back to a sane default for nonsense input", () => {
    component.setPreviewRows("");
    expect(state.value.previewRows).toBe(100);
    component.setPreviewRows("2");
    expect(state.value.previewRows).toBe(100);
  });
});
