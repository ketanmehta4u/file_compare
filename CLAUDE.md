# File Comparison — Angular + Express Port

Read this file fully before doing anything else in this repo. It exists
so a Claude Code session opened fresh in this directory (e.g. from
VSCode, after the project moved from `C:\Users\welcome\Desktop\file_comparison`
to here) has full context without the user having to re-explain
anything.

## What this project is

A from-scratch reimplementation of a financial-file-reconciliation tool.
The original — `C:\Users\welcome\Desktop\file_comparison` — is Python
(FastAPI) + React, and it is untouched; this is not a migration of that
codebase, it's a parallel rebuild using a different stack, in its own
git repo.

## The original request, as given

The user asked (paraphrased close to verbatim across several messages):

> Convert the main branch code to Angular 14.3.0 and Node 25.8 alpine
> version. Do not remove the existing code — create a new directory
> inside the Projects directory, `C:\Users\welcome\Projects\compare_file`,
> and maintain a new main branch there. I would create a new git
> repository for this. [Initially: do not use Docker — later reversed:]
> fine, I'll use Docker, we can go ahead with node alpine.

Follow-up answers that shaped the actual scope (asked via clarifying
questions before implementation started):

- **Angular CLI has no 14.3.0 release** (it stops at 14.2.13) — resolved
  by scaffolding with CLI 14.2.13 and pinning the _framework_ packages
  (`@angular/core` etc.) to `^14.3.0`. The CLI is a dev-time tool only,
  not shipped in the app.
- **Comparison engine**: user explicitly chose a **full TypeScript
  rewrite**, not a subprocess call-out to the existing Python
  `comparison.py`, after being warned this is the highest-risk option
  (the engine's core guarantee is decimal-exact financial math).
- **Backend framework**: **Express**, chosen over alternatives.
- **`.xls` (legacy Excel) support**: explicitly deferred. `.xlsx` +
  `.csv` only in this port.
- **Docker topology**: **two containers** — nginx serving the built
  Angular static files (using a Dockerfile template the user supplied
  directly) proxying `/api/*` to a separate Express/TypeScript backend
  container. Same shape as the original app, translated from
  Python/uvicorn to Node/Express.
- **Git remote**: wired as `origin` (see `git remote -v`; the URL is
  deliberately not written down here or in any tracked file — the user
  asked that their GitHub account name not appear in the repo). Confirm
  push state with `git status` and `git log origin/main` rather than
  assuming it.
- User's explicit instruction partway through: **"just keep going and
  finish this project"** — the rest of the build (engine, API, frontend,
  Docker) was completed in one continuous session on that instruction,
  each phase committed and verified before moving to the next.

## Implementation status: complete

Every phase of the build is done, committed, and — critically — actually
**verified**, not just written:

| Phase                                  | Status | How it was verified                                                                                                                                                                                  |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo scaffold, build spike             | ✅     | `ng build` succeeded under the real `node:25.8-alpine` image                                                                                                                                         |
| Engine (`backend/src/engine/`)         | ✅     | The anchor end-to-end test reproduces the original's exact ground truth (9 matched-equal, 2 matched-with-differences, 1 source-only row = `TXN-012`, 2 target-only) against the real sample fixtures |
| Express API (`backend/src/api/`)       | ✅     | Full pipeline smoke test over real HTTP — same 9/2/1/2 result through the API, not just the engine directly                                                                                          |
| Angular frontend (`frontend/src/app/`) | ✅     | `ng build`/`ng test` pass; a real `ng serve` + real backend were run simultaneously and a genuine file upload was proxied through and verified                                                       |
| Docker (`docker-compose.yml`)          | ✅     | Both images built in the real base images and the full stack was run in containers, verified with a real upload through nginx → Express                                                              |

**153 backend tests (vitest), 33 frontend tests (karma/jasmine), all
passing.** Run them yourself: `cd backend && npm test`,
`cd frontend && npm test`.

### Post-build review pass

A later session reviewed the finished build against the plain-user goal
("upload two files, compare them") and fixed five real defects, each
verified rather than assumed:

- **Every user shared one rate-limit bucket behind nginx.** Express had no
  `trust proxy` setting, so `req.ip` was the nginx container's address for
  all traffic. Proved in containers: nginx sits at `172.19.0.3` while the
  backend now logs the true client. Configurable via `TRUST_PROXY`.
- **The SPA shell served no security headers.** nginx `add_header` is not
  inherited into a `location` block that defines any of its own, and the
  `try_files` fallback routes every page load through
  `location = /index.html`. Proved by running the pre-fix config
  side-by-side: `/` returned no CSP or `X-Frame-Options` at all, while
  static assets did.
- **Key/control-total selections went stale on a mapping edit.** They are
  listed by post-mapping name, so re-pointing a mapping row stranded a
  checked column: gone from the panel, still in the request, and the
  engine then warned and silently fell back to whole-row matching.
