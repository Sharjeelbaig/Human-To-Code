/** Withholds incomplete related targets so one requested feature is not half-written. */
import type { GeneratedConversionUnit, ProjectMemoryProvider } from "./types.ts";

function targetPath(item: GeneratedConversionUnit): string {
  return item.unit.kind === "file" ? item.unit.outputPath! : item.unit.sourcePath;
}

/**
 * Propagate a failed unit across its target file and evidenced companion paths.
 * This is deterministic and makes no model call.
 */
export function withholdIncompleteRelatedTargets(
  generated: readonly GeneratedConversionUnit[],
  projectMemory?: ProjectMemoryProvider,
): GeneratedConversionUnit[] {
  const results = generated.map((item) => ({ ...item }));
  const byPath = new Map<string, GeneratedConversionUnit[]>();
  for (const item of results) {
    const path = targetPath(item);
    byPath.set(path, [...(byPath.get(path) ?? []), item]);
  }
  const adjacency = new Map<string, Set<string>>([...byPath.keys()].map((path) => [path, new Set()]));
  for (const items of byPath.values()) {
    const unit = items[0]!.unit;
    for (const relation of projectMemory?.relationsFor?.(unit) ?? []) {
      const from = targetPath(items[0]!);
      if (relation.path === from || !byPath.has(relation.path)) continue;
      adjacency.get(from)!.add(relation.path);
      adjacency.get(relation.path)!.add(from);
    }
  }

  const visited = new Set<string>();
  for (const start of [...byPath.keys()].sort()) {
    if (visited.has(start)) continue;
    const queue = [start];
    const component: string[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const path = queue.shift()!;
      component.push(path);
      for (const next of adjacency.get(path) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    const failed = component.flatMap((path) => byPath.get(path) ?? [])
      .filter((item) => item.contextOnly !== true && (item.error !== undefined || item.code.trim().length === 0));
    if (failed.length === 0) continue;
    const failedPaths = [...new Set(failed.map(targetPath))].sort();
    const reason = `related conversion group was withheld because ${failedPaths.join(", ")} did not produce every applicable replacement`;
    for (const path of component) {
      for (const item of byPath.get(path) ?? []) {
        if (item.contextOnly === true || item.error !== undefined || item.code.trim().length === 0) continue;
        item.error = reason;
        item.code = "";
      }
    }
  }
  return results;
}
