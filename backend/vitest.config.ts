import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    // The EXCEL_MAX_ROWS spill test builds a >1,048,576-row report and
    // serialises it to CSV -- genuinely seconds of work, and it landed
    // right on vitest's 5s default (observed: a 4.9s file run that timed
    // out on a slower pass). Raised so a legitimately slow test isn't
    // reported as a failure.
    testTimeout: 30_000,
  },
});
