/**
 * Import-graph dependency grouping and diagnostic-to-unit attribution for the
 * candidate overlay. Groups are connected components of candidate files linked
 * by resolved module imports; a cross-file error rejects its whole group so a
 * broken contract is never partially written.
 */
import ts from "typescript";
import { overlayPathKey, type CandidateOverlay } from "./candidate-overlay.ts";
import type { ProjectDiagnostic, ValidationProgramContext } from "./program-diagnostics.ts";
import { overlayCompilerHost } from "./program-diagnostics.ts";
import { resolve, sep } from "node:path";

export interface OverlayDependencyGroups {
  /** Overlay path key -> group id. */
  groupOf: Map<string, number>;
  /** Group id -> overlay path keys in that group. */
  members: Map<number, string[]>;
}

export interface DiagnosticAttribution {
  /** Overlay path key -> new diagnostics attributed to that candidate file. */
  byFile: Map<string, ProjectDiagnostic[]>;
  /** Diagnostics that could not be safely attributed to any candidate file. */
  unattributed: ProjectDiagnostic[];
}

function resolveImports(
  fileName: string,
  content: string,
  context: ValidationProgramContext,
  host: ts.CompilerHost,
): string[] {
  const resolved: string[] = [];
  for (const imported of ts.preProcessFile(content, true, true).importedFiles) {
    const resolution = ts.resolveModuleName(imported.fileName, fileName, context.options, host);
    const target = resolution.resolvedModule?.resolvedFileName;
    if (!target) continue;
    if (resolution.resolvedModule?.isExternalLibraryImport) continue;
    if (resolve(target).split(sep).includes("node_modules")) continue;
    resolved.push(resolve(target));
  }
  return resolved;
}

/** Union overlay files connected by imports in either direction. */
export function buildOverlayDependencyGroups(
  overlay: CandidateOverlay,
  context: ValidationProgramContext,
): OverlayDependencyGroups {
  const host = overlayCompilerHost(context, overlay);
  const keys = [...overlay.files.keys()];
  const parent = new Map<string, string>(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let current = key;
    while (parent.get(current) !== current) current = parent.get(current)!;
    parent.set(key, current);
    return current;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  for (const [key, file] of overlay.files) {
    for (const target of resolveImports(file.absolutePath, file.content, context, host)) {
      const targetKey = overlayPathKey(target);
      if (overlay.files.has(targetKey)) union(key, targetKey);
    }
  }

  const groupOf = new Map<string, number>();
  const members = new Map<number, string[]>();
  const rootIds = new Map<string, number>();
  for (const key of keys) {
    const root = find(key);
    let id = rootIds.get(root);
    if (id === undefined) {
      id = rootIds.size;
      rootIds.set(root, id);
    }
    groupOf.set(key, id);
    const bucket = members.get(id) ?? [];
    bucket.push(key);
    members.set(id, bucket);
  }
  return { groupOf, members };
}

const ATTRIBUTION_SEARCH_DEPTH = 6;

/**
 * Attribute each newly introduced diagnostic to candidate files. Diagnostics
 * inside a candidate file attach directly; diagnostics in untouched project
 * files are followed through their resolved relative imports (bounded breadth-
 * first search) to the candidate files that could have caused them. Anything
 * that cannot be linked stays unattributed, and the caller must fail the batch.
 */
export function attributeDiagnostics(
  diagnostics: readonly ProjectDiagnostic[],
  overlay: CandidateOverlay,
  context: ValidationProgramContext,
): DiagnosticAttribution {
  const host = overlayCompilerHost(context, overlay);
  const byRelativePath = new Map<string, string>();
  for (const [key, file] of overlay.files) byRelativePath.set(file.path, key);

  const reachableCache = new Map<string, string[]>();
  const reachableOverlayFiles = (absolutePath: string): string[] => {
    const startKey = overlayPathKey(absolutePath);
    const cached = reachableCache.get(startKey);
    if (cached) return cached;
    const found = new Set<string>();
    const visited = new Set<string>([startKey]);
    let frontier = [resolve(absolutePath)];
    for (let depth = 0; depth < ATTRIBUTION_SEARCH_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const fileName of frontier) {
        const content = overlay.files.get(overlayPathKey(fileName))?.content ?? host.readFile(fileName);
        if (content === undefined) continue;
        for (const target of resolveImports(fileName, content, context, host)) {
          const targetKey = overlayPathKey(target);
          if (visited.has(targetKey)) continue;
          visited.add(targetKey);
          if (overlay.files.has(targetKey)) found.add(targetKey);
          else next.push(target);
        }
      }
      frontier = next;
    }
    const result = [...found];
    reachableCache.set(startKey, result);
    return result;
  };

  const byFile = new Map<string, ProjectDiagnostic[]>();
  const unattributed: ProjectDiagnostic[] = [];
  const attach = (key: string, diagnostic: ProjectDiagnostic): void => {
    const bucket = byFile.get(key) ?? [];
    bucket.push(diagnostic);
    byFile.set(key, bucket);
  };
  for (const diagnostic of diagnostics) {
    if (diagnostic.path === undefined) {
      unattributed.push(diagnostic);
      continue;
    }
    const direct = byRelativePath.get(diagnostic.path);
    if (direct !== undefined) {
      attach(direct, diagnostic);
      continue;
    }
    const reached = reachableOverlayFiles(resolve(overlay.root, ...diagnostic.path.split("/")));
    if (reached.length === 0) {
      unattributed.push(diagnostic);
      continue;
    }
    for (const key of reached) attach(key, diagnostic);
  }
  return { byFile, unattributed };
}
