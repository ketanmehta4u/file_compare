# File Comparison — Angular + Express

A web app for reconciling two data files against each other. Upload a
**source** file and a **target** file (`.csv` or `.xlsx`), and get back
which rows exist on only one side, which rows matched but differ, exactly
which cells differ and by how much, whether the numeric totals tie out,
and a single plain-language verdict — plus a downloadable Excel audit
workbook.

Built for financial reconciliation, so the money math is decimal-exact
(no floating point anywhere in the pipeline) and every run is tied to the
SHA-256 of the exact bytes that were uploaded.

Everything happens **in memory** on the server: no database, no files
written to disk, nothing persisted after a restart. Uploads are held as
raw bytes and parsed on demand, and the comparison runs in a **worker
thread**, so the server stays responsive and the page shows live progress
— "Comparing matched rows: 132,000 / 150,000" — with a working Cancel.

- Angular **14.3.0** SPA (built with Angular CLI 14.2.13, the last CLI
  release on the 14.x line).
- **Express 5** + TypeScript backend, with the comparison engine written
  from scratch in TypeScript.
- Two Docker containers: nginx serving the built SPA and proxying
  `/api/*` to the backend — or, without Docker, a single Node process
  that serves both.
- Memory limits **size themselves to the machine**, so the same build
  behaves sensibly on a laptop and in a small container.

This is a from-scratch reimplementation of an earlier Python/FastAPI +
React tool. That original is untouched and lives separately; this is a
parallel rebuild in its own repository, not a migration.

---

## Contents

