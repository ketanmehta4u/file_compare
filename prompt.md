> **⚠️ NOTE — this is NOT what was actually built in this repo.**
> This is a separate, earlier/alternate specification (drafted by a
> different AI assistant — note the "Want me to build this, or adjust
> the versions first?" sign-off below) describing a **client-side-first**
> architecture: Angular parses and compares files in the browser via Web
> Workers, with an optional Node backend only for large files.
>
> **The actual architecture in this repo is the opposite**: everything
> server-side. The Express backend (`backend/src/engine/`) does 100% of
> the parsing, normalisation, and comparison; Angular is a thin client
> that uploads files and renders results — no Web Workers, no
> client-side parsing at all. See `CLAUDE.md` for the real project
> history and requirements, and the `git log` for what was actually
> built, phase by phase.
>
> Kept here only for reference (it independently converged on several
> of the same financial-comparison rules — decimal-exact math, currency/
> parens normalisation, control totals, audit header with SHA-256 —
> that the real engine already implements, ported from the original
> Python app rather than from this document).

---

A couple of quick notes before the prompt:

Angular 14's latest patch is **14.3.0** (there's no 14.30 — I'll assume you mean 14.3.x). Also worth flagging: **Angular 14 officially requires Node 14/16/18**; Node 25 is far newer than that toolchain supports and the Angular CLI will warn or error on an unsupported engine. Node **25.8-alpine** also may not exist yet as a published tag. If you're committed to those versions, expect friction — I'll write the prompt to your spec but add a note about the mismatch so the developer handles it deliberately (e.g., `--force`, or pinning a supported Node).

One architectural point: a browser-based Angular app can parse CSV/XLSX client-side, but for **huge financial files** and precise reconciliation, the heavy comparison logic is better on a backend. I've written the prompt to support both — client-side for small files, with an optional Node backend service for large ones. Adjust if you want pure frontend only.

Here's the prompt:

---

**Build a web application to compare and reconcile two financial-reporting data files (XLSX or CSV), using Angular 14.3.x, containerized with a `node:25.8-alpine` base image.**

**Version constraints (build exactly to these; note the compatibility caveat below)**
- **Angular: 14.3.x** (framework + CLI).
- **Container base image: `node:25.8-alpine`.**
- **Compatibility warning to handle explicitly:** Angular 14 officially supports Node 14/16/18, not Node 25. The build must account for this — either pin the toolchain, use `npm install --force`/`--legacy-peer-deps` as needed, set the CLI to tolerate the Node version, or document a supported Node for local dev while keeping the runtime image on Alpine. Do not silently ignore the engine mismatch; call it out in the README and handle it in the Dockerfile.

**Context & purpose**

A user downloads financial reporting data from a dashboard and reconciles it against a dataset they already maintain. They compare exactly two files at a time — a **Source** and a **Target** — each `.xlsx` or `.csv`. The files may differ in column names, column count, column order, and record set. The app surfaces structural differences (row count, column count, column sequence, schema), record-level differences, and reconciliation signals (signed deltas, control totals) in an audit-ready way. Correctness and traceability matter more than convenience.

**Architecture**
- **Angular 14.3 SPA** as the frontend UI.
- Keep all comparison/reconciliation logic in **pure, framework-independent TypeScript services** (no Angular-component dependency in the core logic), so it's testable and reusable.
- **Small files:** parse and compare client-side in the browser (Web Worker to keep the UI responsive).
- **Large files:** provide an **optional Node backend service** (also runnable on `node:25.8-alpine`) exposing a comparison API; the frontend uploads/streams files to it. Make the frontend engine-agnostic so it works with either path via a service abstraction.

**Functional requirements**

1. **File input** — two inputs labeled "Source" and "Target"; accept `.csv`, `.xlsx`, `.xls`; for multi-sheet Excel let the user pick the sheet; let the user indicate whether the first row is a header; require both files before comparing.
2. **Structural comparison (always)** — row/column counts and differences; columns in Source-only, Target-only, common; column sequence/order mismatch; per-common-column data-type comparison.
3. **Record-level comparison (on demand)** — user picks one or more **key columns** (fall back to full-row match if none); report Source-only rows, Target-only rows, matched-and-equal, matched-with-differences, with a **cell-level diff** (which column changed from what to what); configurable case sensitivity, whitespace trimming, numeric tolerance, null handling.
4. **Output / UX** — summary panel at top (counts, column diffs, sequence mismatches, control-total tie-out); detailed diffs in tabs/expanders with a **paginated/virtualized preview only** (never render millions of rows); export an audit-ready report (XLSX via a library such as `exceljs`/`SheetJS`, with CSV fallback for oversized results) containing: Audit Header, Summary, Column Differences, Source-Only, Target-Only, Value Differences, Control Totals.

**Financial-reporting requirements**
- **Never use JavaScript `number` (float) for monetary comparison** — use a decimal library (e.g., `decimal.js` / `big.js`) or integer minor-units. JS floats lose precision on financial values.
- Numeric tolerance is **explicit and configurable**, defaulting to **exact match (zero tolerance)**; as an absolute amount (e.g., ±0.01); any tolerance-matched row is flagged, never silently equal.
- Normalize before comparing: thousands separators, currency symbols (`$`, `€`, `₹`), stray spaces, **accounting parenthesized negatives** `(1,234.00)` → `-1234.00`; treat `-0.00` and `0.00` as equal.
- Preserve sign and scale — `+100` vs `-100` is a material sign error, never collapsed to magnitude.
- Report **signed delta** (Target − Source) per numeric field and a **net difference total** per numeric column.
- **Control-total / footing check:** independently sum each numeric column in both files and report tie-out, *separately* from row-level diffs.
- Classify each record: matched-and-equal, matched-with-differences, source-only, target-only.
- Handle dates as dates (Excel serial, multiple string formats, fiscal vs. calendar), not strings.
- **No silent rounding/coercion**; any normalization is transparent and reported. Treat blank/null vs `0.00` as **distinct** (configurable).
- **Audit-ready + deterministic:** report header with file names, **SHA-256 hashes**, row/column counts, sheet names, timestamp, and every setting used; identical inputs+settings always yield an identical report.

**Large-file handling**
- Use **Web Workers** (client) so parsing/comparison never freezes the UI; stream with a library like **PapaParse** (CSV) and **SheetJS** (XLSX) in read/stream mode.
- For very large files, route to the **Node backend**, which streams the file and does key-based/hash-join matching rather than nested loops.
- Show progress and elapsed time; virtualize result tables (Angular CDK virtual scroll); fall back to CSV export beyond Excel's ~1,048,576-row limit.
- Warn on large uploads; document backend upload-size limits.

**Edge cases — handle all gracefully (never crash; clear message). Configurable where a default is debatable.**
- *File/format:* empty or header-only file; no-header file; wrong extension vs. content; corrupted/password-protected XLSX; non-UTF-8 encodings (`latin-1`, `cp1252`, UTF-8 BOM) with fallback + reporting; delimiter ambiguity (comma/semicolon/tab/pipe) with auto-sniff + override; quoted fields with embedded delimiters/newlines; mixed line endings; multiple/hidden/empty sheets; identical files → "no differences".
- *Schema:* different column counts; fully non-overlapping names; same columns different order; duplicate column names; names differing only by case/whitespace (configurable); blank/unnamed/trailing-empty columns; same name different type.
- *Data:* zero overlap; strict subset; duplicate rows; non-unique key values (warn — breaks 1:1 match; define behavior); key missing in one file; nulls/blanks in keys/values; semantically-equal numeric formatting; date-format mismatches; blank vs `0.00`; long text/Unicode.
- *Scale:* too large for browser memory → route to backend / cap preview; diff beyond Excel limit → CSV; long-running comparison → progress, responsive UI.
- *User-flow:* only one file uploaded → block; settings changed → recompute, no stale results.

**Containerization**
- **Multi-stage Dockerfile:** build stage on `node:25.8-alpine` (Angular build), runtime stage serving the compiled SPA (e.g., static server or `nginx:alpine`); optional backend stage also on `node:25.8-alpine`.
- Handle the Angular-14-vs-Node-25 engine mismatch explicitly in the build stage (documented flags/pins).
- `.dockerignore`, non-root user, small final image.

**Deliverables**
- Angular 14.3 project: comparison/reconciliation **services** (pure TS + unit tests), UI components, Web Worker, file-parsing service, export service.
- Optional Node backend service (Express/Fastify) with the comparison API.
- `Dockerfile` (multi-stage), `docker-compose.yml` (frontend + optional backend), `.dockerignore`.
- `package.json` pinned to Angular 14.3.x.
- `README.md`: run instructions, the **Node 25 vs Angular 14 compatibility note and how it's handled**, recommended file format (CSV) for largest files, upload-size config, and a disclaimer that the tool assists reconciliation but does not replace independent verification/sign-off.
- Inline comments; type-safe; deterministic output.

---

Want me to build this, or adjust the Angular/Node versions first given the compatibility issue?