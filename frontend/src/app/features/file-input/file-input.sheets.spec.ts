import { TestBed } from "@angular/core/testing";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { FormsModule } from "@angular/forms";
import { FileInputComponent } from "./file-input.component";
import type { ExcelSheetView } from "../../shared/models/dto";

function workbookNamed(name: string): File {
  return new File([new Uint8Array(10)], name);
}

function chooseEvent(file: File): Event {
  const input = document.createElement("input");
  input.type = "file";
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  return { target: input } as unknown as Event;
}

const SHEETS: ExcelSheetView[] = [
  { name: "Sheet1", row_count: 1, column_count: 1 },
  { name: "Data", row_count: 12480, column_count: 9 },
];

/**
 * Choosing a sheet is the one decision a workbook forces on the user, and
 * names alone do not support it: "Sheet1 / Data / Notes" gives no clue which
 * one holds the figures. The counts do.
 */
describe("FileInputComponent sheet selection", () => {
  let component: FileInputComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [FileInputComponent],
      imports: [HttpClientTestingModule, FormsModule],
    });
    component = TestBed.createComponent(FileInputComponent).componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  function pickWorkbook() {
    component.onFileChosen(chooseEvent(workbookNamed("ledger.xlsx")));
    return http.expectOne("/api/files/list-sheets");
  }

  it("asks the server which sheets a workbook holds", () => {
    const req = pickWorkbook();
    expect(req.request.method).toBe("POST");
    req.flush({ sheets: SHEETS });

    expect(component.sheets.length).toBe(2);
    expect(component.chosenSheet).toBe("Sheet1"); // the first, until changed
  });

  it("labels each sheet with its size, so the data sheet is obvious", () => {
    pickWorkbook().flush({ sheets: SHEETS });

    expect(component.sheetLabel(component.sheets[0])).toBe("Sheet1 — 1 row × 1 column");
    expect(component.sheetLabel(component.sheets[1])).toBe("Data — 12,480 rows × 9 columns");
  });

  // Until the list arrives there is no sheet to load: the dropdown is empty
  // and chosenSheet is "". Loading then would upload the workbook with no
  // sheet named at all.
  it("will not load a workbook while its sheets are still being listed", () => {
    const req = pickWorkbook();
    expect(component.waitingForSheets).toBe(true);

    req.flush({ sheets: SHEETS });
    expect(component.waitingForSheets).toBe(false);
  });

  it("does not hold up a CSV, which has no sheets to choose", () => {
    component.onFileChosen(chooseEvent(new File([new Uint8Array(5)], "ledger.csv")));
    http.expectNone("/api/files/list-sheets");
    expect(component.waitingForSheets).toBe(false);
  });

  it("stays blocked if the sheet list fails, and says why", () => {
    pickWorkbook().flush({ detail: "Unreadable workbook." }, { status: 400, statusText: "Bad Request" });

    expect(component.loadError).toBe("Unreadable workbook.");
    expect(component.waitingForSheets).toBe(true);
  });

  afterEach(() => http.verify());
});
