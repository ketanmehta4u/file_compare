import { Component, OnDestroy, OnInit } from "@angular/core";
import { Subject, combineLatest } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { CompareStateService, type CompareFormState } from "../../core/compare-state.service";

/** Port of the original's inline settings panel in App.tsx: column
 * mapping table, key-column and control-total pickers, comparison
 * toggles, tolerance/precision/preview-row inputs. Reads and writes the
 * shared CompareStateService directly rather than local component state,
 * since every other panel (results, run button) needs the same values. */
@Component({
  selector: "app-settings-panel",
  templateUrl: "./settings-panel.component.html",
})
export class SettingsPanelComponent implements OnInit, OnDestroy {
  private readonly destroyed = new Subject<void>();

  state: CompareFormState = this.compareState.value;
  commonColumns: string[] = [];
  numericColumns: string[] = [];
  usedTargets = new Set<string>();

  constructor(readonly compareState: CompareStateService) {}

  ngOnInit(): void {
    combineLatest([this.compareState.state$, this.compareState.commonColumns$, this.compareState.numericColumns$, this.compareState.usedTargets$])
      .pipe(takeUntil(this.destroyed))
      .subscribe(([state, common, numeric, used]) => {
        this.state = state;
        this.commonColumns = common;
        this.numericColumns = numeric;
        this.usedTargets = used;
      });
  }

  ngOnDestroy(): void {
    this.destroyed.next();
    this.destroyed.complete();
  }

  get bothFilesLoaded(): boolean {
    return !!this.state.sourceFile && !!this.state.targetFile;
  }

  onColumnMapChange(sourceCol: string, targetCol: string): void {
    const next = { ...this.state.columnMap };
    if (targetCol) next[sourceCol] = targetCol;
    else delete next[sourceCol];
    this.compareState.setColumnMap(next, true);
  }

  autoMatch(): void {
    this.compareState.resetColumnMapToDefault();
  }

  toggleKeyColumn(col: string, checked: boolean): void {
    const set = new Set(this.state.keyColumns);
    if (checked) set.add(col);
    else set.delete(col);
    this.compareState.patch({ keyColumns: [...set] });
  }

  toggleControlTotalColumn(col: string, checked: boolean): void {
    const set = new Set(this.state.controlTotalColumns);
    if (checked) set.add(col);
    else set.delete(col);
    this.compareState.patch({ controlTotalColumns: [...set] });
  }

  setCaseSensitive(v: boolean): void {
    this.compareState.patch({ caseSensitive: v });
  }
  setTrimWhitespace(v: boolean): void {
    this.compareState.patch({ trimWhitespace: v });
  }
  setTreatBlankAsZero(v: boolean): void {
    this.compareState.patch({ treatBlankAsZero: v });
  }
  setFuzzyColumnNames(v: boolean): void {
    this.compareState.patch({ fuzzyColumnNames: v });
  }
  setNumericTolerance(v: string): void {
    this.compareState.patch({ numericTolerance: v });
  }
  setDecimalPrecision(v: string): void {
    const n = v.trim() === "" ? null : Number(v);
    this.compareState.patch({ decimalPrecision: Number.isFinite(n) ? n : null });
  }
  setPreviewRows(v: string): void {
    const n = Number(v);
    this.compareState.patch({ previewRows: Number.isFinite(n) && n >= 10 ? n : 100 });
  }
}
