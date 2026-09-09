import { Component, OnDestroy, OnInit } from "@angular/core";
import { Observable, Subscription, timer } from "rxjs";
import { switchMap } from "rxjs/operators";
import { AuthService } from "./core/auth.service";
import { ConfigService } from "./core/config.service";
import { ApiService } from "./core/api.service";
import { CompareStateService, type CompareFormState } from "./core/compare-state.service";
import { theme } from "./theme";
import type { CompareRequest, CompareResultResponse, ConfigInfo, FileMetaView, JobProgress } from "./shared/models/dto";

/** Root shell -- port of the original's App.tsx. Bootstraps auth/config,
 * renders the branded header/footer (from theme.ts), and composes the
 * catalog picker, source/target file inputs, settings panel, run button,
 * and results into one page (no router -- single-page app). */
@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
})
export class AppComponent implements OnInit, OnDestroy {
  readonly theme = theme;
  config: ConfigInfo | null = null;
  user = "";

  result: CompareResultResponse | null = null;
  runError = "";
  running = false;

  /** Live progress of the comparison currently running, if any. */
  progress: JobProgress | null = null;
  private jobId: string | null = null;
  private pollSub: Subscription | null = null;
  private startedAt = 0;
  /** "1m 20s" while a comparison runs -- on a run measured in minutes, a
   * bar alone leaves the user unsure whether anything is still happening. */
  elapsedLabel = "";

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

  /** Stops polling a job we are no longer interested in. */
  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  /** Asks the server to stop the running comparison. The job is cancelled
   * server-side (its worker is terminated), so this frees the slot for
   * other users rather than just hiding the result. */
  cancel(): void {
    const jobId = this.jobId;
    if (!jobId) return;
    this.stopPolling();
    this.api.cancelCompareJob(jobId).subscribe({
      next: () => this.finishRun("Comparison cancelled."),
      error: () => this.finishRun("Comparison cancelled."),
    });
  }

  private finishRun(message: string): void {
    this.running = false;
    this.jobId = null;
    this.progress = null;
    this.elapsedLabel = "";
    this.runError = message;
  }

  private updateElapsed(): void {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.elapsedLabel = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  /** Clears the whole form back to a blank slate -- the files, the
   * mapping, the settings and the result. */
  startOver(): void {
    this.stopPolling();
    this.compareState.reset();
    this.result = null;
    this.runError = "";
    this.progress = null;
    this.elapsedLabel = "";
  }

  /** Polls a job until it reaches a terminal state, updating progress on
   * the way. 400ms is frequent enough to feel live without hammering the
   * server on a run that takes minutes. */
  private pollJob(jobId: string): void {
    this.pollSub = timer(0, 400)
      .pipe(switchMap(() => this.api.compareJob(jobId)))
      .subscribe({
        next: (job) => {
          this.progress = job.progress;
          this.updateElapsed();
          if (job.status === "done" && job.result) {
            this.stopPolling();
            this.running = false;
            this.jobId = null;
            this.progress = null;
            this.elapsedLabel = "";
            this.result = job.result;
            this.compareState.setResult(job.result);
            return;
          }
          if (job.status === "error") {
            this.stopPolling();
            this.finishRun(job.detail ?? "Comparison failed.");
            return;
          }
          if (job.status === "cancelled") {
            this.stopPolling();
            this.finishRun("Comparison cancelled.");
          }
        },
        error: (err) => {
          this.stopPolling();
          this.finishRun(err?.error?.detail ?? "Lost contact with the comparison.");
        },
      });
  }

  run(state: CompareFormState): void {
    if (!state.sourceFile || !state.targetFile) return;
    // Defensive: the button is disabled while a run is in flight, but a
    // second poller left running would poll forever and hammer the server.
    this.stopPolling();
    this.running = true;
    this.runError = "";
    this.progress = null;
    this.startedAt = Date.now();
    this.elapsedLabel = "0s";

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
      annotated_outputs: state.annotatedOutputs,
    };
    // Only send an explicit column_map once the user has edited it away
    // from the computed default -- untouched, the server falls back to
    // the catalogue/same-name matching itself (same as the original).
    if (state.colMapEdited) {
      req.column_map = Object.fromEntries(Object.entries(state.columnMap).filter(([, t]) => t));
    }

    // Started as a background job rather than one long request: the
    // server answers immediately with an id, and progress is polled while
    // it works. A large comparison can take minutes, which is well past
    // what an intermediate proxy will hold a connection open for.
    this.api.startCompareJob(req).subscribe({
      next: (started) => {
        this.jobId = started.job_id;
        this.pollJob(started.job_id);
      },
      error: (err) => {
        this.running = false;
        this.runError = err?.error?.detail ?? "Comparison failed.";
      },
    });
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }
}
