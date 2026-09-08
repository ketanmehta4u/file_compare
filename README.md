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
written to disk, nothing persisted after a restart.

- Angular **14.3.0** SPA (built with Angular CLI 14.2.13, the last CLI
  release on the 14.x line).
- **Express 5** + TypeScript backend, with the comparison engine written
  from scratch in TypeScript.
- Two Docker containers: nginx serving the built SPA and proxying
  `/api/*` to the backend — or, without Docker, a single Node process
  that serves both.

This is a from-scratch reimplementation of an earlier Python/FastAPI +
React tool. That original is untouched and lives separately; this is a
parallel rebuild in its own repository, not a migration.

---

## Contents

- [Quick start](#quick-start)
- [Setting up on a new machine](#setting-up-on-a-new-machine)
- [Running the app](#running-the-app)
- [Using it](#using-it)
- [Tests](#tests)
- [Configuration](#configuration)
- [HTTP API](#http-api)
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
cd backend && npm test     # 129 tests
cd ../frontend && npm test # 15 tests (opens Chrome)
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

## Using it

1. *(Optional)* Upload a **dataset catalogue** and pick a dataset. This
   pre-fills the column mapping, key columns and comparison settings.
   Skip it entirely if you just want to compare two files.
2. Upload the **Source** file (`.csv` or `.xlsx`). For a workbook, pick
   the sheet; for CSV, confirm the header row and delimiter.
3. Upload the **Target** file the same way.
4. Check the **column mapping**. Identically-named columns are matched
   automatically; map the rest by hand, or set them to *(ignore)*.
5. Pick **key columns** — the columns that identify a row (an invoice or
   transaction id, say). Leave empty to match on the whole row.
6. Adjust settings if needed: numeric tolerance, decimal precision, case
   sensitivity, whitespace trimming, blank-as-zero, control-total
   columns.
7. **Run comparison**, and read the verdict, summary, differences and
   control totals. Download the audit workbook, or an annotated copy of
   either input file with differing cells highlighted.

**Read the warnings.** Several correctness safeguards report themselves
that way — hidden Excel rows or columns, uncalculated formulas read as
blank, duplicate keys, and a key column missing from one side (which
falls back to whole-row matching).

---

## Tests

```bash
cd backend && npm test    # vitest — engine + API, 129 tests
cd frontend && npm test   # karma/jasmine, needs Chrome — 15 tests
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
| `MAX_UPLOAD_BYTES` | `209715200` (200 MB) | Per-file upload cap. Keep nginx's `client_max_body_size` at or above this. |
| `MAX_CONCURRENT_COMPARISONS` | `3` | Comparison concurrency cap (restart to change). |
| `COMPARE_QUEUE_TIMEOUT_S` | `120` | How long a queued comparison waits for a slot before a 503. |
| `TRUST_PROXY` | `1` | Proxy hops to trust for the client address. The default suits the shipped nginx topology; set `false` when the backend is directly exposed, so a client-supplied `X-Forwarded-For` is not believed. |
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
| GET | `/api/readyz` | Readiness + cache sizes |
| GET | `/api/auth/me` | Current user, from proxy SSO headers |
| GET | `/api/config` | Upload cap, Excel row cap, feature flags |
| GET | `/api/catalog/template` | Blank catalogue template `.xlsx` |
| POST | `/api/catalog/upload` | Upload catalogue → `catalog_id` + datasets |
| GET | `/api/catalog/:catalogId/datasets/:datasetId/mapping` | Mapping for a dataset |
| POST | `/api/files/upload` | Upload one file → `file_id` + metadata |
| POST | `/api/files/list-sheets` | Sheet names in a workbook |
| POST | `/api/compare/run` | Run a comparison → result + `run_id` |
| GET | `/api/compare/:runId/report.xlsx` | Audit workbook |
| GET | `/api/compare/:runId/annotated/:side` | Annotated `source` or `target` |

`POST /api/compare/run` needs `source_file_id` and `target_file_id`;
everything else is optional — `catalog_id` + `dataset_id`, `column_map`
(source column → target column), `drop_unmapped`, `key_columns`,
`case_sensitive`, `trim_whitespace`, `numeric_tolerance` (decimal
string), `decimal_precision`, `treat_blank_as_zero`,
`fuzzy_column_names`, `control_total_columns`, `enforced_dtypes`. An
explicit `column_map` takes precedence over the catalogue's mapping.

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

- Everything is in memory: the uploaded bytes, the parsed table, and the
  result. Peak memory is a multiple of file size, not a fraction of it.
  Very large files are limited by the container's memory, well before the
  200 MB upload cap.
- Default caps: 200 MB per file, 3 concurrent comparisons (a fourth
  request queues, then gets a 503 after 120s). All tunable.
- The audit workbook respects Excel's 1,048,576-row limit by spilling
  oversized sheets to CSV attachments; oversized annotated exports stream
  as CSV instead of `.xlsx`.

**State and deployment**

- **Nothing is persisted.** Uploaded files, catalogues and completed runs
  live in in-process LRU caches (≈50 files, ≈60 catalogues, ≈10 runs). A
  restart loses everything, and a busy session can evict an older upload
  — hence the "re-upload" errors, which are expected behaviour.
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
nginx's `client_max_body_size` is below it. Raise both together.

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
  src/api/        routes, DTOs, middleware
  test/           vitest suites (engine + API)
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
