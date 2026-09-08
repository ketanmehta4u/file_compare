import { TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { FormsModule } from "@angular/forms";
import { FileInputComponent } from "./file-input.component";

/** Builds a change event carrying `file`, shaped like the one the
 * template's <input type="file"> hands to onFileChosen. */
function chooseEvent(file: File): Event {
  const input = document.createElement("input");
  input.type = "file";
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  return { target: input } as unknown as Event;
}

function fileNamed(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name);
}

describe("FileInputComponent", () => {
  let component: FileInputComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [FileInputComponent],
      imports: [HttpClientTestingModule, FormsModule],
    });
    component = TestBed.createComponent(FileInputComponent).componentInstance;
  });

  it("accepts a .csv file", () => {
    component.onFileChosen(chooseEvent(fileNamed("ledger.csv")));
    expect(component.sizeError).toBe("");
    expect(component.pickedFile?.name).toBe("ledger.csv");
  });

  it("accepts an .xlsx file and treats it as Excel", () => {
    component.onFileChosen(chooseEvent(fileNamed("ledger.xlsx")));
    expect(component.sizeError).toBe("");
    expect(component.isExcel).toBe(true);
  });

  // Regression: the picker used to offer .xls, which the backend rejects by
  // magic bytes -- so the user only learned after a full upload round-trip.
  it("rejects a legacy .xls workbook before uploading it", () => {
    component.onFileChosen(chooseEvent(fileNamed("ledger.xls")));
    expect(component.pickedFile).toBeNull();
    expect(component.sizeError).toContain("re-save it as .xlsx");
  });

  it("rejects an unrelated file type", () => {
    component.onFileChosen(chooseEvent(fileNamed("notes.pdf")));
    expect(component.pickedFile).toBeNull();
    expect(component.sizeError).toContain("not a supported file type");
  });

  it("still enforces the upload size cap", () => {
    component.maxUploadBytes = 5;
    component.onFileChosen(chooseEvent(fileNamed("big.csv", 100)));
    expect(component.pickedFile).toBeNull();
    expect(component.sizeError).toContain("over the");
  });
});
