/** Canonical identities for compiler-mode units and their complete inputs. */
import { hashCanonical, sha256Text } from "../../core/contracts.ts";
import type { ConversionUnit } from "../../workflows/types.ts";

export interface CompileKeyInput {
  instruction: string;
  targetPath: string;
  language: string;
  kind: "file" | "inline";
  resolvedFacets: Readonly<Record<string, string>>;
  promptVersion: number;
  provider: string;
  model: string;
  skillsDigest: string;
  renderedContextDigest: string;
}

function normalizeInstruction(instruction: string): string {
  return instruction.trim().replace(/\s+/gu, " ");
}

/** Canonical identity of every deterministic input to one code generation. */
export function compileKey(input: CompileKeyInput): string {
  return hashCanonical({
    ...input,
    instruction: normalizeInstruction(input.instruction),
  });
}

/** Stable lockfile identity that remains the same when the instruction changes. */
export function compileUnitId(unit: ConversionUnit): string {
  return sha256Text(JSON.stringify({
    kind: unit.kind,
    sourcePath: unit.sourcePath,
    targetPath: unit.kind === "file" ? unit.outputPath! : unit.sourcePath,
    line: unit.line ?? null,
    start: unit.kind === "inline" ? unit.range?.start ?? null : null,
  }));
}
