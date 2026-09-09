# Build prompt — Financial File Reconciliation (Angular + Express)

This is a **specification prompt for the application that actually lives in
this repository**. Hand it to a developer or an AI assistant and it should
be enough to rebuild this project from an empty directory.

It is written after the fact, from the finished code — every rule below is
one the shipped engine, API, or UI actually implements. Where a decision
was deliberate (and where the obvious alternative was rejected), the reason
is stated, because those are the points a rebuild is most likely to get
wrong.

> Not to be confused with `prompt.md`, which is an earlier, **rejected**
> specification proposing a client-side/Web Worker architecture that was
> never built. If the two disagree, this file is right.

---

## 1. What to build

A web application for reconciling two structured data files against each
other. A user opens a page, uploads a **source** file and a **target**
file (`.csv` or `.xlsx`), optionally tells the app how the two files'
columns line up and which columns identify a row, and gets back a
reconciliation: which rows exist on only one side, which rows matched but
differ, exactly which cells differ and by how much, whether the numeric
column totals tie out, and a single plain-language verdict. The result is
downloadable as a multi-sheet Excel audit workbook.

The domain is financial reconciliation, so the governing requirement is
**exactness**: money must never round or drift, and the app must never
quietly return a comparison different from the one the user asked for.
Where a shortcut would trade correctness for convenience, take the
correct path.

### Non-goals

- No database, no user accounts, no persistence. Everything is in memory.
- No client-side parsing. The browser uploads bytes; the server does all
  the work.
- No legacy `.xls` (OLE2) support.
- No cloud blob storage integration.

---

## 2. Stack (fixed)

| Part | Choice |
|---|---|
| Frontend | Angular **14.3.0** framework packages, scaffolded with Angular CLI **14.2.13** |
| Backend | **Express 5** + **TypeScript**, Node **25.8-alpine** in Docker |
| Excel I/O | `exceljs` |
| CSV | `papaparse` + `iconv-lite` |
| Decimal math | `decimal.js` |
| Dates | `date-fns` |
| Uploads | `multer`, memory storage |
| Caching | `lru-cache` |
| Logging | `pino` |
| Backend tests | `vitest` + `supertest` |
| Frontend tests | Karma + Jasmine |
| Serving | nginx `1.29-alpine` static + reverse proxy |

Two version traps worth knowing before you start:

- **There is no `@angular/cli@14.3.0`** — the CLI line stops at 14.2.13.
  Scaffold with the CLI at 14.2.13 and pin the *framework* packages
  (`@angular/core` and siblings) to `^14.3.0`. The CLI is a dev-time tool
  and is not shipped.
- **Pin `@types/node` to `^16.18.0` in the frontend.** Left unpinned, npm
  resolves transitive `"@types/node": "*"` constraints to a current
  release whose type definitions use syntax Angular 14's bundled
  TypeScript (4.7.x) cannot parse, and the build fails on files you never
  wrote. This is compile-time only and has no bearing on the Node version
  the app runs under.

---

## 3. Architecture

Two containers:

```
browser ──► nginx (serves the built Angular SPA, :8080)
                │  /api/* proxied
                ▼
            Express (:3000) ──► comparison engine (in-process)
```

Everything the engine touches lives in memory. Uploaded bytes are parsed
into a table, the table is cached under a content hash, and the comparison
runs synchronously in the Node process. Nothing is written to disk.

### Backend layout

```
backend/src/
  server.ts              process entry
  app.ts                 Express app assembly (middleware order matters)
  config/env.ts          every env var read through here
  cache/stores.ts        the three LRU caches
  api/
    dto.ts               the wire contract (snake_case)
    toView.ts            engine types -> DTOs (Decimal/Date -> string)
    upload.ts            multer, memory storage
    middleware/          bodySizeGuard, securityHeaders, requestLog,
                         rateLimit, compareSlot, currentUser
    routes/              health, auth, config, catalog, files, compare
  engine/
    decimal.ts dates.ts normalise.ts equality.ts   primitives
    rowKey.ts compareRecords.ts columnDiff.ts controlTotals.ts
    runComparison.ts                              orchestration
    fileLoad/            csv.ts excel.ts hash.ts
    catalog.ts catalogTemplate.ts
    report/              buildExcelReport.ts annotate.ts auditRows.ts
```

