# File Comparison — Angular + Express port

A from-scratch reimplementation of the financial-file-reconciliation tool
(originally Python/FastAPI + React) using Angular 14.3.0 and Node.js 25.8
+ Express, with the comparison engine fully rewritten in TypeScript.

The original app is untouched and lives separately; this is a new build,
not a migration.

## Layout

- `frontend/` — Angular 14.3.0 SPA (built with Angular CLI 14.2.13, the
  last CLI release published for the 14.x line; the framework packages
  themselves are pinned to 14.3.0).
- `backend/` — Express + TypeScript API and comparison engine.
- `fixtures/` — sample CSV/XLSX files used by both automated tests and
  manual smoke checks, copied from the original app.

## Status

Scaffolding in progress. See commit history for what's been built so far.

## Known version notes

- **Angular CLI stops at 14.2.13** — there is no `@angular/cli@14.3.0`.
  The app's framework packages (`@angular/core` and siblings) are pinned
  to `^14.3.0`; only the CLI tool itself (dev-time only, not shipped) is
  one patch behind.
- **`frontend/package.json` pins `@types/node` to `^16.18.0`.** Left
  unpinned, npm resolves several dependencies' `"@types/node": "*"` to
  the latest release, whose type definitions use syntax Angular 14's
  bundled TypeScript (4.7.x) cannot parse. This is a compile-time-only
  types package — it has no effect on which Node version the app
  actually runs on.
- **Confirmed:** `ng build --configuration production` succeeds both
  locally and inside the real `node:25.8-alpine` Docker image — no
  `--openssl-legacy-provider` flag needed for this toolchain/version
  combination.
- **Backend uses the current Express 5 / TypeScript 7**, not the Express
  4 originally sketched in planning — the backend has no legacy
  constraint (unlike the Angular frontend), so there's no reason to pin
  to an older major.
