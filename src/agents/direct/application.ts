import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { replaceInlineMarker } from "./replacement.ts";
import type { ConversionUnit } from "./types.ts";

export class DirectApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectApplicationError";
  }
}

/** Apply one already-generated unit and return the project-relative path changed. */
export async function applyUnit(root: string, unit: ConversionUnit, code: string): Promise<string> {
  const absoluteRoot = resolve(root);
  if (unit.kind === "file") {
    const target = resolve(absoluteRoot, unit.outputPath!);
    if (!target.startsWith(absoluteRoot + sep)) {
      throw new Error(`Refusing to write outside the project root: ${unit.outputPath}`);
    }
    try {
      await writeFile(target, code.endsWith("\n") ? code : `${code}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DirectApplicationError(`Refusing to overwrite existing generated target: ${unit.outputPath}`);
      }
      throw error;
    }
    return unit.outputPath!;
  }

  const original = await readFile(unit.absoluteSource, "utf8");
  const { start, end } = unit.range!;
  let replaced: string;
  try {
    replaced = replaceInlineMarker(original, { start, end }, unit.expectedMarker, code);
  } catch (error) {
    throw new DirectApplicationError(
      `${unit.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
