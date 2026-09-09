import { CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { TestBed, fakeAsync, tick, discardPeriodicTasks } from "@angular/core/testing";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { AppComponent } from "./app.component";
import { CompareStateService } from "./core/compare-state.service";
import type { CompareFormState } from "./core/compare-state.service";
import type { CompareJobView, FileMetaView } from "./shared/models/dto";

function fileMeta(id: string): FileMetaView {
  return {
    file_id: id,
    filename: `${id}.csv`,
    sha256: id.padEnd(64, "0"),
    size_bytes: 1,
    row_count: 2,
    column_count: 1,
    columns: ["id"],
    dtypes: [["id", "text"]],
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

function jobView(over: Partial<CompareJobView>): CompareJobView {
  return {
    job_id: "job1",
    status: "running",
    progress: null,
    result: null,
    detail: null,
    ...over,
  };
}

describe("AppComponent comparison progress", () => {
  let http: HttpTestingController;
  let component: AppComponent;
  let state: CompareStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [AppComponent],
      imports: [HttpClientTestingModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
    const fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    state = TestBed.inject(CompareStateService);
    state.setSourceFile(fileMeta("src"));
    state.setTargetFile(fileMeta("tgt"));
  });

  function currentState(): CompareFormState {
    return state.value;
  }

  /** Answers the initial POST that queues the job. */
  function startRun(): void {
    component.run(currentState());
    http.expectOne({ method: "POST", url: "/api/compare/jobs" }).flush({ job_id: "job1", status: "queued" });
  }

  it("starts a background job rather than one long request", () => {
    component.run(currentState());
    const req = http.expectOne({ method: "POST", url: "/api/compare/jobs" });
    expect(req.request.body.source_file_id).toBe("src");
    expect(req.request.body.annotated_outputs).toBe(true);
    req.flush({ job_id: "job1", status: "queued" });
    expect(component.running).toBe(true);
    component.ngOnDestroy();
  });

  it("shows live progress while the job runs", fakeAsync(() => {
    startRun();

    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(
      jobView({ progress: { phase: "comparing", label: "Comparing matched rows", done: 5000, total: 20000, percent: 72 } })
    );

    expect(component.progress?.label).toBe("Comparing matched rows");
    expect(component.progress?.done).toBe(5000);
    expect(component.progress?.percent).toBe(72);
    expect(component.result).toBeNull();

    component.ngOnDestroy();
    discardPeriodicTasks();
  }));

  it("keeps polling until the job finishes, then shows the result", fakeAsync(() => {
    startRun();

    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(jobView({ status: "running" }));

    tick(400);
    const done = jobView({
      status: "done",
      result: { run_id: "run1", summary: { matched_equal: 9 } } as never,
    });
    http.expectOne("/api/compare/jobs/job1").flush(done);

    expect(component.running).toBe(false);
    expect(component.progress).toBeNull();
    expect(component.result?.run_id).toBe("run1");

    // Polling must stop once the job is done, or it would hammer the
    // server for the rest of the session.
    tick(2000);
    http.expectNone("/api/compare/jobs/job1");
    discardPeriodicTasks();
  }));

  it("surfaces a failed job's message", fakeAsync(() => {
    startRun();
    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(jobView({ status: "error", detail: "Key column missing." }));

    expect(component.running).toBe(false);
    expect(component.runError).toBe("Key column missing.");
    tick(2000);
    http.expectNone("/api/compare/jobs/job1");
    discardPeriodicTasks();
  }));

  it("cancels server-side so the slot is freed, not just hidden", fakeAsync(() => {
    startRun();
    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(jobView({ status: "running" }));

    component.cancel();
    const cancelReq = http.expectOne({ method: "DELETE", url: "/api/compare/jobs/job1" });
    cancelReq.flush({ job_id: "job1", status: "cancelled", cancelled: true });

    expect(component.running).toBe(false);
    expect(component.runError).toContain("cancelled");
    tick(2000);
    http.expectNone("/api/compare/jobs/job1");
    discardPeriodicTasks();
  }));

  it("shows elapsed time while a comparison runs", fakeAsync(() => {
    startRun();
    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(jobView({ status: "running" }));
    expect(component.elapsedLabel).toBeTruthy();

    component.ngOnDestroy();
    discardPeriodicTasks();
  }));

  // Start over has to clear the shared form state too, not just the local
  // result -- otherwise the previous files and mapping linger invisibly.
  it("clears everything when starting over", fakeAsync(() => {
    startRun();
    tick(0);
    const done = jobView({ status: "done", result: { run_id: "run1", summary: {} } as never });
    http.expectOne("/api/compare/jobs/job1").flush(done);
    expect(component.result).not.toBeNull();

    component.startOver();

    expect(component.result).toBeNull();
    expect(component.runError).toBe("");
    expect(component.elapsedLabel).toBe("");
    expect(state.value.sourceFile).toBeNull();
    expect(state.value.targetFile).toBeNull();
    discardPeriodicTasks();
  }));

  it("stops polling when the component is destroyed", fakeAsync(() => {
    startRun();
    tick(0);
    http.expectOne("/api/compare/jobs/job1").flush(jobView({ status: "running" }));

    component.ngOnDestroy();
    tick(2000);
    http.expectNone("/api/compare/jobs/job1");
    discardPeriodicTasks();
  }));

  afterEach(() => {
    http.verify();
  });
});
