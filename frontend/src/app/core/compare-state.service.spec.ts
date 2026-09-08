import { TestBed } from "@angular/core/testing";
import { CompareStateService, commonColumnsOf, numericColumnsOf } from "./compare-state.service";
import type { FileMetaView } from "../shared/models/dto";

function meta(name: string, dtypes: Array<[string, string]>): FileMetaView {
  return {
    file_id: name,
    filename: `${name}.csv`,
    sha256: name.padEnd(64, "0"),
    size_bytes: 1,
    row_count: 1,
    column_count: dtypes.length,
    columns: dtypes.map(([c]) => c),
    dtypes,
    sheet_name: null,
    encoding: "utf-8",
    delimiter: ",",
    hidden_columns: [],
    hidden_row_count: 0,
    formula_blank_columns: [],
    formula_blank_count: 0,
    blob_url: "",
  } as FileMetaView;
}

const SOURCE = meta("src", [
  ["txn_id", "text"],
  ["amount", "numeric"],
  ["note", "text"],
]);
const TARGET = meta("tgt", [
  ["transaction_id", "text"],
  ["amount", "numeric"],
  ["memo", "text"],
]);

describe("CompareStateService", () => {
  let service: CompareStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CompareStateService);
  });

  it("auto-matches only identically-named columns when both files load", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    expect(service.value.columnMap).toEqual({ amount: "amount" });
  });

  it("reports common columns using post-mapping (target) names", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    service.setColumnMap({ txn_id: "transaction_id", amount: "amount" }, true);
    expect(commonColumnsOf(service.value).sort()).toEqual(["amount", "transaction_id"]);
  });

  it("offers only columns numeric on both sides as control totals", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    service.setColumnMap({ txn_id: "transaction_id", amount: "amount" }, true);
    expect(numericColumnsOf(service.value)).toEqual(["amount"]);
  });

  // Regression: re-pointing a mapping row used to strand the key column it
  // had produced -- the checkbox disappeared from the panel while the name
  // stayed in the request, so the engine fell back to whole-row matching
  // and returned a run that did not match the visible settings.
  it("drops a key column stranded by a later mapping change", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    service.setColumnMap({ txn_id: "transaction_id", amount: "amount" }, true);
    service.patch({ keyColumns: ["transaction_id"] });

    service.setColumnMap({ amount: "amount" }, true);

    expect(commonColumnsOf(service.value)).toEqual(["amount"]);
    expect(service.value.keyColumns).toEqual([]);
  });

  it("drops a control-total column stranded by a later mapping change", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    service.setColumnMap({ txn_id: "transaction_id", amount: "amount" }, true);
    service.patch({ controlTotalColumns: ["amount"] });

    service.setColumnMap({ txn_id: "transaction_id" }, true);

    expect(service.value.controlTotalColumns).toEqual([]);
  });

  it("keeps selections that survive the mapping change", () => {
    service.setSourceFile(SOURCE);
    service.setTargetFile(TARGET);
    service.setColumnMap({ txn_id: "transaction_id", amount: "amount" }, true);
    service.patch({ keyColumns: ["transaction_id"], controlTotalColumns: ["amount"] });

    service.setColumnMap({ txn_id: "transaction_id", amount: "amount", note: "memo" }, true);

    expect(service.value.keyColumns).toEqual(["transaction_id"]);
    expect(service.value.controlTotalColumns).toEqual(["amount"]);
  });

  it("does not prune before both files are loaded", () => {
    service.patch({ keyColumns: ["from_catalogue"] });
    service.setSourceFile(SOURCE);
    expect(service.value.keyColumns).toEqual(["from_catalogue"]);
  });
});
