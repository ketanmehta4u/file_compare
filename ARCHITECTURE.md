# How this application works

A walk through the system: what happens from the moment the page loads to
the moment a reconciliation is downloaded, exactly which HTTP calls the
Angular app makes and when, and what the backend does with each of them.

For _running_ the app -- setup, configuration, limits and troubleshooting
-- see [README.md](README.md); for a specification of what it is supposed
to do, see [BUILD_PROMPT.md](BUILD_PROMPT.md).

---

## Contents

- [The shape of the system](#the-shape-of-the-system)
- [The complete workflow](#the-complete-workflow)
- [Frontend to backend: every call](#frontend-to-backend-every-call)
- [Inside a request](#inside-a-request)
- [Inside a comparison](#inside-a-comparison)
- [Frontend structure](#frontend-structure)
- [What is held in memory, and for how long](#what-is-held-in-memory-and-for-how-long)
- [How errors travel](#how-errors-travel)

---

## The shape of the system

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser                                                            │
│   Angular SPA — one page, no router                                │
│   • uploads files      • polls progress    • renders the result    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP, same origin
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ nginx :8080          static files, and /api/* proxied onward       │
└───────────────────────────────┬────────────────────────────────────┘
                                │ /api/*
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Express :3000  ── main thread ─────────────────────────────────────│
│   middleware → routes → in-memory caches                           │
│   never parses a file, never runs a comparison                     │
└───────────────────────────────┬────────────────────────────────────┘
                                │ worker_threads: bytes in, report out
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Comparison worker (one per run, terminated when done)              │
│   parse → map → index → match → foot totals → report               │
│   posts progress messages back as it goes                          │
└────────────────────────────────────────────────────────────────────┘
```

The division of labour is the thing to hold onto: **the main thread owns
I/O and state; the worker owns CPU and data.** The main thread stays
responsive because it never does the heavy work — that is what makes live
progress possible at all.

Without Docker, nginx is absent and Express serves the built SPA itself
(`npm run start:spa`); everything below is otherwise identical.

---

## The complete workflow

### 1. The page loads

`AppComponent.ngOnInit()` fires one request, fire-and-forget:

| Call              | Why                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/config` | The limits the UI must respect: `max_upload_bytes` (checked before uploading) and `max_response_rows` (bounds the preview-rows input). |

The server also exposes `GET /api/auth/me`, but the page does not call
it: there is no login here, so displaying "(unauthenticated)" told a user
nothing. The identity a fronting proxy vouches for is still recorded in
every audit report, server-side.

Before any of that, an `APP_INITIALIZER` applies the branding from
`theme.ts` — CSS custom properties, page title, favicon — so the first
paint is already themed.

### 2. The user picks a source file

Choosing a file in a `FileInputComponent` does **not** upload it. The
component first validates locally:

- the extension is `.csv` or `.xlsx` (a `.xls` is refused here, with the
  same message the server would give, rather than after a wasted upload);
- the size is within `max_upload_bytes`.

If the file is a workbook, it then calls `POST /api/files/list-sheets` so
the user can choose a sheet. That request sends the file but keeps
nothing server-side.

### 3. The user clicks "Load"

`POST /api/files/upload` — multipart, with `sheet_name`, `has_header` and
`delimiter` alongside the file. Angular's `HttpClient` reports upload
progress events, which drive the per-file progress bar.

The server parses the file **once**, to extract metadata, then throws the
parsed table away and caches only the raw bytes (see
[What is held in memory](#what-is-held-in-memory-and-for-how-long)). It
answers with `FileMetaView`: a `file_id` (the first 16 hex of the content
SHA-256), row and column counts, the column names with inferred dtypes,
and any notices — hidden rows/columns, uncalculated formula cells.

The component emits that metadata upward; `CompareStateService` stores it
and recomputes the column mapping.

### 4. The same for the target file

Identical path. Once **both** sides are loaded, the settings panel comes
alive: it can now show the mapping table and the key-column and
control-total pickers, because it knows both column lists.

### 5. Optionally, a catalogue

`POST /api/catalog/upload` returns a `catalog_id` and the datasets inside
it. Selecting one calls
`GET /api/catalog/{catalogId}/datasets/{datasetId}/mapping`, and the
returned mapping pre-fills the column map, the key columns and several
comparison settings. Purely a convenience — everything works without it.

### 6. "Run comparison"

`AppComponent.run()` assembles a `CompareRequest` from the shared state
and calls `POST /api/compare/jobs`. The server validates the request,
registers a job, starts the work in the background, and answers
**immediately** with `{ job_id, status }` — HTTP 202, in milliseconds.

### 7. Polling

The component polls `GET /api/compare/jobs/{jobId}` every 400 ms
(`timer(0, 400)` piped through `switchMap`). Each response carries the
job's status and its progress:

```json
{
  "job_id": "a36ab59d005743a8",
  "status": "running",
  "progress": {
    "phase": "comparing",
    "label": "Comparing matched rows",
    "done": 132000,
    "total": 150000,
    "percent": 55
  },
  "result": null,
  "detail": null
}
```

That drives the progress bar, the phase label, the row counter and the
elapsed clock. Polling stops the moment the status becomes terminal:

| Status               | What the UI does                       |
| -------------------- | -------------------------------------- |
| `queued` / `running` | Keep polling, keep updating the bar    |
| `done`               | Take `result`, render it, stop polling |
| `error`              | Show `detail`, stop polling            |
| `cancelled`          | Say so, stop polling                   |

**Cancel** issues `DELETE /api/compare/jobs/{jobId}`, which terminates the
worker and releases its concurrency slot — it stops the work, rather than
merely hiding it.

### 8. The result renders

The response holds the verdict, the summary counts, the column diff, the
control totals, the warnings, the audit header — and a **preview** of the
detail rows, capped at `max_response_rows`. A `truncation` block says
exactly what was trimmed, and the UI reports it and points at the
downloads. Counts shown anywhere on the page come from `summary`, which
always holds the true totals.

### 9. Downloads

A plain `<a href>` link, not a fetch, so the browser handles
`Content-Disposition` itself:

- `GET /api/compare/{runId}/report.xlsx` — the multi-sheet audit workbook

**It is never capped**, however trimmed the on-screen tables were: the
server still holds the complete report for that run.

The server also serves `GET /api/compare/{runId}/annotated/{side}` -- the
user's own file with a `_record_status` column and differing cells
highlighted -- but the page does not link it, and sends
`annotated_outputs: false` so runs do not carry the per-row statuses that
export needs. It remains available to a direct API caller.

---

## Frontend to backend: every call

Every request the SPA can make, in the order it typically makes them.
`ApiService` is the only place in the frontend that knows any URL.

| #   | When               | Method | Path                                      | Sends                         | Gets back                          |
| --- | ------------------ | ------ | ----------------------------------------- | ----------------------------- | ---------------------------------- |
| 1   | Bootstrap          | GET    | `/api/config`                             | —                             | limits + capability flags          |
| 2   | Workbook picked    | POST   | `/api/files/list-sheets`                  | multipart file                | `{ sheets: [...] }`                |
| 3   | "Load" clicked     | POST   | `/api/files/upload`                       | file + sheet/header/delimiter | `FileMetaView` incl. `file_id`     |
| 4   | Catalogue uploaded | POST   | `/api/catalog/upload`                     | multipart file                | `catalog_id` + datasets            |
| 5   | Dataset picked     | GET    | `/api/catalog/{id}/datasets/{ds}/mapping` | —                             | mapping + default key columns      |
| 6   | Guide link         | GET    | `/api/catalog/template`                   | —                             | blank catalogue `.xlsx`            |
| 7   | "Run comparison"   | POST   | `/api/compare/jobs`                       | `CompareRequest`              | `202 { job_id, status }`           |
| 8   | Every 400 ms       | GET    | `/api/compare/jobs/{jobId}`               | —                             | status, progress, result when done |
| 9   | "Cancel"           | DELETE | `/api/compare/jobs/{jobId}`               | —                             | `{ cancelled }`                    |
| 10  | Download link      | GET    | `/api/compare/{runId}/report.xlsx`        | —                             | workbook                           |

Conventions across all of them:

- **Same origin.** In production nginx proxies `/api/*` to the backend; in
  development `ng serve` proxies it (`frontend/proxy.conf.json`). The
  frontend never holds a base URL, and there is no CORS in the normal path.
- **JSON is `snake_case`** on the wire, matching the original app's
  contract. Decimals cross as **strings** and dates as ISO strings — a
  money value is never a JavaScript `number`.
- **Errors are `{ "detail": "..." }`** with a meaningful status. The UI
  reads `err.error.detail` and shows it verbatim.
- **Files travel as multipart**; nothing is base64-encoded.
- **No authentication is performed by the client.** Identity, if any,
  arrives on a header set by a fronting proxy.

### What `POST /api/compare/jobs` carries

Only the two `file_id`s are required. Everything else is optional and
mirrors the settings panel:

```jsonc
{
  "source_file_id": "639cb758f4e2830e",
  "target_file_id": "4969c181dd5c8bcb",

  "column_map": { "txn_id": "transaction_id" }, // source col -> target col
  "drop_unmapped": true,
  "key_columns": ["transaction_id"], // empty = whole-row match

  "catalog_id": "30fc...",
  "dataset_id": "GL_MONTHLY", // instead of column_map

  "case_sensitive": true,
  "trim_whitespace": true,
  "treat_blank_as_zero": false,
  "fuzzy_column_names": false,
  "numeric_tolerance": "0.01", // decimal string, never a float
  "decimal_precision": 2, // null = compare in full
  "control_total_columns": ["amount_local"],
  "enforced_dtypes": { "gl_account": "id" },
}
```

The frontend sends `column_map` only once the user has edited it away from
the computed default; left alone, the server falls back to the catalogue
mapping or to same-name matching.

---

## Inside a request

Middleware order in `app.ts`, and why it is that order:

```
  request
    │
    ├─ CORS                    allowed origins only (unused same-origin)
    ├─ trust proxy             so req.ip is the client, not nginx
    ├─ bodySizeGuard           413 on Content-Length before a byte streams
    ├─ securityHeaders         CSP, nosniff, frame-deny, HSTS
    ├─ requestLog              correlation id; one structured line per response
    ├─ express.json()          JSON bodies (multipart is per-route, via multer)
    │
    ├─ /api  health · auth · config · catalog · files · compare
    │
    └─ error handler           logs, then 500 { detail }
```

- **The size guard runs first** because it can refuse a request before the
  body arrives; the header check is advisory, and multer enforces the real
  byte count per upload.
- **Rate limiting is per route**, keyed by authenticated user when there is
  one and by client IP otherwise — which is why `trust proxy` matters:
  without it every client behind nginx shares one bucket.
- **The concurrency gate** is not middleware for job runs. A job holds its
  slot for as long as the work takes, not until the HTTP response ends.

---

## Inside a comparison

What happens between `POST /api/compare/jobs` and `status: "done"`:

```
route: prepareCompare()          validate; resolve mapping; build settings
   │                             (no parsing, no table -- metadata only)
   ▼
compareJobs.startCompareJob()    register job, return job_id NOW
   │
   ├─ acquireCompareSlot()       wait for a concurrency slot (503 on timeout)
   │
   ▼
runComparisonInWorker()          spawn worker; Decimals boxed for transfer
   │
   │   ┌──────────── worker thread ─────────────────────────────┐
   │   │ loadBytes(source) · loadBytes(target)   parse from bytes│
   │   │ applyMapping(both)                      canonical names │
   │   │ compareColumns()                        column diff     │
   │   │ compareRecords()                        the hash join   │
   │   │    buildIndex(source)  ──► progress: indexing_source     │
   │   │    buildIndex(target)  ──► progress: indexing_target     │
   │   │    match keys          ──► progress: matching            │
   │   │    compare pairs       ──► progress: comparing           │
   │   │ controlTotals()        ──► progress: control_totals      │
   │   │ assemble report        ──► progress: reporting           │
   │   └──────────────┬──────────────────────────────────────────┘
   │                  │ postMessage: progress … then the report
   ▼                  ▼
job.progress updated on every message   (what polling reads)
   │
   ▼
runCache.set(runId, { report, file ids, mapping })
compareToResponse()              cap detail rows, add truncation block
   │
   ▼
job.status = "done", job.result = response
   │
   └─ releaseCompareSlot()       always, including on error and cancel
```

Two details worth knowing if you touch this:

- **Decimals do not survive a structured clone.** They are boxed into a
  tagged marker crossing the thread boundary and rebuilt on the other side
  (`worker/transfer.ts`). Binary data passes through untouched — walking a
  `Buffer` generically would rebuild it as `{0: 105, 1: 100, …}`.
- **The worker entry is resolved by the extension of `__filename`**, so
  production loads the compiled `.js` and dev/tests load the `.ts` through
  the tsx loader. Both run the real worker; there is no stand-in.

---

## Frontend structure

```
AppComponent ....... the page: bootstraps auth/config, owns the run,
                     polls the job, holds the result
  ├── HowToUseComponent ....... collapsible guide (static content)
  ├── FileInputComponent ×2 ... source and target; validate, upload,
  │                             report metadata upward
  ├── CatalogPickerComponent .. optional; collapsed by default
  ├── SettingsPanelComponent .. mapping table, key/control-total pickers,
  │                             collapsible matching options
  └── ResultsComponent ........ verdict, summary, diffs, downloads

CompareStateService .. the single source of truth for the form
ApiService ........... the only place that knows a URL
AuthService / ConfigService ... bootstrap state
ThemeService ......... branding, applied before first paint
```

**State lives in one service, not in the components.** `CompareStateService`
holds a `BehaviorSubject<CompareFormState>` — the two files' metadata, the
column map, key columns, control totals and every comparison setting — and
exposes derived views (`commonColumns$`, `numericColumns$`, `usedTargets$`)
as observables. Components read it and patch it; none of them owns a piece
of the form the others need.

Two behaviours in that service are load-bearing:

- **The pickers list post-mapping (target) column names**, because those are
  the names the engine will actually see.
- **Editing the mapping prunes stale selections.** Re-pointing a mapping row
  can strand a checked key column — it disappears from the panel while
  remaining in the request — and the engine would then warn and silently
  fall back to whole-row matching, returning a run that does not match the
  settings on screen.

---

## What is held in memory, and for how long

Nothing is written to disk, and nothing survives a restart.

| Store          | Holds                                        | Keyed by                       | Evicted                                                       |
| -------------- | -------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `fileCache`    | uploaded **bytes** + metadata + load options | content SHA-256 (first 16 hex) | by **bytes**, against a budget derived from the V8 heap limit |
| `catalogCache` | parsed catalogue                             | content hash                   | by count (~60)                                                |
| `runCache`     | the full report + file ids + mapping         | random run id                  | by count (~10)                                                |
| job registry   | status, progress, finished response          | random job id                  | ~40 entries, 30-minute TTL                                    |

The reason uploads are cached as bytes rather than parsed tables: a parsed
table costs roughly 12× the file it came from, so caching parses made
resident memory a large multiple of what users had uploaded. Re-parsing
costs about 200 ms — trivial against a comparison measured in minutes.

Consequences worth knowing:

- **Identical uploads are shared.** Two users uploading the same bytes get
  the same `file_id` and one cache entry.
- **Eviction is normal**, and produces "re-upload" errors rather than
  wrong answers.
- **An annotated download re-parses its source file**, so if that upload
  has been evicted the download fails with a clear message even though the
  run itself is still cached.
- **Single process only.** These are module-level singletons; a second
  replica would not see the first one's uploads.

---

## How errors travel

Every failure reaches the user as `{ "detail": "..." }` with a status, and
the UI renders `detail` verbatim — so the message the engine writes is the
message the user reads.

What decides the status is the _kind_ of error, in one place
(`api/errors.ts`): an `HttpError` carries its own status; an `InputError`
— raised by the loaders and the catalogue parser for anything wrong with
the caller's data — is a 400 with its message; anything else is a 500
with a generic message and the real one logged against the request id. An
`InputError` raised inside the comparison worker keeps its meaning too: a
class does not survive the thread boundary, so a flag travels with the
message and the error is rebuilt on the other side.

| Where it fails                                           | Status                | What the user sees                                                                  |
| -------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| File too large (header)                                  | 413                   | "Request body exceeds the server's upload limit…"                                   |
| File too large (actual)                                  | 400                   | multer's limit error                                                                |
| Legacy `.xls`                                            | 400                   | "…please re-save as .xlsx or .csv" — usually caught client-side first               |
| Unknown/evicted `file_id`                                | 404                   | "Source file not in cache — re-upload."                                             |
| Bad request (tolerance, dtype, duplicate mapping target) | 400                   | the specific complaint                                                              |
| No concurrency slot                                      | 503 + `Retry-After`   | "Server busy — N comparison(s) already running…"                                    |
| Failure inside the worker                                | job `status: "error"` | `detail` on the next poll                                                           |
| Anything unhandled                                       | 500                   | "Internal server error." (the real message only in the log, against the request id) |

Not everything that goes wrong is an error, and this matters for a
reconciliation tool: hidden Excel rows, uncalculated formulas read as
blank, duplicate keys, and a key column missing from one side all produce
a **successful run carrying warnings**, which the UI shows above the
result. They change what the numbers mean, so they are surfaced rather
than swallowed.
