/**
 * Combined TypeScript program diagnostics over the candidate overlay. This is
 * static compiler validation of the in-memory candidate project — stronger
 * than per-file syntax parsing, but it never imports, executes, or sandboxes
 * project code and never claims runtime verification.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { overlayPathKey, PROJECT_VALIDATION_EXTENSIONS, type CandidateOverlay } from "./candidate-overlay.ts";
import { walkDirectFiles } from "./discovery.ts";

/** One normalized error-category compiler diagnostic. */
export interface ProjectDiagnostic {
  /** Project-relative POSIX path, or undefined for global/options diagnostics. */
  path?: string;
  /** 1-based line, when the diagnostic has a location. */
  line?: number;
  /** TypeScript diagnostic code. */
  code: number;
  message: string;
}

/**
 * Permissive fixed compiler options: the goal is catching real cross-file
 * contradictions in generated code, not enforcing a strictness style. The
 * default environment includes both modern ECMAScript and browser globals so
 * a plain HTML/CSS/JavaScript `.human` project can use `document`, `window`,
 * DOM events, and iterable DOM collections without false diagnostics. Bundler
 * resolution accepts extensionless, `.js`-suffixed, and (with noEmit)
 * `.ts`-suffixed relative imports, matching what direct models emit.
 */
function validationCompilerOptions(root: string): ts.CompilerOptions {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
  };
  const typeRoots = nodeTypeRoots(root);
  if (typeRoots.length > 0) {
    options.typeRoots = typeRoots;
    options.types = ["node"];
  } else {
    options.types = [];
  }
  return options;
}

/**
 * Locate `@types/node` so `node:` builtin imports resolve in target projects
 * that have no type dependencies of their own. The project's own copy wins;
 * otherwise the copy shipped with this package is used.
 */
function nodeTypeRoots(root: string): string[] {
  const projectTypes = resolve(root, "node_modules", "@types");
  if (existsSync(join(projectTypes, "node"))) return [projectTypes];
  try {
    const requireFromHere = createRequire(import.meta.url);
    const packageJson = requireFromHere.resolve("@types/node/package.json");
    return [dirname(dirname(packageJson))];
  } catch {
    return [];
  }
}

export interface ValidationProgramContext {
  root: string;
  options: ts.CompilerOptions;
  /** Host that answers from the overlay first, then the real file system. */
  host: ts.CompilerHost;
  /** On-disk JS/TS root files discovered with the bounded direct walk. */
  projectFiles: string[];
}

function createOverlayHost(options: ts.CompilerOptions, overlay: CandidateOverlay | undefined): ts.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  if (!overlay || overlay.files.size === 0) return base;
  const find = (fileName: string) => overlay.files.get(overlayPathKey(fileName));
  return {
    ...base,
    fileExists: (fileName) => find(fileName) !== undefined || base.fileExists(fileName),
    readFile: (fileName) => find(fileName)?.content ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const candidate = find(fileName);
      if (candidate) return ts.createSourceFile(fileName, candidate.content, languageVersionOrOptions, true);
      return base.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    },
  };
}

/** Prepare compiler options, baseline host, and the on-disk JS/TS file list once per run. */
export async function createValidationProgramContext(root: string): Promise<ValidationProgramContext> {
  const absoluteRoot = resolve(root);
  const options = validationCompilerOptions(absoluteRoot);
  const projectFiles = (await walkDirectFiles(absoluteRoot)).filter((file) =>
    PROJECT_VALIDATION_EXTENSIONS.has(extname(file).toLowerCase()));
  return { root: absoluteRoot, options, host: createOverlayHost(options, undefined), projectFiles };
}

/** Overlay-aware compiler host for module resolution outside program creation. */
export function overlayCompilerHost(context: ValidationProgramContext, overlay: CandidateOverlay): ts.CompilerHost {
  return createOverlayHost(context.options, overlay);
}

/**
 * Collect error-category diagnostics for the given program state. Diagnostics
 * inside `node_modules` or outside the project root are dropped symmetrically
 * for baseline and candidate, so third-party typing noise never decides a unit.
 */
export function collectProjectDiagnostics(
  context: ValidationProgramContext,
  overlay?: CandidateOverlay,
): ProjectDiagnostic[] {
  const rootNames = new Set(context.projectFiles.map((file) => resolve(file)));
  if (overlay) for (const file of overlay.files.values()) rootNames.add(file.absolutePath);
  const host = overlay ? createOverlayHost(context.options, overlay) : context.host;
  const program = ts.createProgram({ rootNames: [...rootNames], options: context.options, host });
  const diagnostics: ProjectDiagnostic[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const entry: ProjectDiagnostic = {
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    };
    if (diagnostic.file) {
      const fileName = resolve(diagnostic.file.fileName);
      if (fileName.split(sep).includes("node_modules")) continue;
      const rel = relative(context.root, fileName);
      if (rel.startsWith("..")) continue;
      entry.path = rel.split(sep).join("/");
      if (diagnostic.start !== undefined) {
        entry.line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      }
    }
    diagnostics.push(entry);
  }
  return diagnostics;
}

/**
 * Diff candidate diagnostics against the baseline so pre-existing project
 * errors are never blamed on generated units. Files the overlay does not touch
 * compare location-aware (path, code, line, message); overlay-modified files
 * compare by multiplicity of (path, code, message) because replacements shift
 * lines; overlay-created files are entirely new, so every diagnostic counts.
 */
export function newlyIntroducedProjectDiagnostics(
  baseline: readonly ProjectDiagnostic[],
  candidate: readonly ProjectDiagnostic[],
  overlay: CandidateOverlay,
): ProjectDiagnostic[] {
  const modified = new Set<string>();
  const created = new Set<string>();
  for (const file of overlay.files.values()) {
    (file.created ? created : modified).add(file.path);
  }
  const keyFor = (diagnostic: ProjectDiagnostic): string => {
    const locationAware = diagnostic.path === undefined || !modified.has(diagnostic.path);
    return JSON.stringify([
      diagnostic.path ?? "",
      diagnostic.code,
      locationAware ? diagnostic.line ?? -1 : -1,
      diagnostic.message,
    ]);
  };
  const remaining = new Map<string, number>();
  for (const diagnostic of baseline) {
    if (diagnostic.path !== undefined && created.has(diagnostic.path)) continue;
    const key = keyFor(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const introduced: ProjectDiagnostic[] = [];
  for (const diagnostic of candidate) {
    if (diagnostic.path !== undefined && created.has(diagnostic.path)) {
      introduced.push(diagnostic);
      continue;
    }
    const key = keyFor(diagnostic);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else introduced.push(diagnostic);
  }
  return introduced;
}