- **`.xls` was offered by the file picker** but rejected by the backend
  only after a full upload round-trip.
- **`ctx_path` logged API routes with the `/api` prefix stripped**, because
  it read `req.path` in the `finish` handler after Express had rewritten
  the URL for the mounted router.

One test (the `EXCEL_MAX_ROWS` spill case, which builds a >1M-row report)
was also failing on vitest's 5s default timeout; the suite now allows 30s.

### Live progress and worker threads

The engine now runs in a `worker_threads` worker, and comparisons can be
started as background jobs (`POST /api/compare/jobs`) that report live
per-phase row counts, with cancellation. This began as a feature request
("can we show how many rows have been compared in real time?") but the
blocker was the measured one above: run inline, a 150k-row comparison
answered _no_ HTTP request for its entire 112s -- so no progress endpoint
could have replied. The synchronous `/api/compare/run` route keeps its
contract and now also runs in the worker.

### Memory: bytes in the cache, parsing in the worker

Uploads are cached as raw bytes and parsed on demand inside the worker;
runs hold file ids rather than tables, and annotated downloads re-parse.
Measured, each cached 150k-row file used to retain ~26 MB of heap and now
retains ~0 (5.4 MB of external buffer). The cache evicts on bytes against
a budget taken from V8's heap limit, so it self-sizes per machine, and the
default upload cap follows it (a 2 GB container advertises 140 MB rather
than a 200 MB it could not parse). `GET /api/readyz` reports heap, budget
and occupancy.

Two traps worth remembering here: `os.totalmem()` reports the _host's_
memory inside a container and must not be used for sizing, and the
worker's transfer encoder has to pass binary through untouched -- it once
walked Buffers generically into `{0: 105, 1: 100, ...}`, corrupting every
upload it touched.

Watch out for two things if you touch this: Decimals do not survive a
structured clone (see `worker/transfer.ts`), and the worker entry is
resolved by the extension of `__filename` so dev/tests load the .ts
worker through the tsx loader while production loads the compiled .js.

**Full narrative of how it was built — including every bug found and
how — is in the git log.** Each commit message is a detailed account of
that phase: what was ported, what was tested, and any real bug caught
along the way (there were eleven, all found by tests or live
verification, not by inspection — e.g. a date-parsing bug that silently
broke DMY-vs-MDY resolution, an IPv6 rate-limit bypass, a Docker uid
collision, an IPv6-vs-IPv4 healthcheck failure). Read it with:

```bash
git log --oneline          # the phase-by-phase list
git log -1 <hash>          # full detail on any one phase
```

`README.md` has the run instructions (Docker-first) and two Docker
gotchas worth knowing before touching the Dockerfiles again.

## About `BUILD_PROMPT.md` and `prompt.md`

`BUILD_PROMPT.md` **is** an accurate specification of this repo: a
rebuild-from-scratch prompt written after the fact from the finished
code, covering the stack, architecture, every engine rule (normalisation
order, DMY-before-MDY dates, Excel's 1899-12-30 epoch, tolerance vs.
equality, key fallback), the API contract, the middleware, the frontend
state subtleties, the nginx requirements, and the verification bar. It is
the file to hand to anyone rebuilding this. `README.md` is the operator
documentation: setup on a new machine, running, limitations,
troubleshooting.

## About `prompt.md`

There's a `prompt.md` in this repo root. **It does not describe this
repo's actual architecture** — it's a separate, earlier specification
(drafted by a different AI assistant) proposing a client-side-first
design: Angular parsing/comparing in the browser via Web Workers, with
an optional backend for large files only. The user confirmed the actual
goal is simply "a frontend application where the user can upload files
and compare them" — which the real, server-side architecture already
satisfies (Angular uploads, Express's engine does all the work). No
rearchitecture was done or requested; `prompt.md` is kept only for
reference and carries its own warning banner at the top. Don't let it
override anything in this file or the git log.

## What's NOT done

- Nothing has been pushed to the GitHub remote — confirm current state,
  don't assume.
- `.xls` legacy Excel support (deferred by explicit decision, see above).
- Azure Blob storage (stubbed as 400-returning routes, matching the
  original app's own already-disabled state — not a gap, a deliberate
  match).

## If the user asks you to "continue" or references earlier conversation

The full prior conversation (including the multi-user-hardening work
done on the _original_ Python app before this Angular/Node project even
started, and the entire build described above) is preserved as a raw
Claude Code session transcript, copied into this project's session
storage. Depending on how the harness discovers sessions for `/resume`
or `--continue` in this new directory, it may or may not surface
automatically — if the user references something from "our earlier
discussion" that isn't covered above or in the git log, say so plainly
rather than guessing, and ask them to paste the relevant detail or point
you at the original project directory
(`C:\Users\welcome\Desktop\file_comparison`) if it concerns the
original app rather than this one.
