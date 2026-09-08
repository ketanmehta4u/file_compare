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

**Complete.** Comparison engine, Express API, Angular frontend, and
Docker packaging are all built and verified — see commit history for
the phase-by-phase build log, including every bug caught along the way
and how it was found.

## Running it

### Docker (recommended — this is what's actually verified end-to-end)

```bash
docker compose up --build
# open http://localhost:8080
```

Two containers: `frontend` (nginx serving the built Angular app,
proxying `/api/*` to `backend`) and `backend` (the Express API + engine).
Both were built against the real pinned versions (`node:25.8-alpine`,
`nginx:1.29-alpine`) and confirmed working — a real multipart file
upload through nginx → Express → engine → back out, not just a build
that compiles.

### Native dev workflow (hot reload)

```bash
# Terminal 1 — backend
cd backend
npm install
npm run dev          # tsx watch, :3000

# Terminal 2 — frontend
cd frontend
npm install --legacy-peer-deps
npm start             # ng serve, :4200, proxies /api/* to :3000
```

Open `http://localhost:4200/`.

### Tests

```bash
cd backend && npm test    # vitest — engine + API, 120 tests
cd frontend && npm test   # karma/jasmine (needs Chrome) — 15 tests
```

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

## Known Docker gotchas (found and fixed during the build)

- **A Windows-host + Linux-container `npm install` against the same
  shared `frontend/node_modules` corrupts the platform-specific esbuild
  binary.** Running `npm install` inside a Linux container with the
  Windows `frontend/` directory volume-mounted (e.g. to validate the
  Node 25.8 build before committing to it) writes `esbuild-linux-64`
  into `node_modules`; a subsequent Windows-side `ng build
  --configuration production` then fails with `esbuild-wasm: The
  service was stopped`. Fix: `rm -rf node_modules && npm install` on
  whichever platform you're building on next — don't share
  `node_modules` across host/container boundaries.
- **`add_header` does not merge across nginx `location` levels.** A child
  block that defines any `add_header` of its own drops every header
  inherited from the server level. The SPA's `location = /index.html`
  (reached by the `try_files` fallback for *every* page load, not just a
  literal `/index.html` request) sets `Cache-Control`, which silently
  dropped all five security headers from the main document while static
  assets still carried them. They are now repeated in that block; verify
  with `curl -I http://localhost:8080/` after touching `nginx.conf`.
- **This nginx image only binds IPv4.** Its healthcheck must target
  `127.0.0.1`, not `localhost` — resolving `localhost` to `::1` inside
  the container gets a genuine connection refused even though the
  service is correctly up and reachable via the host's port mapping.
  Already fixed in `docker-compose.yml`; worth knowing if you add more
  healthchecks later.

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