Keep the engine free of any Express or HTTP awareness — it takes tables and
settings and returns a report. That separation is what makes the engine
directly testable, and most of the test suite depends on it.

---

## 4. The comparison engine

This is the heart of the application. Build it first, test it hard, and
only then put an API on it.

### 4.1 Loading files

**CSV.** Detect encoding, detect the delimiter unless one is supplied,
read every cell as a **string** (never let a CSV parser infer types — that
is where leading zeros and precision die). Support a "first row is header"
toggle; without a header, synthesise column names.

**XLSX.** Read every cell as a string too, via a best-effort conversion
that handles numbers, dates, booleans, rich text, hyperlinks, and formula
cells with a cached result. Two things must be *detected and reported*,
not silently swallowed:

- **Hidden rows and columns.** They are included in the comparison, and
  the user is warned they exist. Silently including hidden data without
  saying so, or silently dropping it, are both wrong.
- **Uncalculated formula cells** (a formula with no cached result). These
  read as blank; count them and name the columns they are in so the user
  can recompute and re-upload.

Reject legacy `.xls` by **magic bytes** (OLE2 signature `D0 CF 11 E0 A1
B1 1A E1`), not by file extension, with a message telling the user to
re-save as `.xlsx` or `.csv`. Confirm `.xlsx` by its ZIP signature (`PK\x03\x04`)
for the same reason: extensions lie, and a mislabelled file should get a
clear diagnosis rather than a parser stack trace.

Every load computes a **SHA-256 of the raw bytes**. It identifies the file
in the cache, and it goes in the audit trail — a reconciliation you cannot
tie back to exact input bytes is not an audit.

Also infer a per-column dtype label (`numeric`, `date`, `text`) for
display and for column-level dtype-mismatch reporting.

### 4.2 Normalising a cell

Before any two values are compared, both go through one normalisation
function producing a tagged value: `null`, `numeric` (Decimal), `date`,
`timestamp`, or `text`. The dispatch order is load-bearing:

1. `null`/`undefined`/`NaN` → null.
2. Optionally trim whitespace; then empty string and the tokens
   `nan`, `none`, `null` (case-insensitive) → null.
3. A per-column **enforced dtype** override, if configured:
   - `id` → never coerce. Keep the exact text, so `007` stays `007` and
     is never read as the number 7. Account codes and transaction ids
     must survive intact.
   - `timestamp` → force a full datetime parse, preferring the raw value
     over the trimmed string so an Excel datetime cell keeps its
     fractional time of day.
4. Otherwise try **numeric**, then **date**, then fall back to text.

Numeric parsing must accept the shapes finance files actually contain:
thousands separators, currency symbols, percentage signs, and
**parenthesised negatives** — `($8,400.50)` is `-8400.50`. Parse to an
arbitrary-precision Decimal. Never use JavaScript `number` for a monetary
value anywhere in the pipeline.

Date parsing tries an ordered format list, and **the order encodes the
ambiguity policy**: ISO-like formats first, then day-month-year *before*
month-day-year, then month-name formats. `03/04/2024` is 3 April, not
4 March. Also accept Excel serial numbers, using the `1899-12-30` epoch —
this deliberately reproduces Excel's phantom 1900 leap day rather than
"correcting" it, because the goal is to agree with Excel, not with the
calendar.

### 4.3 Equality

Two normalised values are equal when their kinds agree and their values
agree, with these rules:

- **Numeric**: compare as Decimals. If a `numeric_tolerance` is set, a
  difference within it counts as *matched within tolerance* — a distinct
  outcome from "equal", reported separately, never folded into it. If
  `decimal_precision` is set, quantise to that many places first;
  unset means exact.
- **Text**: honour `case_sensitive` and `trim_whitespace`.
- **Blank vs zero**: only equal when `treat_blank_as_zero` is on.
- **Cross-kind** (e.g. numeric vs text): not equal.

### 4.4 Matching rows

Hash-join the two tables on a **row key**:

- With **key columns** configured, the key is those columns' normalised
  values.
- With **none** configured, the key is the whole normalised row in sorted
  column order — a deterministic whole-row match.

