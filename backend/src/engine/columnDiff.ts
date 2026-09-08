import type { ColumnDifferences, CompareSettings, FileMeta } from "./types";

/** Port of comparison.py's `_resolve_columns`. Builds {canonical -> actual
 * name} maps for both sides; when fuzzy, names differing only by
 * case/whitespace are treated as the same column, while actual names are
 * preserved for display. */
function resolveColumns(
  sourceCols: readonly string[],
  targetCols: readonly string[],
  fuzzy: boolean
): { srcMap: Map<string, string>; tgtMap: Map<string, string> } {
  const canon = (name: string) => (fuzzy ? name.trim().toLowerCase() : name);
  const srcMap = new Map<string, string>();
  for (const c of sourceCols) srcMap.set(canon(c), c);
  const tgtMap = new Map<string, string>();
  for (const c of targetCols) tgtMap.set(canon(c), c);
  return { srcMap, tgtMap };
}

/**
 * Port of comparison.py's `compare_columns` (lines 1864-1914). Structural
 * column-level comparison: presence, ordinal position, and inferred dtype.
 */
export function compareColumns(
  sourceMeta: FileMeta,
  targetMeta: FileMeta,
  settings: CompareSettings
): ColumnDifferences {
  const { srcMap, tgtMap } = resolveColumns(
    sourceMeta.columns,
    targetMeta.columns,
    settings.fuzzyColumnNames
  );
  const srcKeys = new Set(srcMap.keys());
  const tgtKeys = new Set(tgtMap.keys());

  const commonCanon = [...srcKeys].filter((k) => tgtKeys.has(k)).sort();
  const sourceOnly = [...srcKeys].filter((k) => !tgtKeys.has(k)).map((k) => srcMap.get(k)!).sort();
  const targetOnly = [...tgtKeys].filter((k) => !srcKeys.has(k)).map((k) => tgtMap.get(k)!).sort();

  const srcIndex = new Map(sourceMeta.columns.map((c, i) => [c, i]));
  const tgtIndex = new Map(targetMeta.columns.map((c, i) => [c, i]));
  const sequenceMismatches: ColumnDifferences["sequenceMismatches"] = [];
  for (const k of commonCanon) {
    const sName = srcMap.get(k)!;
    const tName = tgtMap.get(k)!;
    if (srcIndex.get(sName) !== tgtIndex.get(tName)) {
      sequenceMismatches.push({
        column: sName === tName ? sName : `${sName} / ${tName}`,
        sourceIndex: srcIndex.get(sName)!,
        targetIndex: tgtIndex.get(tName)!,
      });
    }
  }

  const srcDtypes = new Map(sourceMeta.dtypes);
  const tgtDtypes = new Map(targetMeta.dtypes);
  const dtypeMismatches: ColumnDifferences["dtypeMismatches"] = [];
  for (const k of commonCanon) {
    const sName = srcMap.get(k)!;
    const tName = tgtMap.get(k)!;
    const sDt = srcDtypes.get(sName) ?? "?";
    const tDt = tgtDtypes.get(tName) ?? "?";
    if (sDt !== tDt) {
      dtypeMismatches.push({
        column: sName === tName ? sName : `${sName} / ${tName}`,
        sourceDtype: sDt,
        targetDtype: tDt,
      });
    }
  }

  const common = commonCanon.map((k) => srcMap.get(k)!).sort();

  return { sourceOnly, targetOnly, common, sequenceMismatches, dtypeMismatches };
}
