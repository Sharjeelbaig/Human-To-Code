import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ConversionUnit } from "./types.ts";

/** Apply one already-generated unit and return the project-relative path changed. */
export async function applyUnit(root: string, unit: ConversionUnit, code: string): Promise<string> {
  const absoluteRoot = resolve(root);
  if (unit.kind === "file") {
    const target = resolve(absoluteRoot, unit.outputPath!);
    if (!target.startsWith(absoluteRoot + sep)) {
      throw new Error(`Refusing to write outside the project root: ${unit.outputPath}`);
    }
    await writeFile(target, code.endsWith("\n") ? code : `${code}\n`);
    return unit.outputPath!;
  }

  const original = await readFile(unit.absoluteSource, "utf8");
  const { start, end } = unit.range!;
  const replaced = `${original.slice(0, start)}${code.trim()}${original.slice(end)}`;
  await writeFile(unit.absoluteSource, replaced);
  return unit.sourcePath;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export { dirname };