If a configured key column is **missing from either side**, do not fail
silently and do not pretend: emit an explicit warning naming the columns
and fall back to whole-row matching. (A user can reach this state through
the UI by re-pointing a column mapping after choosing keys.)

Handle duplicate keys explicitly — count duplicate keys and duplicate rows
per side and report them. Within a duplicate-key group, pair rows that are
identical and leave the rest unmatched on both sides rather than pairing
them arbitrarily.

Every matched pair is then compared cell by cell over the common columns,
producing a `ValueDifference` per differing cell: the key, the column, both
raw values, the **decimal delta** for numerics, whether it fell within
tolerance, and the **1-based row numbers on each side** (offset by whether
the file had a header, so the numbers point at real spreadsheet rows the
user can go and look at).

Each row ends up in exactly one status: `source_only`, `target_only`,
`matched_equal`, `matched_with_differences`, `matched_with_tolerance`.

### 4.5 Column diff and control totals

Compare the two column sets: source-only, target-only, common, **sequence
mismatches** (a common column in a different position on each side), and
**dtype mismatches**. Optionally match column names fuzzily.

Compute **control totals**: for each numeric column (all of them by
default, or a chosen subset), sum both sides as Decimals and report
whether they tie out. This is the independent check that catches an error
the row-level diff misses.

### 4.6 The verdict

Roll everything into one outcome. Hard breaks are source-only rows,
target-only rows, matched-with-differences rows, and control totals that
do not tie out:

- No hard breaks and nothing within tolerance → `RECONCILED — no
  differences found`.
- No hard breaks but some rows within tolerance → `RECONCILED WITHIN
  TOLERANCE — N row(s) differ but stay within the numeric tolerance`.
- Otherwise → `DIFFERENCES FOUND — N break(s) require review`.

Carry an **audit header** through with it: generation timestamp, both
files' names and SHA-256s and row/column counts, every setting in force,
the mapping used, and the user the request was attributed to.

### 4.7 Reports

**Audit workbook** (`.xlsx`): sheets for Audit Header, Summary, Warnings,
Column Differences, the row/difference detail sheets, and Control Totals.
Excel's hard limit is 1,048,576 rows — when a sheet would exceed it, spill
that sheet's data to a CSV attachment and leave a placeholder note in the
sheet rather than truncating or crashing.

**Annotated file export**: return the user's own source or target file
back with a `_record_status` column added and differing cells highlighted
(amber for a differing cell, green/red/etc. per row status). Over the row
cap, stream CSV in chunks instead of buffering a whole workbook.

---

## 5. Optional dataset catalogue

An optional uploaded `.xlsx` **catalogue** describes datasets: for each
one, a canonical column name per field, which source column maps to it,
which fields are keys, a dtype (including `id` and `timestamp`, which
become the enforced-dtype overrides above), and per-dataset defaults for
tolerance, case sensitivity, whitespace, and blank-as-zero.

Picking a dataset pre-fills the column mapping, the key columns, and those
settings, and additionally produces **compliance warnings** when an
uploaded file's columns do not match what the catalogue says they should
be. Also serve a downloadable blank catalogue template.

The catalogue is a convenience, never a requirement: two files with
matching column names must compare with no catalogue at all.

---

## 6. HTTP API

