import { Injectable } from "@angular/core";
import { BehaviorSubject, Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { CompareResultResponse, DatasetView, FileMetaView, MappingView } from "../shared/models/dto";

export interface CompareFormState {
  sourceFile: FileMetaView | null;
  targetFile: FileMetaView | null;
  catalogId: string | null;
  dataset: DatasetView | null;
  mapping: MappingView | null;
  dropUnmapped: boolean;
  /** source column -> target column ("" / absent = ignore) */
  columnMap: Record<string, string>;
  /** true once the user has edited the mapping away from the computed default */
  colMapEdited: boolean;
  keyColumns: string[];
  caseSensitive: boolean;
  trimWhitespace: boolean;
  treatBlankAsZero: boolean;
  fuzzyColumnNames: boolean;
  numericTolerance: string;
  decimalPrecision: number | null;
  controlTotalColumns: string[];
  previewRows: number;
  /** Produce the annotated source/target files for this run.
   *
   * Off: the UI does not offer them, so asking for them would make every
   * run hold the per-row status maps -- one entry per distinct key, per
   * side -- for nothing. The server still supports them for a direct API
   * caller, which is why the flag is sent explicitly rather than dropped. */
  annotatedOutputs: boolean;
}

function initialState(): CompareFormState {
  return {
    sourceFile: null,
    targetFile: null,
    catalogId: null,
    dataset: null,
    mapping: null,
    dropUnmapped: false,
    columnMap: {},
    colMapEdited: false,
    keyColumns: [],
    caseSensitive: true,
    trimWhitespace: true,
    treatBlankAsZero: false,
    fuzzyColumnNames: false,
    numericTolerance: "0",
    decimalPrecision: null,
    controlTotalColumns: [],
    previewRows: 100,
    annotatedOutputs: false,
  };
}

/**
 * Holds the comparison-flow state shared across the catalog picker, file
 * inputs, settings panel and results components -- the Angular 14
 * equivalent of the original React app's state lifted into App.tsx (no
 * signals in this Angular version; a single BehaviorSubject + patch()
 * plays the same role, with derived values as combineLatest/map
 * observables in place of useMemo).
 */
@Injectable({ providedIn: "root" })
export class CompareStateService {
  private readonly state = new BehaviorSubject<CompareFormState>(initialState());
  readonly state$ = this.state.asObservable();

  private readonly result = new BehaviorSubject<CompareResultResponse | null>(null);
  readonly result$ = this.result.asObservable();

  get value(): CompareFormState {
    return this.state.value;
  }

  patch(partial: Partial<CompareFormState>): void {
    this.state.next({ ...this.state.value, ...partial });
  }

  setResult(result: CompareResultResponse | null): void {
    this.result.next(result);
  }

  reset(): void {
    this.state.next(initialState());
    this.result.next(null);
  }

  /** Port of the original's onLoaded(source/target) + the dataset-change
   * effect that resets comparison-setting defaults and mapping. */
  setSourceFile(meta: FileMetaView | null): void {
    this.patch({ sourceFile: meta });
    this.recomputeColumnMap();
  }

  setTargetFile(meta: FileMetaView | null): void {
    this.patch({ targetFile: meta });
    this.recomputeColumnMap();
  }

  setDatasetMapping(
    mapping: MappingView | null,
    dataset: DatasetView | null,
    catalogId: string | null
  ): void {
    const settingsPatch: Partial<CompareFormState> = { mapping, dataset, catalogId };
    if (dataset) {
      if (dataset.case_sensitive !== null) settingsPatch.caseSensitive = dataset.case_sensitive;
      if (dataset.trim_whitespace !== null) settingsPatch.trimWhitespace = dataset.trim_whitespace;
      if (dataset.treat_blank_as_zero !== null) settingsPatch.treatBlankAsZero = dataset.treat_blank_as_zero;
      if (dataset.numeric_tolerance !== null) settingsPatch.numericTolerance = dataset.numeric_tolerance;
    }
    if (mapping) settingsPatch.keyColumns = [...mapping.default_key_columns];
    this.patch(settingsPatch);
    this.recomputeColumnMap();
  }

  setDropUnmapped(v: boolean): void {
    this.patch({ dropUnmapped: v });
  }

  setColumnMap(map: Record<string, string>, edited: boolean): void {
    this.patch({ columnMap: map, colMapEdited: edited });
    this.pruneStaleColumnSelections();
  }

  /**
   * Drop key / control-total selections that no longer name a column
   * present on both sides.
   *
   * Both pickers list post-mapping column names, so re-pointing or
   * ignoring a mapping row can strand a previously-checked column: it
   * vanishes from the checkbox list (nothing left to untick) while still
   * sitting in the request. A stranded key column is the damaging case --
   * the engine finds no such column, warns, and silently falls back to
   * whole-row matching, so the run the user gets back is not the run the
   * visible settings describe.
   *
   * Only prunes once both files are loaded; before that there is nothing
   * meaningful to validate against, and a catalogue picked ahead of the
   * files supplies its own default key columns.
   */
  private pruneStaleColumnSelections(): void {
    const s = this.state.value;
    if (!s.sourceFile || !s.targetFile) return;
    const common = new Set(commonColumnsOf(s));
    const keyColumns = s.keyColumns.filter((c) => common.has(c));
    const controlTotalColumns = s.controlTotalColumns.filter((c) => common.has(c));
    if (
      keyColumns.length === s.keyColumns.length &&
      controlTotalColumns.length === s.controlTotalColumns.length
    ) {
      return;
    }
    this.state.next({ ...this.state.value, keyColumns, controlTotalColumns });
  }

  /** Port of the original's defaultColMap(): prefer the catalogue's
   * source->canonical entry (if that canonical name exists in the target
   * file), else an exact same-name match, else blank. Runs whenever
   * source/target/mapping change and the user hasn't manually edited the
   * mapping away from the computed default. */
  private recomputeColumnMap(): void {
    const s = this.state.value;
    if (s.colMapEdited) return;
    const { sourceFile, targetFile, mapping } = s;
    if (!sourceFile || !targetFile) {
      this.state.next({ ...s, columnMap: {} });
      return;
    }
    const targetCols = new Set(targetFile.columns);
    const bySource = new Map(
      mapping?.entries.map((e) => [e.source_column || e.canonical_name, e.canonical_name]) ?? []
    );

    const map: Record<string, string> = {};
    for (const col of sourceFile.columns) {
      const viaMapping = bySource.get(col);
      if (viaMapping && targetCols.has(viaMapping)) {
        map[col] = viaMapping;
      } else if (targetCols.has(col)) {
        map[col] = col;
      }
    }
    this.state.next({ ...s, columnMap: map });
    this.pruneStaleColumnSelections();
  }

  /** Explicit reset to the computed default, e.g. an "Auto-match by name"
   * button. */
  resetColumnMapToDefault(): void {
    this.patch({ colMapEdited: false });
    this.recomputeColumnMap();
  }

  /** Target columns already claimed by some other source column's mapping
   * -- disabled in other rows' dropdowns, same UX as the original. */
  readonly usedTargets$: Observable<Set<string>> = this.state$.pipe(
    map((s) => new Set(Object.values(s.columnMap).filter(Boolean)))
  );

  /** Columns common to both sides post-mapping. */
  readonly commonColumns$: Observable<string[]> = this.state$.pipe(map(commonColumnsOf));

  /** Columns numeric on BOTH sides (post-mapping), for the control-total
   * column picker -- footing a text column is meaningless. */
  readonly numericColumns$: Observable<string[]> = this.state$.pipe(map(numericColumnsOf));
}

/** Columns common to both sides post-mapping: the mapped target name if a
 * source column maps, else the catalogue's canonical names, else raw shared
 * column names -- same fallback chain as the original. Pure so the service
 * can also evaluate it synchronously when pruning stale selections. */
export function commonColumnsOf(s: CompareFormState): string[] {
  if (!s.sourceFile || !s.targetFile) return [];
  const mapped = Object.values(s.columnMap).filter(Boolean);
  if (mapped.length > 0) return [...new Set(mapped)];
  if (s.mapping && s.mapping.canonical_names.length > 0) {
    return s.mapping.canonical_names.filter((c) => s.targetFile!.columns.includes(c));
  }
  const targetSet = new Set(s.targetFile.columns);
  return s.sourceFile.columns.filter((c) => targetSet.has(c));
}

/** Common columns that are numeric on both sides. */
export function numericColumnsOf(s: CompareFormState): string[] {
  if (!s.sourceFile || !s.targetFile) return [];
  const srcDtype = new Map(s.sourceFile.dtypes);
  const tgtDtype = new Map(s.targetFile.dtypes);
  const reverseMap = new Map(Object.entries(s.columnMap).map(([src, tgt]) => [tgt, src]));
  return commonColumnsOf(s).filter((c) => {
    const srcCol = reverseMap.get(c) ?? c;
    return srcDtype.get(srcCol) === "numeric" && tgtDtype.get(c) === "numeric";
  });
}
