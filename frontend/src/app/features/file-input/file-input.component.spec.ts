import { TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { FormsModule } from "@angular/forms";
import { FileInputComponent, formatBytes } from "./file-input.component";

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

/** A drop event carrying `file`, shaped like the one the drop zone receives. */
function dropEvent(file: File): DragEvent {
  const dt = new DataTransfer();
  dt.items.add(file);
  return { preventDefault: () => undefined, dataTransfer: dt } as unknown as DragEvent;
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

  // A dropped file must get exactly the checks a picked one does -- the drop
  // zone is not a way around the type or size rules.
  it("accepts a file dropped onto the drop zone", () => {
    component.onDrop(dropEvent(fileNamed("ledger.csv")));
    expect(component.pickedFile?.name).toBe("ledger.csv");
    expect(component.dragging).toBe(false);
  });

  it("applies the same type check to a dropped file", () => {
    component.onDrop(dropEvent(fileNamed("ledger.xls")));
    expect(component.pickedFile).toBeNull();
    expect(component.sizeError).toContain("re-save it as .xlsx");
  });

  it("highlights the drop zone only while a file is over it", () => {
    let prevented = false;
    component.onDragOver({ preventDefault: () => (prevented = true) } as unknown as DragEvent);
    expect(component.dragging).toBe(true);
    expect(prevented).toBe(true); // without this the browser refuses the drop
    component.onDragLeave();
    expect(component.dragging).toBe(false);
  });

  it("formats file sizes for people", () => {
    expect(formatBytes(845)).toBe("845 B");
    expect(formatBytes(12_700)).toBe("12.4 KB");
    expect(formatBytes(3_400_000)).toBe("3.2 MB");
  });

  it("still enforces the upload size cap", () => {
    component.maxUploadBytes = 5;
    component.onFileChosen(chooseEvent(fileNamed("big.csv", 100)));
    expect(component.pickedFile).toBeNull();
    expect(component.sizeError).toContain("over the");
  });
});
