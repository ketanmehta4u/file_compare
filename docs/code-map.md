# What lives where

A guide to the files in this repository, written for someone who knows what the
application does but not Angular. It explains the Angular ideas as it goes.

The project has two halves that talk over HTTP:

```
frontend/   the page people see, written in Angular (TypeScript, runs in the browser)
backend/    the API and the comparison engine, written in Express + TypeScript (runs in Node)
```

Plus `fixtures/` (sample files), `docs/` (guides like this one) and the documents
at the root.

---

## Angular in five minutes

Enough to read the `frontend/` half without looking anything up.

- **A component is one piece of the page.** It comes as a pair of files with the
  same name: a `.html` **template** (what is drawn) and a `.ts` **class** (the
  data and the behaviour behind it). `file-input.component.html` and
  `file-input.component.ts` are one component.
- **Templates are HTML with extras.** `*ngIf="x"` shows an element only when `x`
  is true; `*ngFor="let s of sheets"` repeats one for each item; `{{ value }}`
  prints a value; `(click)="load()"` calls a method; `[disabled]="busy"` binds a
  property. Everything in the braces is a field or method of that component's
  class.
- **A service is shared code with no visuals** — fetching from the server, or
  holding state several components need. `api.service.ts` and
  `compare-state.service.ts` are services.
- **Angular hands services to components automatically.** A component lists what
  it needs in its `constructor(private readonly api: ApiService)` and Angular
  supplies it. That is all "dependency injection" means here.
- **A module lists what exists.** `app.module.ts` names every component and
  service, so Angular can wire them together.
- **A `.spec.ts` file is a test** for the file it sits beside. They never ship to
  users.

---

## frontend/ — the page

### The starting point

