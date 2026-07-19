/**
 * Human-to-code role: apply accepted direct-mode code to the working tree
 * only after stale-input checks, with rollback protection for file batches.
 */
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { replaceInlineMarker } from "./replacement.ts";
import type { ConversionUnit } from "./types.ts";

export class DirectApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectApplicationError";
  }
}

export interface WholeFileApplication {
  unit: ConversionUnit;
  code: string;
}

function wholeFileTarget(absoluteRoot: string, unit: ConversionUnit): string {
  if (unit.kind !== "file") throw new DirectApplicationError("Whole-file batch contains an inline unit.");
  const target = resolve(absoluteRoot, unit.outputPath!);
  if (!target.startsWith(absoluteRoot + sep)) {
    throw new DirectApplicationError(`Refusing to write outside the project root: ${unit.outputPath}`);
  }
  return target;
}

/**
 * Exclusively create a complete whole-file conversion batch. If any create
 * loses a race or fails, remove only the files created by this call so a
 * multi-file project is never knowingly left half-applied.
 */
export async function applyWholeFileBatch(
  root: string,
  applications: readonly WholeFileApplication[],
): Promise<string[]> {
  if (applications.length === 0) return [];
  const absoluteRoot = resolve(root);
  const targets = applications.map(({ unit }) => wholeFileTarget(absoluteRoot, unit));
  if (new Set(targets).size !== targets.length) {
    throw new DirectApplicationError("Whole-file batch contains duplicate output targets.");
  }
  const created: Array<{ target: string; expected: string }> = [];
  try {
    for (let index = 0; index < applications.length; index += 1) {
      const application = applications[index]!;
      const target = targets[index]!;
      const expected = application.code.endsWith("\n") ? application.code : `${application.code}\n`;
      try {
        await writeFile(target, expected, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DirectApplicationError(`Refusing to overwrite existing generated target: ${application.unit.outputPath}`);
        }
        throw error;
      }
      created.push({ target, expected });
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const { target, expected } of [...created].reverse()) {
      try {
        if (await readFile(target, "utf8") !== expected) {
          rollbackFailures.push(`${target} changed after creation and was left intact`);
          continue;
        }
        await unlink(target);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new DirectApplicationError(
      rollbackFailures.length === 0
        ? `Whole-file batch was not applied: ${reason}`
        : `Whole-file batch failed and rollback was incomplete: ${reason}; ${rollbackFailures.join("; ")}`,
    );
  }
  return applications.map(({ unit }) => unit.outputPath!);
}

/** Apply one already-generated unit and return the project-relative path changed. */
export async function applyUnit(root: string, unit: ConversionUnit, code: string): Promise<string> {
  const absoluteRoot = resolve(root);
  if (unit.kind === "file") {
    const target = wholeFileTarget(absoluteRoot, unit);
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
