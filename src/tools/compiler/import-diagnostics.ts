/**
 * Preflight explicit module references embedded in natural-language instructions.
 *
 * This catches a misspelled or missing dependency before generation. It does
 * not guess at prose such as "use the helpers module": only quoted specifiers
 * and unquoted relative/absolute specifiers following `import ... from` are
 * treated as import contracts.
 */
import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { ConversionUnit } from "../../workflows/types.ts";
import type { SpecDiagnostic } from "./spec-diagnostics.ts";

const MAX_INSTRUCTION_CHARS = 32_000;
const IMPORT_FROM_QUOTED =
  /\bimport\b[^\r\n;]{0,240}?\bfrom\s*["'`]([^"'`\r\n]+)["'`]/giu;
const SIDE_EFFECT_IMPORT =
  /\bimport\s*["'`]([^"'`\r\n]+)["'`]/giu;
const IMPORT_FROM_PATH =
  /\bimport\b[^\r\n;]{0,240}?\bfrom\s+((?:\.\.?\/|\/)[^\s"'`;,)]*)/giu;

function targetPath(unit: ConversionUnit): string {
  return unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
}

function projectRoot(unit: ConversionUnit): string {
  const sourceSegments = unit.sourcePath.split("/").filter(Boolean);
  return resolve(unit.absoluteSource, ...sourceSegments.map(() => ".."));
}

function requestedModules(instruction: string): string[] {
  const bounded = instruction.slice(0, MAX_INSTRUCTION_CHARS);
  const modules = new Set<string>();
  for (const pattern of [
    IMPORT_FROM_QUOTED,
    SIDE_EFFECT_IMPORT,
    IMPORT_FROM_PATH,
  ]) {
    pattern.lastIndex = 0;
    for (const match of bounded.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) modules.add(specifier);
    }
  }
  return [...modules];
}

function plannedPaths(units: readonly ConversionUnit[]): Set<string> {
  const paths = new Set<string>();
  for (const unit of units) {
    const root = projectRoot(unit);
    paths.add(resolve(root, targetPath(unit)));
  }
  return paths;
}

function plannedDirectories(paths: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = dirname(path);
    while (!directories.has(current)) {
      directories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return directories;
}

function canResolveModule(
  specifier: string,
  containingFile: string,
  planned: ReadonlySet<string>,
  plannedDirs: ReadonlySet<string>,
): boolean {
  if (
    isBuiltin(specifier)
    || /^(?:node:|data:|https?:|file:)/iu.test(specifier)
  ) {
    return true;
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const exact = resolve(dirname(containingFile), specifier);
    if (planned.has(exact) || existsSync(exact)) return true;
  }

  const options: ts.CompilerOptions = {
    allowJs: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
  };
  const base = ts.createCompilerHost(options, true);
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => planned.has(resolve(path)) || base.fileExists(path),
    readFile: (path) => planned.has(resolve(path)) ? "" : base.readFile(path),
    directoryExists: (path) =>
      plannedDirs.has(resolve(path)) || base.directoryExists?.(path) === true,
    getCurrentDirectory: () => dirname(containingFile),
    getDirectories: base.getDirectories?.bind(base),
    realpath: base.realpath?.bind(base),
  };
  return ts.resolveModuleName(specifier, containingFile, options, host)
    .resolvedModule !== undefined;
}

/** Diagnose explicit import specifiers that cannot resolve from their target. */
export function diagnoseInstructionImports(
  units: readonly ConversionUnit[],
): SpecDiagnostic[] {
  const planned = plannedPaths(units);
  const plannedDirs = plannedDirectories(planned);
  const diagnostics: SpecDiagnostic[] = [];

  for (const unit of units) {
    const relativeTarget = targetPath(unit);
    const absoluteTarget = resolve(projectRoot(unit), relativeTarget);
    for (const specifier of requestedModules(unit.prompt)) {
      if (canResolveModule(specifier, absoluteTarget, planned, plannedDirs)) {
        continue;
      }
      diagnostics.push({
        code: "E-IMPORT-UNRESOLVED",
        rule: "import",
        severity: "error",
        sourcePath: unit.sourcePath,
        ...(unit.line !== undefined ? { line: unit.line } : {}),
        targetPath: relativeTarget,
        message:
          `The requested import ${JSON.stringify(specifier)} cannot be resolved from ${relativeTarget}.`,
        facets: [],
      });
    }
  }
  return diagnostics;
}
