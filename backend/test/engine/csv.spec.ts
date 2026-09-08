import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCsv, decodeWithFallback, sniffDelimiter, cleanupColumnNames } from "../../src/engine/fileLoad/csv";
import { sha256Hex } from "../../src/engine/fileLoad/hash";

const FIXTURES = join(__dirname, "../../../fixtures");

// Ported from tests/test_comparison.py::TestLoading (CSV subset).
describe("loadCsv", () => {
  it("loads the real sample_source.csv fixture", () => {
    const data = readFileSync(join(FIXTURES, "sample_source.csv"));
    const { table, meta } = loadCsv(data, "sample_source.csv");
    expect(meta.rowCount).toBe(12);
    expect(meta.columns).toContain("txn_id");
    expect(["utf-8", "utf-8-sig"]).toContain(meta.encoding);
    expect(meta.delimiter).toBe(",");
    expect(table.rows).toHaveLength(12);
  });

  it("raises on empty input", () => {
    expect(() => loadCsv(Buffer.alloc(0), "empty.csv")).toThrow(/empty/);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and 64 hex chars", () => {
    const data = readFileSync(join(FIXTURES, "sample_source.csv"));
    expect(sha256Hex(data)).toBe(sha256Hex(data));
    expect(sha256Hex(data)).toHaveLength(64);
  });
});

describe("decodeWithFallback", () => {
  it("falls back past invalid UTF-8 to cp1252/latin-1", () => {
    // 0x96 is en-dash in cp1252; invalid as a standalone UTF-8 byte.
    const { text, encoding } = decodeWithFallback(Buffer.from([0x61, 0x96, 0x62]));
    expect(text.length).toBeGreaterThan(0);
    expect(["cp1252", "latin-1"]).toContain(encoding);
  });

  it("strips a UTF-8 BOM and reports utf-8-sig", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf-8")]);
    const { text, encoding } = decodeWithFallback(withBom);
    expect(text).toBe("hello");
    expect(encoding).toBe("utf-8-sig");
  });
});

describe("sniffDelimiter", () => {
  it.each([
    ["a,b,c\n1,2,3\n4,5,6", ","],
    ["a;b;c\n1;2;3\n4;5;6", ";"],
    ["a\tb\tc\n1\t2\t3", "\t"],
    ["a|b|c\n1|2|3", "|"],
  ])("detects %j -> %j", (sample, expected) => {
    expect(sniffDelimiter(sample)).toBe(expected);
  });

  it("defaults to comma when nothing scores", () => {
    expect(sniffDelimiter("")).toBe(",");
  });
});

describe("cleanupColumnNames", () => {
  it("renames blank header cells to (blank_N)", () => {
    expect(cleanupColumnNames(["id", "", "name"])).toEqual(["id", "(blank_1)", "name"]);
  });

  it("disambiguates duplicate column names", () => {
    expect(cleanupColumnNames(["id", "amount", "amount"])).toEqual(["id", "amount", "amount__2"]);
  });
});

describe("loadCsv without a header", () => {
  it("auto-names columns col_1, col_2, ...", () => {
    const data = Buffer.from("1,foo\n2,bar\n", "utf-8");
    const { table, meta } = loadCsv(data, "noheader.csv", { hasHeader: false });
    expect(meta.columns).toEqual(["col_1", "col_2"]);
    expect(table.rows).toEqual([
      { col_1: "1", col_2: "foo" },
      { col_1: "2", col_2: "bar" },
    ]);
  });
});