| File                                     | What it is                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.html`                         | The only HTML page the browser ever loads. Nearly empty: `<app-root></app-root>` is where the whole app is drawn.                  |
| `src/main.ts`                            | Starts the app: hands `AppModule` to Angular. Thirteen lines, rarely touched.                                                      |
| `src/app/app.module.ts`                  | The list of every component and service in the app, and the one-off startup task that applies the branding before the first paint. |
| `src/polyfills.ts`, `src/environments/*` | Angular scaffolding. `environment.prod.ts` replaces `environment.ts` in a production build.                                        |

### The shell and the look

| File                                            | What it is                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/app.component.html`                    | The page layout: the blue strip, the intro and step indicator, the upload cards, the catalogue and settings panels, the run button and the footer.                                                          |
| `src/app/app.component.ts`                      | The page's behaviour: starts a comparison, polls its progress, cancels it, works out which of the three steps you are on.                                                                                   |
| `src/styles.css`                                | **All of the styling, in one file** (1,300 lines). Colours and spacing at the top, then the blue strip, buttons, cards, the drop zone, tables, the results, the footer, and the phone layout at the bottom. |
| `src/app/theme.ts`                              | The branding in one place: organisation and product names, the logos, the palette, the disclaimer, the footer links. Editing this file re-brands the whole app.                                             |
| `src/app/core/theme.service.ts`                 | Applies that branding at startup — colours into CSS variables, the page title, the favicon.                                                                                                                 |
| `src/assets/wbg-logo.svg`, `wbg-logo-white.svg` | The logo. The white-lettered one is used on the dark blue strip.                                                                                                                                            |

### The five pieces of the page

Each is a folder under `src/app/features/` holding a template, a class, and its
tests.

| Folder            | What that part of the page does                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-input/`     | One upload card, used twice (Source and Target): the drop zone, the sheet picker for workbooks, the header/delimiter options, the upload progress bar, and the loaded-file badges. |
| `catalog-picker/` | The optional catalogue step: upload a catalogue workbook, choose a dataset, and let it fill in the mapping and settings.                                                           |
| `settings-panel/` | Column mapping, the key and control-total column chips, and the matching options folded away behind a summary.                                                                     |
| `results/`        | Everything shown after a run: verdict banner, summary tiles, column and record differences, control totals, and the download links. Its template is the largest in the app.        |
| `how-to-use/`     | The collapsible guide at the top of the page. Static text.                                                                                                                         |

### Shared code

| File                                    | What it is                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/core/api.service.ts`           | **Every call to the backend**, one method per endpoint. If you want to know what the page asks the server for, read this file.                           |
| `src/app/core/compare-state.service.ts` | The shared state: the two files, the mapping, the key columns, the settings. Every panel reads and writes this one object, so none of them can disagree. |
| `src/app/core/config.service.ts`        | Fetches the server's limits once at startup.                                                                                                             |
| `src/app/shared/models/dto.ts`          | The **shape of every message** between page and server. Mirrors the backend's `dto.ts` field for field.                                                  |

### Frontend configuration

| File                           | What it is                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `angular.json`                 | Build settings: which files are entry points, which stylesheets to include, production options.             |
| `package.json`                 | Dependencies and the `npm` commands (`start`, `build`, `test`).                                             |
| `karma.conf.js`, `src/test.ts` | Test runner setup; `test.ts` finds every `.spec.ts`.                                                        |
| `tsconfig*.json`               | TypeScript settings for the app and for tests.                                                              |
| `proxy.conf.json`              | Sends `/api` to the backend during development only.                                                        |
| `nginx.conf`                   | The web server used in the Docker setup: serves the built page, forwards `/api`, sets the security headers. |
| `Dockerfile`                   | Builds the frontend container.                                                                              |
| `scripts/check-csp-safe.js`    | Runs after every build and fails it if the output would break the site's security rules.                    |

---

## backend/ — the API and the engine

Three layers: the **API** (HTTP), the **engine** (the comparison itself, with no
knowledge of HTTP), and a **worker** that runs the engine off the main thread.

### Starting up

| File                | What it is                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`     | Process entry point: build the app and listen on a port. Deliberately tiny, so tests can build the app without opening a port.                                      |
| `src/app.ts`        | Assembles the app: the middleware in the order that matters, then the routes, then optionally the built page.                                                       |
| `src/config/env.ts` | **Every setting in one place**: upload cap, memory budget, how many comparisons at once, retention, rate limits, and how the limits size themselves to the machine. |

### The API layer (`src/api/`)

| File                                                     | What it is                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `routes/files.ts`                                        | Upload a file; list a workbook's sheets.                                                                                   |
| `routes/compare.ts`                                      | Start a comparison (immediately or as a background job), poll it, cancel it, and download the results. The busiest file.   |
| `routes/catalog.ts`                                      | Catalogue upload, its datasets and mappings, and the blank template.                                                       |
| `routes/config.ts`, `routes/health.ts`, `routes/auth.ts` | The server's limits; liveness/readiness and memory figures; the identity a proxy supplied.                                 |
| `compareJobs.ts`                                         | Comparisons that outlive the request that started them: their status, progress and cancellation.                           |
| `dto.ts`                                                 | The shape of every request and response — the twin of the frontend's `dto.ts`.                                             |
| `schemas.ts`                                             | Checks incoming requests **at runtime**, so a wrong type is refused with a clear message instead of being quietly ignored. |
| `toView.ts`                                              | Converts engine results into the shapes sent over the wire (decimals become strings so no precision is lost).              |
| `errors.ts`                                              | The single place a thrown error becomes an HTTP status.                                                                    |
| `upload.ts`                                              | File-upload handling, held in memory, with the size cap applied.                                                           |
| `serveFrontend.ts`                                       | Serves the built page when running as one process.                                                                         |

### Middleware (`src/api/middleware/`)

Small pieces that run on every request, in order.

| File                 | What it does                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bodySizeGuard.ts`   | Rejects an over-sized request before its body arrives.                                                        |
| `securityHeaders.ts` | Sets the standard security headers.                                                                           |
| `requestLog.ts`      | Gives each request an id and logs one line per response. Also the app's logger.                               |
| `session.ts`         | Gives each browser an anonymous id in a cookie, so a result belongs to the browser that made it. Not a login. |
| `rateLimit.ts`       | Caps how many uploads, comparisons and downloads one client may make.                                         |
| `compareSlot.ts`     | Caps how many comparisons run at once; the rest queue.                                                        |
| `currentUser.ts`     | Reads an identity header if a proxy supplies one.                                                             |

### The engine (`src/engine/`) — where the comparison happens

No HTTP anywhere in here; it takes tables and settings and returns a report.

| File                                        | What it does                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `runComparison.ts`                          | The conductor: runs the steps below in order and produces the verdict.                       |
| `compareRecords.ts`                         | Matches rows between the files and finds the differing cells.                                |
| `columnDiff.ts`                             | Compares the two files' **columns**: missing, extra, reordered, different types.             |
| `controlTotals.ts`                          | Sums each numeric column on both sides — a check that does not depend on rows matching.      |
| `rowKey.ts`                                 | Builds the key that identifies a row, from the key columns or the whole row.                 |
| `normalise.ts`                              | Turns a raw cell into a comparable value, deciding whether it is a number, a date or text.   |
| `decimal.ts`                                | Exact money arithmetic. Understands `$1,234.56` and `(2,500.00)`. Never uses floating point. |
| `dates.ts`                                  | Date parsing, including Excel's own quirks. Ambiguous dates are read day-first.              |
| `equality.ts`                               | Whether two values match, including the tolerance rule.                                      |
| `types.ts`                                  | The engine's vocabulary: settings, tables, differences, the report.                          |
| `progress.ts`                               | How the engine reports progress while it works.                                              |
| `errors.ts`                                 | Tells "the user's file is wrong" apart from "we have a bug".                                 |
| `catalog.ts`, `catalogTemplate.ts`          | Reading a catalogue workbook, and generating the blank template.                             |
| `fileLoad/csv.ts`, `fileLoad/excel.ts`      | Reading CSVs and workbooks. Every cell is read as text; interpretation happens later.        |
| `fileLoad/loadBytes.ts`, `fileLoad/hash.ts` | Picking the right reader for a file, and fingerprinting it for the audit trail.              |
| `report/buildExcelReport.ts`                | Builds the audit workbook, including the "How to Read" sheet, and streams it to the browser. |
| `report/auditRows.ts`                       | The audit header: who ran it, which files, which settings.                                   |
| `report/annotate.ts`                        | The optional annotated copies of the original files.                                         |

### The worker (`src/worker/`)

A comparison is slow and would otherwise freeze the server for everyone else, so
it runs on a separate thread.

| File               | What it does                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `compareWorker.ts` | Runs on that thread: parses the files and runs the engine.                                               |
| `runInWorker.ts`   | Starts the thread, relays progress, and can cancel it.                                                   |
| `transfer.ts`      | Money values lose their type when crossing between threads; this packs and unpacks them so they survive. |

### Backend tests (`backend/test/`)

`engine/` tests the comparison logic directly; `api/` drives the real HTTP
endpoints; `worker/` covers the thread boundary. 207 tests in all.

---

## The rest of the repository

| File or folder                   | What it is                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `README.md`                      | Setting up, running, configuring, limitations, troubleshooting. Start here.         |
| `ARCHITECTURE.md`                | How a request flows through the system, end to end.                                 |
| `BUILD_PROMPT.md`                | A full specification — enough to rebuild the app from scratch.                      |
| `CLAUDE.md`                      | Project history and context for AI-assisted sessions.                               |
| `docs/deployment.md`             | Deploying on a VM with Docker, or on IIS.                                           |
| `docs/function-call-analysis.md` | Why the page talks to the server over HTTP rather than calling its code directly.   |
| `docs/code-map.md`               | This file.                                                                          |
| `fixtures/`                      | Sample files, including the multi-sheet workbooks for trying the sheet picker.      |
| `docker-compose.yml`             | Runs both halves as containers.                                                     |
| `package.json` (root)            | The commands that drive both halves: `setup`, `build`, `start`, `test`, `format`.   |
| `prompt.md`                      | An early, rejected design. Kept for reference only — it does not describe this app. |
| `.github/workflows/ci.yml`       | What runs automatically on every push.                                              |

---

## Where to look first

| If you want to change…        | Go to                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| Wording, colours, logo        | `frontend/src/app/theme.ts`, then `frontend/src/styles.css` |
| The page's layout             | `frontend/src/app/app.component.html`                       |
| One part of the page          | the matching folder in `frontend/src/app/features/`         |
| What the page asks the server | `frontend/src/app/core/api.service.ts`                      |
| An endpoint's behaviour       | `backend/src/api/routes/`                                   |
| A limit or setting            | `backend/src/config/env.ts`                                 |
| How two values are compared   | `backend/src/engine/normalise.ts` and `equality.ts`         |
| The audit workbook            | `backend/src/engine/report/buildExcelReport.ts`             |