All routes under `/api`, all JSON `snake_case`, all errors
`{"detail": "..."}` with a meaningful status. Decimals cross the wire as
**strings**, dates as ISO strings — never raw Decimal or Date objects.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/livez` | Liveness |
| GET | `/api/readyz` | Readiness + cache sizes |
| GET | `/api/auth/me` | Current user (from proxy SSO headers) |
| GET | `/api/config` | Upload cap, Excel row cap, feature flags |
| GET | `/api/catalog/template` | Blank catalogue template `.xlsx` |
| POST | `/api/catalog/upload` | Upload catalogue → `catalog_id` + datasets |
| GET | `/api/catalog/:catalogId/datasets/:datasetId/mapping` | Mapping for a dataset |
| POST | `/api/files/upload` | Upload one file → `file_id` + metadata |
| POST | `/api/files/list-sheets` | Sheet names in a workbook |
| POST | `/api/compare/run` | Run a comparison synchronously → full result + `run_id` |
| POST | `/api/compare/jobs` | Start a comparison in the background → `job_id` |
| GET | `/api/compare/jobs/:jobId` | Live progress; the result once done |
| DELETE | `/api/compare/jobs/:jobId` | Cancel a queued or running comparison |
| GET | `/api/compare/:runId/report.xlsx` | Audit workbook |
| GET | `/api/compare/:runId/annotated/:side` | Annotated source/target |

`POST /api/compare/run` takes `source_file_id`, `target_file_id`, and
optionally `catalog_id` + `dataset_id`, `column_map` (source column →
target column), `drop_unmapped`, `key_columns`, `case_sensitive`,
`trim_whitespace`, `numeric_tolerance` (decimal string), `decimal_precision`,
`treat_blank_as_zero`, `fuzzy_column_names`, `control_total_columns`, and
`enforced_dtypes`. An explicit `column_map` takes precedence over the
catalogue mapping. It returns the run id, summary counts, column diff,
source-only and target-only rows, value differences, control totals,
warnings, the audit header with the outcome, and catalogue compliance
warnings.

Upload metadata returns the file id (content hash prefix), filename,
SHA-256, size, row and column counts, columns and inferred dtypes, sheet
name, encoding, delimiter, and the hidden-data and uncalculated-formula
notices.

### Running the comparison off the main thread

Node has one event loop, and this engine is CPU-bound: run it inline and a
large comparison freezes the whole server. Measured on a 150k-row pair,
the process answered *nothing* for the entire run -- health checks
included, which is enough for an orchestrator to decide the container is
dead and restart it mid-comparison.

So run the engine in a `worker_threads` worker. The engine itself stays
synchronous and unchanged; it just takes an optional progress reporter,
and in the worker that reporter is a `postMessage`, which the main thread
receives on its own loop. That is what makes live progress possible at
all: the server can only tell you it is 60% done if it can still answer
you while working.

Two details that bite:

- **A structured clone strips class prototypes.** Decimals arrive on the
  other side as inert objects with no methods -- catastrophic for money
  values, and silent. Box them into a tagged marker on the way out and
  rebuild them on the way in, generically rather than field-by-field:
  Decimals occur in the settings, the value differences, the control
  totals *and* inside normalised row keys.
- **Loading a TypeScript worker.** Compiled, the worker is a sibling .js
  file. Under a TS runner (dev, tests) Node cannot load .ts in a worker by
  itself -- resolve the entry by the extension of `__filename` and pass
  the TS loader through `execArgv` when it is `.ts`, so dev and the test
  suite exercise the real worker rather than a stand-in.

Cloning the parsed tables into the worker is cheap enough to ignore
(~0.4s per 150k-row side, against a comparison measured in minutes);
don't contort the cache design to avoid it without measuring first.

### Progress and long-running comparisons

A comparison can take minutes, which is longer than intermediate proxies
will hold a connection open, so expose it as a job: `POST` starts it and
returns an id, a `GET` reports live progress and carries the result once
finished, and a `DELETE` cancels it (terminate the worker and release its
concurrency slot). Keep a synchronous route too if you have existing
callers, but point large work at the job route.

Report progress per phase with real counts -- indexing each side, then
matched rows compared, then footing the control totals. Two things matter
more than they sound:

- **Every expensive phase needs its own count.** Footing the control
  totals re-normalises every cell of every numeric column on both sides;
  on a measured run it was 40% of the total time. Left uncounted, the bar
  sat at 95% for the better part of a minute, which reads as a hang.
- **Weight the phases from a measurement, not a guess**, and never let the
  percentage go backwards -- a retreating progress bar reads as a bug even
  when the run is healthy.

### Trim the screen, never the download

Return the detail sections (source-only rows, target-only rows, cell
differences) capped to a configurable number of rows, and say so in the
payload: a `truncation` block giving the limit, and per section how many
were returned out of how many exist. Two rules make this safe:

- **The summary counts stay true.** They come from the full result, so a
  capped preview never understates the reconciliation itself. Anything the
  UI labels with a count -- tab headings included -- must read the summary,
  not the length of the array it was handed.
- **Downloads are never capped.** The complete report stays server-side,
  so the workbook and the annotated files contain every row. The UI must
  say plainly that the on-screen tables are partial and point at the
  downloads; a user who does not know the view is trimmed will read a
  reconciliation as complete when it is not, which in this domain is the
  worst failure the product can have.

This is not only about payload size. Uncapped, a 150k-row all-different
run returned ~28 MB to draw 100 rows -- but worse, V8 refuses to build a
single string over 512 MB, so a large enough result would have thrown
while serialising rather than returning anything at all, when the user
could perfectly well have downloaded it.

### Cross-cutting middleware

Order matters: body-size guard → security headers → request logging →
JSON body parsing → routes → error handler.

- **Body-size guard**: reject on `Content-Length` before the body streams;
  multer's own limit enforces actual bytes read.
- **Security headers**: nosniff, `X-Frame-Options: DENY`, referrer policy,
  permissions policy, CSP, HSTS — set only if not already present.
- **Request logging**: a short correlation id per request and one
  structured line per response with method, path, status, duration, user,
  and client IP. Capture the path when the request *arrives* — read it in
  the `finish` handler and Express will already have rewritten the URL for
  the mounted router, logging `/compare/run` instead of `/api/compare/run`.
- **Rate limiting**: per authenticated user, else per client IP, with
  IPv6 addresses normalised (otherwise a client varies its own address's
  textual form and gets a fresh bucket each time). Roughly 30/min uploads,
  10/min comparisons, 20/min downloads.
- **Concurrency gate**: a counting semaphore capping simultaneous
  comparisons, with a queue timeout returning 503 + `Retry-After`. The
  engine is CPU- and memory-heavy; N concurrent large runs is N times peak
  memory. Release the slot exactly once — both `finish` and `close` can
  fire for the same response.
- **Identity**: no login. Trust an identity header already verified by a
  fronting proxy (`x-ms-client-principal-name`, `x-auth-request-email`,
  `x-forwarded-user`, `x-auth-username`, `remote-user`), first non-empty
  wins.
- **`trust proxy`**: set it. Without it `req.ip` is the *proxy's* address
  for every request, which collapses all per-IP rate limiting into one
  shared bucket and makes the logged client IP useless. Default to
  trusting one hop; make it configurable so a directly-exposed deployment
  can turn it off rather than believe a client-supplied
  `X-Forwarded-For`.

### Caching: keep bytes, not parses

Cache the **uploaded bytes**, not the parsed table, and re-parse on demand
in whichever worker needs the data. A parsed table costs an order of
magnitude more than the file it came from (measured: each cached 5.4 MB /
150k-row file retained ~26 MB of heap; caching bytes instead costs ~0 MB
of heap and 5.4 MB of external buffer), and re-parsing takes ~200ms
against comparisons measured in minutes. Parse once at upload for the
metadata the UI needs -- columns, dtypes, row counts, hidden-data notices
-- then keep the bytes and the metadata and drop the table. Store the load
options alongside, so every later parse yields exactly the columns the
user was shown.

The same principle applies to finished runs: hold the report and the file
ids, not the tables. An annotated download re-parses; pinning two
post-mapping tables per cached run made that cache the largest consumer in
the process, for data usually never downloaded.

**Size the cache in bytes, from the machine.** Evicting by entry count
means "50 files" whether they are 20 KB or 50 MB. Derive the budget from
`v8.getHeapStatistics().heap_size_limit`, which follows a container's
memory limit on its own -- and do **not** use `os.totalmem()`, which
reports the *host's* memory inside a container (measured: 3.8 GB reported
in a 512 MB container, which would size the cache seven times too large).
Let the default upload cap follow the same budget rather than promising a
fixed size the machine cannot process, and report heap, budget and cache
occupancy from the readiness endpoint so an operator can see all of it.

### Caching

Three LRU caches, keyed by content hash so identical uploads from
different users share an entry: parsed files (~50), catalogues (~60), and
completed runs (~10, smallest because a run pins both post-mapping tables
for the annotated downloads). Nothing persists across a restart, and this
only works in a **single process** — a cluster or multiple replicas would
have a file uploaded to one process invisible to another.

---

## 7. Frontend

A single page, no router. Components:

- **File input** (used twice, source and target): pick a file, validate
  its extension and size **before** uploading, choose header/delimiter for
  CSV or sheet for Excel, upload with a real progress bar, then show row
  and column counts plus any hidden-data or formula warnings.
- **Catalogue picker**: optional upload and dataset selection.
- **Settings panel**: the column-mapping table (each source column → a
  target column or "ignore", each target claimable once), key-column
  checkboxes, control-total checkboxes (offering only columns numeric on
  *both* sides), and the comparison toggles.
- **Results**: the verdict banner, summary metrics, column differences,
  paged tables of source-only/target-only rows and cell differences,
  control totals, warnings, the audit header, and download links.
- **Guide**: a collapsible how-to.

Hold the shared state in one service. Two subtleties that are easy to get
wrong and that the tests should pin:

1. **Both column pickers list post-mapping (target) names**, not source
   names — those are the names the engine will actually see.
2. Consequently, **editing the mapping can strand a previously-checked key
   or control-total column**: it disappears from the panel while remaining
   in the request. Prune those selections whenever the mapping changes, or
   the user gets a run that does not match the settings on screen.

The "Run comparison" button stays disabled until both files are loaded.
Warnings from the response must be displayed prominently — several
correctness safeguards in the engine report themselves that way.

---

## 8. Packaging

`docker compose up --build` brings up both containers; the app is on
`:8080`.

- **Backend image**: multi-stage, build TypeScript then run as a
  non-root user, with a healthcheck on `/api/livez`.
- **Frontend image**: multi-stage, `ng build --configuration production`
  under `node:25.8-alpine`, then serve `dist/` from `nginx:1.29-alpine`.

Also provide an **optional single-process mode** so the app can run with
no Docker and no nginx: a flag/env var that makes the backend serve the
built SPA itself (static files plus a fallback to `index.html` for
client-side routes), mounted *after* the API so it can never shadow
`/api` — an unknown `/api/...` path must stay a 404 rather than being
handed the HTML shell. Note that the API-wide CSP (`default-src 'none'`)
is correct for JSON but would block the SPA's own bundles, so non-API
responses need the SPA policy instead. Keep it off by default: where
nginx is in front, static serving is nginx's job.

nginx must:

- set `client_max_body_size` at or above the backend's upload cap plus
  multipart slack (its own default is 1 MB, which would 413 real uploads
  before they ever reach Express);
- proxy `/api/` to the backend with forwarded headers and a generous read
  timeout, and `proxy_buffering off` so streamed CSV downloads progress;
- serve the SPA with a `try_files` fallback to `index.html`;
- **repeat the security headers in the `location = /index.html` block.**
  `add_header` is inherited only by location blocks that define none of
  their own, and the `try_files` fallback routes every page load through
  that block — so a lone `Cache-Control` there silently strips the CSP and
  frame protection from the one document that most needs them, while
  hashed assets keep theirs. Verify with `curl -I http://localhost:8080/`;
- use `127.0.0.1` rather than `localhost` in its healthcheck, since this
  image binds IPv4 only and `localhost` resolves to `::1` first.

---

## 9. Verification bar

**Write tests as you go, and verify by running the real thing.** The
standard this project was built to:

- Unit-test the engine primitives directly: decimal parsing (currency,
  parens, separators), date parsing and the DMY-before-MDY policy, cell
  normalisation and the `id`/`timestamp` overrides, equality and
  tolerance, the hash join and duplicate handling, column diff, control
  totals, both file loaders, catalogue parsing, and report generation.
- Keep an **anchor end-to-end test**: a known pair of sample files with a
  hand-verified expected result (in this repo: 9 matched-equal, 2
  matched-with-differences, 1 source-only, 2 target-only), asserted
  through the engine *and* over real HTTP.
- Test the API surface with real requests, including the failure paths:
  oversize bodies, empty uploads, unknown file ids, bad tolerances,
  legacy `.xls`.
- Test the frontend state service and the file-input validation.
- Before calling any phase done, **run it**: a real upload through nginx →
  Express → engine, and a real Excel download opened and checked — not a
  build that merely compiles.

A test that only proves the code does what the code does is not worth
writing. Aim each one at a rule that would actually break something.
