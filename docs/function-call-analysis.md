# Can the Angular frontend call the backend by function call?

**Short answer: no, not while Angular runs in a browser. The HTTP API stays.**

This document records the analysis behind that decision, so the question does
not have to be re-opened from scratch. It was written before any code changed.

## The question

Replace the frontend-to-backend HTTP communication (Angular `HttpClient` →
Express routes) with direct function calls into the backend's TypeScript.

## Why it is impossible in a browser

A browser tab and a Node process are **separate processes**, often on separate
machines. They share no memory and no call stack. Any "call" between them has to
be serialised and sent across a boundary — HTTP, WebSocket, or an IPC channel in
a desktop shell. Renaming the boundary does not remove it, and a wrapper that
looks like a function call but performs a `fetch` underneath is still HTTP.

The backend also cannot run in a browser as written. What it depends on:

| Dependency                    | Where                                                  |
| ----------------------------- | ------------------------------------------------------ |
| `node:crypto` (SHA-256)       | `engine/fileLoad/hash.ts`, `engine/report/annotate.ts` |
| `node:stream` (streamed xlsx) | `engine/report/buildExcelReport.ts`                    |
| `worker_threads`              | `worker/runInWorker.ts`, `worker/compareWorker.ts`     |
| `Buffer`, `iconv-lite`        | `engine/fileLoad/csv.ts`, everywhere bytes are handled |
| `exceljs` (Node build)        | catalogue, Excel loading, report building              |
| `multer`, `express`           | `api/upload.ts`, every route                           |

Beyond the technical block, moving the engine into the browser is ruled out by
the project's own constraint: the comparison logic, filesystem access and
privileged operations must not be exposed to the browser.

## Options considered

| Option                                       | Real function calls?                                       | Why it was not chosen                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **A. Typed service facade, HTTP underneath** | In Node (tests, tooling) yes; in the browser no            | Available as a tidy-up, but it does not change the transport; see "What this would buy" below                    |
| **B. Angular Universal (SSR)**               | Only during the server-side first render                   | Upload, polling, cancel and download stay HTTP; adds a build target and hydration for no real gain               |
| **C. Electron / Tauri desktop app**          | **Yes** — renderer → main process IPC, services in-process | It stops being a web app: installers, updates, one user per machine. Ruled out by the deployment goal            |
| **D. Move the engine into the browser**      | Yes, but there is no backend left                          | Forbidden by the project's constraints; needs every Node API ported; a tab cannot hold what a 2 GB container can |

## Decision

The application is deployed as a **web app on a server, used by several people
at once** (Docker on a VM, or IIS on Windows). That rules out C and D, and B
solves nothing here. **The HTTP API is kept as the transport.**

## Consequences of keeping HTTP

- **Security.** The browser gets data, never logic or filesystem access. The
  existing controls stay meaningful: upload caps, rate limits, security headers,
  CSP, and one process that owns all parsing and comparison.
- **Deployment.** Unchanged and simple: one Node process, optionally with nginx
  or IIS in front. No desktop packaging, no installers, no per-machine updates.
- **Docker.** The shipped topology (nginx + backend container) still applies, and
  the single-process mode (`--serve-frontend`) remains the simplest option.
- **File handling.** Uploads stay multipart over HTTP, with progress from real
  upload events. Files never touch the browser's filesystem APIs.
- **Worker threads.** Unchanged: comparisons keep running in a worker thread, so
  a long run does not block the event loop.
- **Authentication.** Unchanged: this deployment has no sign-in, and the identity
  header support goes unused. Access is controlled by where the app is deployed
  (internal network, VPN, firewall).
- **Scalability.** Unchanged, and still one process: uploads, runs and jobs live
  in memory. Multiple replicas break file lookups, polling and downloads unless
  that state is externalised.
- **Testing.** Unchanged: the backend is tested directly and over real HTTP with
  supertest; the frontend mocks `HttpClient`.
- **Browser compatibility.** Unchanged: ordinary `fetch`/XHR, nothing exotic.

## What a typed service facade would buy (option A)

Worth knowing, in case it is wanted later for its own sake. Today the logic lives
inside Express route handlers. Extracting services — `getConfig`, `uploadFile`,
`listSheets`, `uploadCatalog`, `getMapping`, `startComparison`,
`getComparisonJob`, `cancelComparison`, `writeReport` — would give:

- routes reduced to thin adapters (validate → call service → map errors, which
  `api/errors.ts` already centralises);
- a backend testable end-to-end without HTTP;
- the seam that would make a desktop build (option C) a port rather than a rewrite.

It would **not** make anything faster: a loopback HTTP call costs well under a
millisecond, against comparisons measured in minutes and uploads measured in
megabytes. It is a code-structure improvement, not a performance one, and it was
deliberately deferred in favour of the multi-user work in
[deployment.md](deployment.md).

## What was done instead

The effort went into what actually affects users of a deployed, shared instance:

1. **Results are bound to the browser that created them** (a session cookie, no
   sign-in required), so one person's reconciliation is not fetchable by another.
2. **Finished runs are retained sensibly** rather than a fixed 10 for everyone.
3. **Deployment is documented** for both targets, including the settings that
   silently break uploads and downloads behind a proxy.
