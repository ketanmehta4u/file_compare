import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],

    // Generous on purpose. Two kinds of test here are slow by nature: the
    // EXCEL_MAX_ROWS spill case builds a >1,048,576-row report, and every
    // comparison test spawns an OS worker thread that compiles the engine
    // on startup. Both are fine alone, and both stretch badly when the
    // machine is busy -- running this suite at the same time as the
    // frontend's (a webpack build plus Chrome) pushed one-second tests
    // past thirty. A timeout is a guard against a genuine hang, not an
    // assertion about speed, so it is set well clear of the work rather
    // than close to it; a real deadlock still fails, just later.
    testTimeout: 120_000,

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
