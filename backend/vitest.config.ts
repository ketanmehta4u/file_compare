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

    // Five spec files run real comparisons, and each test in them spawns
    // an OS worker thread that saturates a core -- and under a TypeScript
    // runner that worker also has to compile the engine on startup. Run
    // those files in parallel on top of vitest's own pool and the machine
    // is oversubscribed several times over: tests that take a second in
    // isolation were timing out at thirty. Files therefore run one at a
    // time. It costs perhaps a minute of wall clock and buys a suite whose
    // result depends on the code rather than on what else the machine was
    // doing.
    fileParallelism: false,
  },
});
