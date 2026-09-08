import { describe, it, expect } from "vitest";
import { compareColumns } from "../../src/engine/columnDiff";
import { defaultSettings } from "../../src/engine/types";
import type { FileMeta } from "../../src/engine/types";

// Ported from tests/test_comparison.py::TestColumnDiff.
function meta(name: string, columns: string[]): FileMeta {
  return {
    name,
    sha256: "x".repeat(64),
    sizeBytes: 100,
    rowCount: 10,
    columnCount: columns.length,
    columns,
    dtypes: columns.map((c) => [c, "text"] as const),
  };
}

describe("compareColumns", () => {
  it("identifies source-only, target-only, and common columns", () => {
    const s = meta("s", ["a", "b", "c"]);
    const t = meta("t", ["b", "c", "d"]);
    const diff = compareColumns(s, t, defaultSettings());
    expect(diff.sourceOnly).toEqual(["a"]);
    expect(diff.targetOnly).toEqual(["d"]);
    expect(diff.common).toEqual(["b", "c"]);
  });

  it("flags sequence mismatches when common columns are in a different order", () => {
    const s = meta("s", ["a", "b", "c"]);
    const t = meta("t", ["c", "b", "a"]);
    const diff = compareColumns(s, t, defaultSettings());
    expect(diff.sequenceMismatches.length).toBeGreaterThan(0);
    expect(new Set(diff.sequenceMismatches.map((m) => m.column))).toEqual(new Set(["a", "c"]));
  });
});
