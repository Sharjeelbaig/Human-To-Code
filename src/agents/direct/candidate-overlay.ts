/**
 * In-memory candidate overlay for staged multi-file validation. The overlay
 * combines every successfully generated whole-file output and inline
 * replacement without touching the working tree, so the combined candidate
 * project can be validated before any write occurs.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import ts from "typescript";
import { replaceInlineMarker } from "./replacement.ts";
import type { ConversionUnit, GeneratedConversionUnit } from "./types.ts";

/** Extensions that participate in combined TypeScript program validation. */
export const PROJECT_VALIDATION_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface CandidateOverlayFile {
  /** Project-relative POSIX path of the candidate file. */
  path: string;
  /** Absolute path used as the TypeScript program file name. */
  absolutePath: string;
  /** Complete candidate content (baseline plus replacements, or the new file). */
  content: string;
  /** True when the path does not exist in the working tree yet. */
  created: boolean;
  /** The generated units contributing to this candidate file. */
  units: ConversionUnit[];
}

export interface CandidateOverlay {
  root: string;
  /** Overlay files keyed by {@link overlayPathKey} of their absolute path. */
  files: Map<string, CandidateOverlayFile>;
  /** Units that could not enter the overlay, with the fail-closed reason. */
  excluded: Array<{ unit: ConversionUnit; reason: string }>;
}

/** Canonical map key for absolute paths, honoring platform case sensitivity. */
export function overlayPathKey(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function isValidationExtension(path: string): boolean {
  return PROJECT_VALIDATION_EXTENSIONS.has(extname(path).toLowerCase());
}

/** True when this generated unit belongs in the combined JS/TS overlay. */
export function unitParticipatesInProjectValidation(item: GeneratedConversionUnit): boolean {
  if (item.error !== undefined || item.code.trim().length === 0) return false;
  const target = item.unit.kind === "file" ? item.unit.outputPath! : item.unit.sourcePath;
  return isValidationExtension(target);
}

/**
 * Build the combined in-memory candidate state for all successful JS/TS units.
 * The working tree is never modified; stale inline markers and already-existing
 * whole-file targets are excluded fail-closed instead of guessed around.
 */
export async function buildCandidateOverlay(
  root: string,
  generated: readonly GeneratedConversionUnit[],
): Promise<CandidateOverlay> {
  const absoluteRoot = resolve(root);
  const files = new Map<string, CandidateOverlayFile>();
  const excluded: CandidateOverlay["excluded"] = [];
  const participating = generated.filter(unitParticipatesInProjectValidation);

  for (const item of participating.filter((entry) => entry.unit.kind === "file")) {
    const unit = item.unit;
    const absolutePath = resolve(absoluteRoot, unit.outputPath!);
    if (!absolutePath.startsWith(absoluteRoot + sep)) {
      excluded.push({ unit, reason: `refusing a candidate outside the project root: ${unit.outputPath}` });
      continue;
    }
    let exists = false;
    try {
      await stat(absolutePath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      excluded.push({ unit, reason: `existing target ${unit.outputPath} is never overwritten` });
      continue;
    }
    const key = overlayPathKey(absolutePath);
    if (files.has(key)) {
      excluded.push({ unit, reason: `another unit already generates ${unit.outputPath}` });
      continue;
    }
    files.set(key, {
      path: unit.outputPath!,
      absolutePath,
      content: item.code.endsWith("\n") ? item.code : `${item.code}\n`,
      created: true,
      units: [unit],
    });
  }

  const inlineByFile = new Map<string, GeneratedConversionUnit[]>();
  for (const item of participating.filter((entry) => entry.unit.kind === "inline")) {
    const key = overlayPathKey(item.unit.absoluteSource);
    const bucket = inlineByFile.get(key) ?? [];
    bucket.push(item);
    inlineByFile.set(key, bucket);
  }
  for (const bucket of inlineByFile.values()) {
    const first = bucket[0]!.unit;
    let content: string;
    try {
      content = await readFile(first.absoluteSource, "utf8");
    } catch (error) {
      const reason = `could not read ${first.sourcePath}: ${error instanceof Error ? error.message : String(error)}`;
      for (const item of bucket) excluded.push({ unit: item.unit, reason });
      continue;
    }
    // Apply bottom-to-top so earlier ranges stay valid; the exact marker bytes
    // are re-verified for every replacement.
    const ordered = [...bucket].sort((left, right) => (right.unit.range?.start ?? 0) - (left.unit.range?.start ?? 0));
    const applied: ConversionUnit[] = [];
    let failed = false;
    for (const item of ordered) {
      try {
        content = replaceInlineMarker(content, item.unit.range!, item.unit.expectedMarker, item.code);
        applied.push(item.unit);
      } catch (error) {
        failed = true;
        const reason = `${item.unit.sourcePath}: ${error instanceof Error ? error.message : String(error)}`;
        excluded.push({ unit: item.unit, reason });
      }
    }
    if (failed) {
      // A stale marker invalidates every other offset in the same file; the
      // whole file's inline units are excluded rather than partially staged.
      for (const unit of applied) {
        excluded.push({ unit, reason: `${unit.sourcePath}: another inline marker in this file was stale` });
      }
      continue;
    }
    files.set(overlayPathKey(first.absoluteSource), {
      path: first.sourcePath,
      absolutePath: resolve(first.absoluteSource),
      content,
      created: false,
      units: applied,
    });
  }

  return { root: absoluteRoot, files, excluded };
}
