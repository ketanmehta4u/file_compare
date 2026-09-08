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
  by scaffolding with CLI 14.2.13 and pinning the *framework* packages
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
- **Git remote**: `https://github.com/ketanmehta4u/file_compare.git`
  (created by the user; wired as `origin` here, **nothing pushed yet as
  of the last session** — confirm current state with `git status` and
  `git log origin/main` before assuming push state).
- User's explicit instruction partway through: **"just keep going and
  finish this project"** — the rest of the build (engine, API, frontend,
  Docker) was completed in one continuous session on that instruction,
  each phase committed and verified before moving to the next.

## Implementation status: complete

Every phase of the build is done, committed, and — critically — actually
**verified**, not just written:

| Phase | Status | How it was verified |
|---|---|---|
| Repo scaffold, build spike | ✅ | `ng build` succeeded under the real `node:25.8-alpine` image |
| Engine (`backend/src/engine/`) | ✅ | The anchor end-to-end test reproduces the original's exact ground truth (9 matched-equal, 2 matched-with-differences, 1 source-only row = `TXN-012`, 2 target-only) against the real sample fixtures |
| Express API (`backend/src/api/`) | ✅ | Full pipeline smoke test over real HTTP — same 9/2/1/2 result through the API, not just the engine directly |
| Angular frontend (`frontend/src/app/`) | ✅ | `ng build`/`ng test` pass; a real `ng serve` + real backend were run simultaneously and a genuine file upload was proxied through and verified |
| Docker (`docker-compose.yml`) | ✅ | Both images built in the real base images and the full stack was run in containers, verified with a real upload through nginx → Express |

**112 backend tests (vitest), 3 frontend tests (karma/jasmine), all
passing.** Run them yourself: `cd backend && npm test`,
`cd frontend && npm test`.

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

## What's NOT done

- Nothing has been pushed to the GitHub remote — confirm current state,
  don't assume.
- `.xls` legacy Excel support (deferred by explicit decision, see above).
- Azure Blob storage (stubbed as 400-returning routes, matching the
  original app's own already-disabled state — not a gap, a deliberate
  match).

## If the user asks you to "continue" or references earlier conversation

The full prior conversation (including the multi-user-hardening work
done on the *original* Python app before this Angular/Node project even
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
