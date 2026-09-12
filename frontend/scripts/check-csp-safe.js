/**
 * Fails the build if index.html contains anything the app's own
 * Content-Security-Policy would block.
 *
 * This exists because of a real, silent failure. Angular's `inlineCritical`
 * optimisation inlines the critical CSS and defers the real stylesheet
 * like this:
 *
 *   <link rel="stylesheet" href="styles.x.css" media="print"
 *         onload="this.media='all'">
 *
 * The CSP this app serves is `script-src 'self'`, which blocks inline
 * event handlers. So `onload` never fired, the stylesheet stayed
 * print-only, and the page rendered with just the small inlined block --
 * body background and font, no panels, no layout. Nothing errored: the
 * stylesheet returned 200 and contained every rule. It simply was never
 * applied to the screen.
 *
 * A CSP violation that manifests as "the page looks wrong" is exactly the
 * kind of thing to catch mechanically rather than by eye, so this runs on
 * every production build.
 */

const fs = require("fs");
const path = require("path");

const indexPath = path.resolve(__dirname, "..", "dist", "frontend", "index.html");

if (!fs.existsSync(indexPath)) {
  console.error(`check-csp-safe: no build found at ${indexPath}`);
  process.exit(1);
}

const html = fs.readFileSync(indexPath, "utf8");
const problems = [];

// Inline event handlers: blocked by script-src 'self'.
const handlers = html.match(/\son[a-z]+\s*=\s*["'][^"']*["']/gi);
if (handlers) {
  problems.push(
    `inline event handler(s) that script-src 'self' will block: ${handlers.join(", ").trim()}`
  );
}

// A stylesheet left at media="print" depends on script to become visible.
if (/<link[^>]+rel=["']stylesheet["'][^>]*media=["']print["']/i.test(html)) {
  problems.push(
    'a stylesheet is deferred with media="print", which needs script to apply it'
  );
}

if (problems.length > 0) {
  console.error("check-csp-safe: index.html would not render correctly under this app's CSP:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nThis is usually Angular's inlineCritical optimisation. It is turned off in\n" +
      "angular.json's production configuration for exactly this reason; check that\n" +
      "setting before relaxing the CSP."
  );
  process.exit(1);
}

console.log("check-csp-safe: index.html is safe to serve under a strict CSP");
