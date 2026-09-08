import { Component, OnInit } from "@angular/core";
import { Observable } from "rxjs";
import { AuthService } from "./core/auth.service";
import { ConfigService } from "./core/config.service";
import { ApiService } from "./core/api.service";
import { CompareStateService, type CompareFormState } from "./core/compare-state.service";
import { theme } from "./theme";
import type { CompareRequest, CompareResultResponse, ConfigInfo, FileMetaView } from "./shared/models/dto";

/** Root shell -- port of the original's App.tsx. Bootstraps auth/config,
 * renders the branded header/footer (from theme.ts), and composes the
 * catalog picker, source/target file inputs, settings panel, run button,
 * and results into one page (no router -- single-page app). */
@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit {
  readonly theme = theme;
  config: ConfigInfo | null = null;
  user = "";

  result: CompareResultResponse | null = null;
  runError = "";
  running = false;

  constructor(
    private readonly auth: AuthService,
    private readonly configService: ConfigService,
    private readonly api: ApiService,
    readonly compareState: CompareStateService
  ) {}

  ngOnInit(): void {
    this.auth.load();
    this.configService.load();
    this.auth.user$.subscribe((u) => (this.user = u));
    this.configService.config$.subscribe((c) => (this.config = c));
  }

  get state$(): Observable<CompareFormState> {
    return this.compareState.state$;
  }

  onSourceLoaded(meta: FileMetaView | null): void {
    this.compareState.setSourceFile(meta);
    this.result = null;
  }

  onTargetLoaded(meta: FileMetaView | null): void {
    this.compareState.setTargetFile(meta);
    this.result = null;
  }

  canRun(state: CompareFormState): boolean {
    return !!state.sourceFile && !!state.targetFile && !this.running;
  }

  run(state: CompareFormState): void {
    if (!state.sourceFile || !state.targetFile) return;
    this.running = true;
    this.runError = "";

    const req: CompareRequest = {
      source_file_id: state.sourceFile.file_id,
      target_file_id: state.targetFile.file_id,
      catalog_id: state.catalogId ?? undefined,
      dataset_id: state.dataset?.dataset_id ?? undefined,
      drop_unmapped: state.dropUnmapped,
      key_columns: state.keyColumns,
      case_sensitive: state.caseSensitive,
      trim_whitespace: state.trimWhitespace,
      numeric_tolerance: state.numericTolerance,
      decimal_precision: state.decimalPrecision,
      treat_blank_as_zero: state.treatBlankAsZero,
      fuzzy_column_names: state.fuzzyColumnNames,
      control_total_columns: state.controlTotalColumns,
    };
    // Only send an explicit column_map once the user has edited it away
    // from the computed default -- untouched, the server falls back to
    // the catalogue/same-name matching itself (same as the original).
    if (state.colMapEdited) {
      req.column_map = Object.fromEntries(Object.entries(state.columnMap).filter(([, t]) => t));
    }

    this.api.runCompare(req).subscribe({
      next: (res) => {
        this.running = false;
        this.result = res;
        this.compareState.setResult(res);
      },
      error: (err) => {
        this.running = false;
        this.runError = err?.error?.detail ?? "Comparison failed.";
      },
    });
  }
}