- [Quick start](#quick-start)
- [Setting up on a new machine](#setting-up-on-a-new-machine)
- [Running the app](#running-the-app)
- [Command reference](#command-reference)
- [Using it](#using-it)
- [Tests](#tests)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Sizing and memory](#sizing-and-memory)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Version notes](#version-notes)

---

## Quick start

With Docker installed, from the repository root:

```bash
docker compose up --build
```

Then open <http://localhost:8080>. Sample files to try it with are in
`fixtures/` — upload `sample_source.csv` as Source and
`sample_target.csv` as Target.

---

## Setting up on a new machine

### What you need

| | Version | Needed for |
|---|---|---|
| **Docker Desktop** (or Docker Engine + Compose v2) | any current release | The Docker path — this is all you need |
| **Node.js + npm** | Node 20+ (verified on 24.14.1 and, in the container, 25.8) | Running or developing without Docker |
| **Git** | any | Cloning |
| **Google Chrome** | any | Frontend tests only |

The Docker path needs nothing installed but Docker — Node, the Angular
CLI and every dependency live inside the images.

### 1. Clone

```bash
git clone https://github.com/ketanmehta4u/file_compare.git
cd file_compare
```

Windows users: any directory works, but avoid paths with spaces or
non-ASCII characters, and prefer a local drive over a network share
(`npm install` is slow and occasionally flaky over SMB).

### 2a. Docker setup (recommended)

```bash
docker compose up --build
```

First build takes a few minutes — it installs dependencies and runs a
production Angular build inside the image. Subsequent starts are fast.
Verify it is up:

```bash
curl -I http://localhost:8080/          # SPA shell -> 200
curl http://localhost:8080/api/livez    # -> {"status":"alive"}
```

To stop: `Ctrl+C`, then `docker compose down`.

If **port 8080 is already in use** (this project's own default, and a
common one), map a different host port without editing the committed
file:

```bash
# docker-compose.override.yml
services:
  frontend:
    ports: !override
      - "8081:8080"
```

`docker compose up` picks that file up automatically, and the app is then
on <http://localhost:8081>. The `!override` tag matters — without it
Compose *appends* to the port list rather than replacing it, and the
original `8080` binding still conflicts.

### 2b. Without Docker — one process, no nginx

The backend can serve the built Angular app itself, so the whole
application runs as a single Node process with nothing else installed:

```bash
cd frontend && npm install --legacy-peer-deps && npm run build
cd ../backend && npm install && npm run build
npm run start:spa           # http://localhost:3000
```

That is a real production run: the built SPA (not a dev server), the API,
and the engine in one process. `start:spa` passes `--serve-frontend`;
`SERVE_FRONTEND=1` does the same thing if you prefer an env var, and
`FRONTEND_DIST` points at a build somewhere other than
`frontend/dist/frontend`.

Serving the SPA is **off by default** — in the Docker topology nginx does
it, and the API process should not. The two modes differ in what you give
up without nginx: no gzip, no TLS termination, no separate upload cap in
front of the app. For a handful of users on an internal network that is
fine; for anything public, put a reverse proxy in front regardless of how
you run this (and set `TRUST_PROXY` to match).

### 2c. Native setup (hot reload for development)

Two terminals, from the repository root:

```bash
# Terminal 1 — backend on :3000
cd backend
npm install
npm run dev
```

```bash
# Terminal 2 — frontend on :4200
cd frontend
npm install --legacy-peer-deps
npm start
```

Open <http://localhost:4200>. The dev server proxies `/api/*` to
`:3000` (see `frontend/proxy.conf.json`), so both halves behave as they
do in production.

`--legacy-peer-deps` is required for the frontend: Angular 14's peer
dependency ranges do not satisfy npm's default strict resolution against
the pinned toolchain. It is expected, not a workaround for a broken
`package.json`.

### 3. Confirm the install is good

```bash
cd backend && npm test     # 153 tests
cd ../frontend && npm test # 33 tests (opens Chrome)
```

An end-to-end check against a running instance, using the sample files.
The two fixtures deliberately carry *different* column names on each
side, so this maps them and keys on the transaction id — the same thing
the UI walks you through:

```bash
SRC=$(curl -s -F "file=@fixtures/sample_source.csv" \
  http://localhost:8080/api/files/upload | grep -o '"file_id":"[^"]*"' | cut -d'"' -f4)
TGT=$(curl -s -F "file=@fixtures/sample_target.csv" \
  http://localhost:8080/api/files/upload | grep -o '"file_id":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST -H "Content-Type: application/json" -d "{
  \"source_file_id\": \"$SRC\", \"target_file_id\": \"$TGT\",
  \"column_map\": {\"txn_id\": \"transaction_id\", \"posting_date\": \"accounting_date\",
                  \"description\": \"description\", \"amount\": \"amount_local\",
                  \"currency\": \"currency_code\", \"gl_account\": \"gl_account\"},
  \"drop_unmapped\": true, \"key_columns\": [\"transaction_id\"]
}" http://localhost:8080/api/compare/run
```

A correct install returns the verdict `DIFFERENCES FOUND — 7 break(s)
require review`, with 9 matched-equal, 2 matched-with-differences, 1
source-only and 2 target-only rows — the same known-good result the
backend's anchor test asserts.

Dropping `column_map` and `key_columns` from that request is instructive
too: with no mapping the two files share only two column names, so
nothing matches and every row comes back as source-only or target-only.
That is correct behaviour rather than a failure — it is exactly what the
column-mapping step in the UI exists to solve.

### Deploying somewhere real

The Compose file is a local prod-shape topology, not a hardened
deployment. Before putting it in front of users:

- Set `CORS_ORIGINS` to the real origin.
- Terminate TLS in front of nginx (the app sets HSTS but does not serve
  HTTPS itself).
- Put authentication in front of it — the backend has **no login of its
  own** and simply trusts an identity header from a fronting proxy (see
  [Limitations](#limitations)).
- Keep `TRUST_PROXY` consistent with how many proxies actually sit in
  front of the backend.
- Run **one backend process**. The caches are in-process; replicas break
  file lookups (see [Limitations](#limitations)).
- Set the container's memory limit deliberately (`MEM_LIMIT`, default
  `2g`). It is the single knob that decides how big a file the deployment
  can handle — the heap, the cache budget and the upload cap all follow
  it. See [Sizing and memory](#sizing-and-memory).

---

## Running the app

| | Command | URL |
|---|---|---|
| Docker (prod shape) | `docker compose up --build` | <http://localhost:8080> |
| Single process, no Docker | `cd backend && npm run start:spa` | <http://localhost:3000> |
| Backend only (dev) | `cd backend && npm run dev` | <http://localhost:3000> |
| Frontend only (dev) | `cd frontend && npm start` | <http://localhost:4200> |
| Backend production build | `cd backend && npm run build && npm start` | <http://localhost:3000> |
| Frontend production build | `cd frontend && npm run build` | output in `frontend/dist/frontend` |

---

## Command reference

Every command in one place. All paths are relative to the repository
root, and `cd` back to the root between blocks.

### Install

```bash
cd backend  && npm install                     # backend deps
cd frontend && npm install --legacy-peer-deps  # frontend deps (flag required)
```

### Run — Docker

```bash
docker compose up --build        # build + start, foreground        -> :8080
docker compose up -d             # start detached
docker compose down              # stop and remove containers
docker compose ps                # what is running
docker compose logs -f backend   # follow backend logs
docker compose logs -f frontend  # follow nginx logs
docker compose up --build --force-recreate   # rebuild from changed source
```

### Run — no Docker, single process

```bash
cd frontend && npm run build     # build the SPA first
cd ../backend && npm run build   # compile the backend
npm run start:spa                # serves SPA + API together        -> :3000
```

### Run — development, hot reload

```bash
# terminal 1
cd backend && npm run dev        # tsx watch                        -> :3000

# terminal 2
cd frontend && npm start         # ng serve, proxies /api to :3000  -> :4200
```

Open <http://localhost:4200> — **not** `127.0.0.1:4200`, which the
Angular dev server does not listen on (see
[Troubleshooting](#troubleshooting)).

### Build

```bash
cd backend  && npm run build                       # tsc -> backend/dist
cd frontend && npm run build                       # -> frontend/dist/frontend
cd frontend && npm run build -- --configuration=production
cd frontend && npm run watch                       # rebuild on change
```

### Test

```bash
cd backend  && npm test                            # vitest, 153 tests
cd frontend && npm test                            # karma/jasmine, 33 tests

cd backend  && npx vitest run test/engine          # one directory
cd backend  && npx vitest run test/api/contract.spec.ts   # one file
cd backend  && npx vitest watch                    # watch mode
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless
```

### Setting environment variables

The app reads plain environment variables, but the syntax for setting one
inline differs by shell:

```bash
# bash / zsh / git-bash
SERVE_FRONTEND=1 PORT=8090 node dist/server.js
```

```powershell
# PowerShell
$env:SERVE_FRONTEND="1"; $env:PORT="8090"; node dist/server.js
```

```bat
:: cmd.exe — one per line; chaining with && would fold the trailing
:: space into the value ("1 " rather than "1")
set SERVE_FRONTEND=1
set PORT=8090
node dist/server.js
```

`npm run start:spa` avoids the issue entirely — it passes
`--serve-frontend` as an argument, which is identical in every shell. For
Docker, put the variables in a `.env` file beside `docker-compose.yml`
instead.

### Health and diagnostics

```bash
curl http://localhost:3000/api/livez     # liveness
curl http://localhost:3000/api/readyz    # readiness, cache sizes, memory
curl http://localhost:3000/api/config    # limits the UI reads
curl -I http://localhost:8080/           # SPA headers through nginx
```

Use `:8080` for Docker, `:3000` for the single-process run, `:4200` for
the dev server.

`/api/readyz` is the one to check on a deployed instance — it reports what
the process actually gave itself on that machine:

```json
"memory": { "heap_used_mb": 36, "heap_limit_mb": 1120, "rss_mb": 103,
            "upload_cache_mb": 0, "upload_cache_budget_mb": 280 }
```

### Git

```bash
git log --oneline                # phase-by-phase build history
git log -1 <hash>                # full detail on one commit
git status --short
```

---

## Using it

1. Upload the **Source** file (`.csv` or `.xlsx`). For a workbook, pick
   the sheet; for CSV, confirm the header row and delimiter.
2. Upload the **Target** file the same way.
3. Check the **column mapping**. Identically-named columns are matched
   automatically; map the rest by hand, or set them to *(ignore)*.
4. Pick **key columns** — the columns that identify a row (an invoice or
   transaction id, say). Leave empty to match on the whole row.
5. *(Optional)* Open **Matching options** for numeric tolerance, decimal
   precision, case sensitivity, whitespace trimming and blank-as-zero.
   The defaults suit most comparisons, and the collapsed heading
   summarises whatever is in force.
6. *(Optional)* Open **Dataset catalogue** to load a catalogue workbook,
   which pre-fills the mapping, key columns and settings for a known
   dataset. Not needed to compare two files.
7. **Run comparison.** A progress bar shows the phase and the row counts
   as it works — indexing each side, comparing matched rows, footing the
   control totals — and **Cancel** stops it for real, freeing the slot on
   the server rather than just hiding the result.
8. Read the verdict, summary, differences and control totals. Download the
   audit workbook, or an annotated copy of either input file with
   differing cells highlighted. **Start over** clears everything for the
   next pair of files.

**The tables on screen are a preview.** Each detail section is capped
(1,000 rows by default) so a large reconciliation does not have to ship
tens of megabytes to draw a page. When a section is trimmed the page says
so, with the real totals, and points at the downloads — which always
contain **every** row. The counts in the summary and on the tabs are
always the true ones.

**Read the warnings.** Several correctness safeguards report themselves
that way — hidden Excel rows or columns, uncalculated formulas read as
blank, duplicate keys, and a key column missing from one side (which
falls back to whole-row matching).

---

## Tests

```bash
cd backend && npm test    # vitest — engine + API, 153 tests
cd frontend && npm test   # karma/jasmine, needs Chrome — 33 tests
```

The backend suite includes an **anchor end-to-end test**: the sample
fixtures compared through the whole pipeline against a hand-verified
expected result (9 matched-equal, 2 matched-with-differences, 1
source-only, 2 target-only). If that one breaks, the engine's behaviour
has genuinely changed.

Headless run (no Chrome window):

```bash
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless
```

---

## Configuration

Backend environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `CORS_ORIGINS` | `http://localhost:4200` | Comma-separated allowed origins. |
| `MAX_UPLOAD_BYTES` | half the cache budget, capped at 200 MB | Per-file upload cap. Unset, it follows the machine rather than promising 200 MB a small container could never parse (a 2 GB container lands at 140 MB). Keep nginx's `client_max_body_size` at or above it. |
| `MAX_CONCURRENT_COMPARISONS` | `3` | Comparison concurrency cap (restart to change). |
| `COMPARE_QUEUE_TIMEOUT_S` | `120` | How long a queued comparison waits for a slot before a 503. |
| `TRUST_PROXY` | `1` | Proxy hops to trust for the client address. The default suits the shipped nginx topology; set `false` when the backend is directly exposed, so a client-supplied `X-Forwarded-For` is not believed. |
| `MAX_RESPONSE_ROWS` | `1000` | Rows per detail section put in a compare response. Downloads are never capped. |
| `MAX_CACHE_BYTES` | 25% of the V8 heap limit | Bytes of uploaded files the cache may hold. Derived from the machine, so it self-sizes on a laptop and in a container. |
| `MEM_LIMIT` (compose) | `2g` | The backend container's memory limit. V8 sizes its heap from this, and the cache budget and upload cap follow the heap. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Logging. `LOG_FORMAT=text` gives pretty-printed dev output. |
| `SERVE_FRONTEND` | off | Serve the built SPA from this process too, for running without Docker/nginx. `1`/`true`/`yes`, or pass `--serve-frontend`. |
| `FRONTEND_DIST` | `frontend/dist/frontend` | Where the built SPA lives, when `SERVE_FRONTEND` is on. |

Every one of these except `PORT` (fixed by the container topology) is
passed through in `docker-compose.yml`, so a `.env` file beside it
works:

```dotenv
CORS_ORIGINS=https://reconcile.example.com
MAX_UPLOAD_BYTES=104857600
LOG_LEVEL=debug
```

---

## HTTP API

All routes are under `/api`, JSON is `snake_case`, and errors come back
as `{"detail": "..."}`. Decimal values cross the wire as strings.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/livez` | Liveness |
| GET | `/api/readyz` | Readiness, cache sizes, and live memory/budget figures |
| GET | `/api/auth/me` | Current user, from proxy SSO headers |
| GET | `/api/config` | Upload cap, Excel row cap, feature flags |
| GET | `/api/catalog/template` | Blank catalogue template `.xlsx` |
| POST | `/api/catalog/upload` | Upload catalogue → `catalog_id` + datasets |
| GET | `/api/catalog/:catalogId/datasets/:datasetId/mapping` | Mapping for a dataset |
| POST | `/api/files/upload` | Upload one file → `file_id` + metadata |
| POST | `/api/files/list-sheets` | Sheet names in a workbook |
| POST | `/api/compare/run` | Run a comparison synchronously → result + `run_id` |
| POST | `/api/compare/jobs` | Start a comparison in the background → `job_id` (202) |
| GET | `/api/compare/jobs/:jobId` | Live progress, and the result once done |
| DELETE | `/api/compare/jobs/:jobId` | Cancel a queued or running comparison |
| GET | `/api/compare/:runId/report.xlsx` | Audit workbook |
| GET | `/api/compare/:runId/annotated/:side` | Annotated `source` or `target` |

### Running a comparison

There are two ways in, taking the same request body.

`POST /api/compare/jobs` returns a `job_id` straight away and runs the
comparison in a worker thread. `GET /api/compare/jobs/:jobId` then reports
live progress — the phase, its row counts and an overall percentage —
and carries the finished result once `status` is `done`:

```json
{ "job_id": "a36ab59d005743a8", "status": "running",
  "progress": { "phase": "comparing", "label": "Comparing matched rows",
                "done": 132000, "total": 150000, "percent": 55 },
  "result": null, "detail": null }
```

`DELETE` on the same URL cancels it, terminating the worker and freeing
its concurrency slot. The UI uses this path, polling every 400ms.

A result's detail sections (source-only rows, target-only rows, cell
differences) are capped at `MAX_RESPONSE_ROWS` for the wire. The response
carries a `truncation` block saying what was cut:

```json
"truncation": { "limit": 1000, "any_truncated": true,
  "source_only_rows": { "returned": 1000, "total": 150000, "truncated": true } }
```

`summary` always holds the true totals, and `report.xlsx` and the
annotated files always contain every row.

`POST /api/compare/run` still does the whole thing in one request and
returns the full result, unchanged. It also runs in a worker now, so it
no longer blocks the server — but it holds the connection open for the
length of the run, which for a large comparison is minutes and is exactly
what intermediate proxies tend to cut off. Prefer the job route for
anything big.

Both routes need `source_file_id` and `target_file_id`;
everything else is optional — `catalog_id` + `dataset_id`, `column_map`
(source column → target column), `drop_unmapped`, `key_columns`,
`case_sensitive`, `trim_whitespace`, `numeric_tolerance` (decimal
string), `decimal_precision`, `treat_blank_as_zero`,
`fuzzy_column_names`, `control_total_columns`, `enforced_dtypes`. An
explicit `column_map` takes precedence over the catalogue's mapping.

---

## Sizing and memory

All figures below were measured on this codebase, not estimated.

### What it uses

Idle, the backend sits at about **20 MB of heap**. From there, memory
follows two things: what is cached, and what a comparison is working on.

- **A cached upload costs its own size.** Uploads are kept as raw bytes
  and parsed on demand, so caching a 5.4 MB file adds ~5 MB — not the
  ~26 MB of heap the same file cost when parsed tables were cached
  (measured: four cached files went 41 → 67 → 93 → 119 MB before, and
  stay flat at 41 MB now).
- **A comparison parses both files at once.** A parsed table costs roughly
  9–17× the file's bytes — worst for narrow files with many rows, where
  per-row object overhead dominates. That working set exists only while
  the run is in flight, and it lives in the worker thread.

A guide for a comparison of two files of size *S* each. Only the first
row is measured; the others scale it by parsed size:

| Files (each) | Peak process memory | Give the container |
|---|---|---|
| ~5 MB (150k rows) | **372 MB** — measured (was 534 MB before uploads were cached as bytes) | 1 GB |
| ~20 MB | ~700 MB — estimated | 2 GB (the default) |
| ~50 MB | >2 GB — estimated | 4 GB, and raise `--max-old-space-size` |

> Resident memory (RSS) overstates what is actually held: V8 does not
> return freed heap to the OS, so a process that has parsed a large file
> keeps looking large until pressure forces a collection. `heap_used_mb`
> from `/api/readyz` is the number to watch, and the per-file retention
> figures above were taken after forcing collection.

### How it sizes itself

Nothing here is a fixed constant, which is what makes the same build safe
to move between machines:

1. **V8 sizes its heap from the container's memory limit.** Measured: a
   512 MB container gets a ~259 MB heap; a 2 GB container gets 1120 MB.
2. **The upload cache budget is a quarter of that heap** (override with
   `MAX_CACHE_BYTES`), and it evicts on **bytes**, not on a file count.
3. **The default upload cap is half the cache budget**, capped at 200 MB —
   so a 2 GB container advertises a 140 MB limit rather than a 200 MB one
   it could never parse. `MAX_UPLOAD_BYTES` still overrides it.

So the one knob that matters when deploying is the container's memory
limit (`MEM_LIMIT`, default `2g`); everything else follows from it. Check
where an instance actually landed with `GET /api/readyz`.

> `os.totalmem()` is deliberately not used for any of this. Inside that
> 512 MB container it reports the **host's** 3.8 GB, which would have
> sized the cache roughly seven times too large.

### If files are bigger than the machine

Two options were considered and deliberately deferred, because the change
above may make them unnecessary — measure your own files first:

- **Streaming the probe side**: index one file, read the other in chunks.
  Cuts the resident cost of the second file, at the price of a second join
  implementation to keep correct.
- **Columnar row storage**: the 9–17× multiplier is per-row JS objects;
  columns as arrays would cut it several-fold, but it touches the whole
  engine.

Spilling to disk (external sort-merge) is the one approach ruled out
rather than deferred: it would put financial data at rest, which this
design otherwise avoids entirely.

---

## Limitations

**File formats**

- **Legacy `.xls` (OLE2) is not supported.** Detected by magic bytes and
  rejected with a message to re-save as `.xlsx` or `.csv`. Only `.csv`
  and `.xlsx` are accepted.
- One sheet per comparison. Multi-sheet workbooks are fine, but you pick
  a single sheet per side.
- Excel cells are read via a best-effort string conversion. Numbers,
  dates, booleans, strings, rich text, hyperlinks and formulas with a
  cached result are handled; exotic cell types fall through to a generic
  stringification.
- **Uncalculated formulas read as blank** — a formula cell Excel never
  computed has no cached value. The app counts these and names the
  columns, but cannot compute them for you.
- Hidden rows and columns **are included** in the comparison. The app
  warns that they exist rather than silently skipping them.

**Scale and memory**

- Everything is in memory, and a comparison needs both files parsed at
  once — so file size is bounded by the machine. See
  [Sizing and memory](#sizing-and-memory) for the measured numbers and how
  the limits size themselves.
- Default caps: 3 concurrent comparisons (a fourth request queues, then
  gets a 503 after 120s), and a per-file upload cap that follows the
  machine. Comparisons run in worker threads, so the concurrency cap buys
  real parallelism rather than merely bounding memory.
- **The on-screen result is a preview; the downloads are complete.** Each
  detail section in a compare response is capped at `MAX_RESPONSE_ROWS`
  (default 1,000). The summary counts stay true, the UI says plainly when
  a section was cut, and the audit workbook and annotated files still
  contain every row. Measured on a 150k-row all-different run: the
  response went from ~28 MB to 188 KB while the workbook still carried all
  150,000 rows per side. Uncapped this was also a hard failure waiting to
  happen — V8 will not build a single string over 512 MB, so a large
  enough run would have thrown while serialising instead of returning
  anything.
- Building the workbook for a very large result is itself slow: 300,000
  rows across the two sheets took about 135 seconds and produced a 10 MB
  file.
- The audit workbook respects Excel's 1,048,576-row limit by spilling
  oversized sheets to CSV attachments; oversized annotated exports stream
  as CSV instead of `.xlsx`.

**State and deployment**

- **Nothing is persisted.** Uploaded files, catalogues and completed runs
  live in in-process caches — uploads against a byte budget, catalogues
  and runs by count (≈60 and ≈10). A restart loses everything, and a busy
  session can evict an older upload; the "re-upload" errors that follow
  are expected behaviour, not a fault.
- An annotated download re-parses its source file, so if that upload has
  been evicted the download fails with a message asking you to re-upload
  and re-run, even though the run itself is still cached. The trade buys
  a large reduction in resident memory (see
  [Sizing and memory](#sizing-and-memory)), and eviction is much less
  likely now that the cache holds bytes rather than parsed tables.
- **Single process only.** The caches are module-level singletons, so
  multiple replicas or a clustered process would leave a file uploaded to
  one process invisible to another. Scale up, not out, or add shared
  storage first.
- Run ids and file ids are unguessable-ish but **not access-controlled**:
  anyone who knows a `run_id` can fetch that run's report from the same
  server. Do not treat this as multi-tenant isolation.

**Security and identity**

- **There is no login.** The backend trusts an identity header set by a
  fronting reverse proxy (`x-ms-client-principal-name`,
  `x-auth-request-email`, `x-forwarded-user`, `x-auth-username`,
  `remote-user`). Exposed directly, anyone can set those headers and
  claim any identity — put a real authenticating proxy in front of it.
- Rate limits are per user (or per IP when unauthenticated) and held in
  memory, so they reset on restart and are per-process.
- The app does not serve TLS; terminate it upstream.

**Functionality not built**

- **Azure Blob storage is stubbed** — the routes exist and return 400,
  matching the original app's own already-disabled state. Upload and
  download are local only.
- No comparison history, saved configurations, or scheduled runs — each
  comparison starts from scratch.
- No i18n; the UI is English only.
- The SPA is a single page with no router, so there are no deep links to
  a particular run.

**Behavioural things worth knowing**

- Ambiguous numeric dates resolve **day-first**: `03/04/2024` is 3 April,
  not 4 March.
- Excel serial dates use the `1899-12-30` epoch, which reproduces Excel's
  phantom 1900 leap day on purpose — the goal is to agree with Excel.
- With no key columns, rows match on the **whole row**, so any difference
  makes a row appear as both source-only and target-only. Pick key
  columns to get cell-level differences.
- If a key column is missing from either side, the run **warns and falls
  back** to whole-row matching rather than failing.

---

## Troubleshooting

**`port is already allocated` on `docker compose up`.** Something else
holds 8080 — often another instance of this app. Either stop it
(`docker ps`, then `docker compose down` in that project) or map a
different host port with the `docker-compose.override.yml` shown
[above](#2a-docker-setup-recommended).

**Frontend `npm install` fails with peer dependency errors.** Use
`npm install --legacy-peer-deps` (frontend only; the backend installs
normally).

**`ng build` fails with `esbuild-wasm: The service was stopped`.** A
`node_modules` shared across a Windows host and a Linux container has the
wrong platform's esbuild binary in it. Fix with
`rm -rf node_modules && npm install` on whichever platform you are
building on — never share `node_modules` across that boundary.

**TypeScript errors inside `node_modules/@types/node`.** `@types/node`
resolved to a version newer than Angular 14's TypeScript 4.7 can parse.
The pin (`^16.18.0`) exists to prevent exactly this; check it survived
the last install.

**`Source file not in cache — re-upload.`** The LRU evicted it, or the
backend restarted. Re-upload and run again. Expected behaviour, not a
bug.

**`Server busy — N comparison(s) already running.`** The concurrency gate
returned 503. Retry, or raise `MAX_CONCURRENT_COMPARISONS`.

**Uploads fail with 413.** The file exceeds `MAX_UPLOAD_BYTES`, or
nginx's `client_max_body_size` is below it. Raise both together. Note the
default cap follows the machine's heap, so a smaller container advertises
a smaller limit — `GET /api/config` reports the one in force.

**The backend runs out of memory, or the container is killed.** A
comparison parses both files at once, so peak memory is a multiple of
file size. Check `GET /api/readyz` for the heap the process actually has,
raise the container's `MEM_LIMIT`, and see
[Sizing and memory](#sizing-and-memory).

**An annotated download says the file is no longer cached.** The upload
was evicted, and annotated files are re-parsed from it on demand. Upload
the file again and re-run the comparison.

**`ng serve` is running but `http://127.0.0.1:4200` is refused.** The
Angular dev server binds IPv6 loopback (`::1`) only — use
`http://localhost:4200` instead, or `ng serve --host 0.0.0.0`. (Verified
on this toolchain: `localhost` and `[::1]` answer, `127.0.0.1` does not.)

**Frontend tests do nothing / cannot find a browser.** Karma needs
Chrome. Install it, or point `CHROME_BIN` at a Chromium binary.

---

## Project layout

```
backend/          Express API + comparison engine (TypeScript)
  src/engine/     the comparison engine — no HTTP awareness
  src/worker/     runs a comparison off the main thread
  src/api/        routes, DTOs, middleware, background jobs
  src/cache/      in-memory stores (byte-budgeted uploads, runs)
  test/           vitest suites (engine, API, worker)
frontend/         Angular 14 SPA
  src/app/core/     shared services (API client, state)
  src/app/features/ file input, catalogue picker, settings, results
  nginx.conf        static serving + /api proxy (production image)
fixtures/         sample CSV/XLSX used by tests and manual checks
docker-compose.yml
BUILD_PROMPT.md   full specification of this app, written from the code
CLAUDE.md         project context and history for AI-assisted sessions
prompt.md         an earlier, rejected specification — kept for reference
```

The **git log is the build narrative**: each commit describes what was
built in that phase, how it was verified, and every real bug found along
the way. `git log --oneline` for the list, `git log -1 <hash>` for
detail.

---

## Version notes

- **Angular CLI stops at 14.2.13** — there is no `@angular/cli@14.3.0`.
  The framework packages (`@angular/core` and siblings) are pinned to
  `^14.3.0`; only the CLI, a dev-time tool that is not shipped, is one
  patch behind.
- **`frontend/package.json` pins `@types/node` to `^16.18.0`.** Left
  unpinned, npm resolves several dependencies' `"@types/node": "*"` to
  the latest release, whose type definitions use syntax Angular 14's
  bundled TypeScript (4.7.x) cannot parse. Compile-time only — it has no
  effect on which Node version the app runs on.
- **Confirmed:** `ng build --configuration production` succeeds both
  locally and inside the real `node:25.8-alpine` image — no
  `--openssl-legacy-provider` flag needed for this combination.
- **The backend uses Express 5 and current TypeScript**, not the Express 4
  originally sketched in planning — it has no legacy constraint the way
  the Angular frontend does.

### Docker gotchas found during the build

- **A Windows-host + Linux-container `npm install` against a shared
  `frontend/node_modules` corrupts the platform-specific esbuild
  binary**, and a later Windows-side production build fails with
  `esbuild-wasm: The service was stopped`. Reinstall
  `node_modules` on whichever platform you build on next.
- **`add_header` does not merge across nginx `location` levels.** A child
  block defining any `add_header` of its own drops every header inherited
  from the server level. The SPA's `location = /index.html` (reached by
  the `try_files` fallback on *every* page load, not just a literal
  `/index.html` request) sets `Cache-Control`, which silently dropped all
  five security headers from the main document while static assets kept
  theirs. They are now repeated in that block — verify with
  `curl -I http://localhost:8080/` after touching `nginx.conf`.
- **This nginx image binds IPv4 only.** Its healthcheck must target
  `127.0.0.1`, not `localhost`: resolving `localhost` to `::1` inside the
  container gets a genuine connection refused even while the service is
  up and reachable from the host. Already handled in
  `docker-compose.yml`; worth knowing if you add healthchecks.
