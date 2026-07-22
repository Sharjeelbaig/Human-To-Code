/** Bounded, read-only context tools exposed to the compiler agent. */

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectProfileV1, WorkspaceProfileV1 } from "../tools/analysis/analyzer-types.ts";
import {
  ContextRequestSession,
  isProtectedContextPath,
  type ContextCandidateV1,
  type ContextRequestV1,
  type OfficialDocumentationCandidateV1,
} from "./context.ts";

const MAX_INDEX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_FILES = 20_000;
const SEARCHABLE_EXTENSIONS = /(?:\.(?:c|cc|cpp|cxx|h|hpp|js|jsx|mjs|cjs|ts|tsx|mts|cts|json|toml|py|pyi|rs|md|mdx|txt|yaml|yml)|(?:^|\/)(?:Dockerfile|Makefile|Pipfile|requirements[^/]*\.txt))$/iu;

export class CompilerToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompilerToolError";
    this.code = code;
  }
}

export interface CompilerToolExecutorOptions {
  maximumRequests?: number;
  maximumFiles?: number;
  maximumFileBytes?: number;
  officialDocumentation?: (request: {
    workspace: WorkspaceProfileV1;
    dependency: string;
    version: string;
    reason: string;
  }) => Promise<OfficialDocumentationCandidateV1 | undefined>;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function below(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function knownWorkspacePaths(workspace: WorkspaceProfileV1): string[] {
  return [...new Set([
    ...workspace.manifests,
    ...workspace.lockfiles,
    ...workspace.sourceRoots,
    ...workspace.testRoots,
    ...workspace.entryPoints,
    ...workspace.routes,
    ...workspace.evidence.map((item) => item.path),
  ])].filter((path) => path !== "." && !isProtectedContextPath(path)).sort();
}

async function regularTextMetadata(root: string, path: string, maximumBytes: number, canonicalRootInput?: string): Promise<{ text: string } | undefined> {
  if (isAbsolute(path) || path.includes("\0") || isProtectedContextPath(path)) return undefined;
  const absolute = resolve(root, ...path.split("/"));
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  const canonicalRoot = canonicalRootInput ?? await realpath(root).catch(() => undefined);
  if (!canonicalRoot) return undefined;
  const canonical = await realpath(absolute).catch(() => undefined);
  if (!canonical) return undefined;
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (canonicalRelative === "" || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) return undefined;
  const metadata = await lstat(canonical).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > maximumBytes) return undefined;
  const bytes = await readFile(canonical);
  if (bytes.includes(0)) return undefined;
  return { text: bytes.toString("utf8") };
}

function candidate(path: string, reason: string, range?: { startLine: number; endLine: number }, origin: "project" | "dependency" | "diagnostic" = "project"): ContextCandidateV1 {
  return {
    origin,
    path,
    reason,
    ...(range === undefined ? {} : { range }),
  };
}

export class CompilerToolExecutor {
  readonly session: ContextRequestSession;
  readonly #root: string;
  readonly #profile: ProjectProfileV1;
  readonly #maximumFiles: number;
  readonly #maximumFileBytes: number;
  readonly #canonicalRoot: Promise<string | undefined>;
  readonly #officialDocumentation: CompilerToolExecutorOptions["officialDocumentation"];

  constructor(root: string, profile: ProjectProfileV1, options: CompilerToolExecutorOptions = {}) {
    this.#root = resolve(root);
    this.#canonicalRoot = realpath(this.#root).catch(() => undefined);
    this.#profile = profile;
    this.#maximumFiles = options.maximumFiles ?? MAX_INDEX_FILES;
    this.#maximumFileBytes = options.maximumFileBytes ?? MAX_INDEX_FILE_BYTES;
    this.#officialDocumentation = options.officialDocumentation;
    if (!Number.isSafeInteger(this.#maximumFiles) || this.#maximumFiles < 1 || this.#maximumFiles > MAX_INDEX_FILES) {
      throw new RangeError(`maximumFiles must be from 1 to ${MAX_INDEX_FILES}.`);
    }
    if (!Number.isSafeInteger(this.#maximumFileBytes) || this.#maximumFileBytes < 1 || this.#maximumFileBytes > MAX_INDEX_FILE_BYTES) {
      throw new RangeError(`maximumFileBytes must be from 1 to ${MAX_INDEX_FILE_BYTES}.`);
    }
    this.session = new ContextRequestSession(options.maximumRequests ?? 8);
  }

  async #regularText(path: string): Promise<{ text: string } | undefined> {
    const canonicalRoot = await this.#canonicalRoot;
    if (!canonicalRoot) return undefined;
    return regularTextMetadata(this.#root, path, this.#maximumFileBytes, canonicalRoot);
  }

  #workspace(request: ContextRequestV1): WorkspaceProfileV1 {
    const matches = this.#profile.workspaces.filter(
      (workspace) => workspace.id === request.workspace || workspace.relativeRoot === request.workspace,
    );
    if (matches.length !== 1) {
      throw new CompilerToolError("UNKNOWN_WORKSPACE", "Context requests must identify exactly one analyzed workspace.");
    }
    return matches[0]!;
  }

  async execute(value: unknown): Promise<ContextCandidateV1[]> {
    const request = this.session.accept(value);
    const workspace = this.#workspace(request);
    if (request.kind === "file") return this.#file(request, workspace);
    if (request.kind === "symbol") return this.#symbol(request, workspace);
    if (request.kind === "dependency-doc") return this.#dependency(request, workspace);
    return this.#diagnostic(request, workspace);
  }

  async #file(request: ContextRequestV1, workspace: WorkspaceProfileV1): Promise<ContextCandidateV1[]> {
    const path = request.path!;
    if (!below(path, workspace.relativeRoot) || isProtectedContextPath(path)) {
      throw new CompilerToolError("OUT_OF_SCOPE", "Requested file is outside the target workspace or protected.");
    }
    const file = await this.#regularText(path);
    if (!file) throw new CompilerToolError("UNAVAILABLE", "Requested file is not an eligible bounded text file.");
    return [candidate(path, `Compiler requested this exact file: ${request.reason}`)];
  }

  async #symbol(request: ContextRequestV1, workspace: WorkspaceProfileV1): Promise<ContextCandidateV1[]> {
    const query = request.query.trim();
    if (query.length > 256 || /[\r\n\0]/u.test(query)) throw new CompilerToolError("INVALID_QUERY", "Symbol queries must be a single bounded literal.");
    const paths = await this.#workspaceFiles(workspace);
    const matches: ContextCandidateV1[] = [];
    for (const path of paths) {
      const file = await this.#regularText(path);
      if (!file) continue;
      const lines = file.text.split("\n");
      const index = lines.findIndex((line) => line.includes(query));
      if (index < 0) continue;
      matches.push(candidate(path, `Literal symbol/context match for ${JSON.stringify(query)}: ${request.reason}`, {
        startLine: Math.max(1, index + 1 - 20),
        endLine: Math.min(lines.length, index + 1 + 20),
      }));
      if (matches.length >= request.maxItems) break;
    }
    return matches;
  }

  async #workspaceFiles(workspace: WorkspaceProfileV1): Promise<string[]> {
    const found = new Set(knownWorkspacePaths(workspace).filter((path) => SEARCHABLE_EXTENSIONS.test(path)));
    const roots = [...new Set([...workspace.sourceRoots, ...workspace.testRoots])].sort();
    const visit = async (projectPath: string): Promise<void> => {
      if (found.size >= this.#maximumFiles || isProtectedContextPath(projectPath) || !below(projectPath, workspace.relativeRoot)) return;
      const absolute = resolve(this.#root, ...projectPath.split("/"));
      const rel = relative(this.#root, absolute);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
      const metadata = await lstat(absolute).catch(() => undefined);
      if (!metadata || metadata.isSymbolicLink()) return;
      if (metadata.isFile()) {
        if (metadata.nlink === 1 && metadata.size <= this.#maximumFileBytes && SEARCHABLE_EXTENSIONS.test(projectPath)) found.add(projectPath);
        return;
      }
      if (!metadata.isDirectory()) return;
      const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (found.size >= this.#maximumFiles) break;
        const child = projectPath === "." ? entry.name : `${projectPath}/${entry.name}`;
        await visit(child);
      }
    };
    for (const root of roots) await visit(root);
    return [...found].filter((path) => below(path, workspace.relativeRoot)).sort().slice(0, this.#maximumFiles);
  }

  async #dependency(request: ContextRequestV1, workspace: WorkspaceProfileV1): Promise<ContextCandidateV1[]> {
    const name = request.query.trim();
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name)) {
      throw new CompilerToolError("INVALID_DEPENDENCY", "Dependency requests must use one exact package/crate distribution name.");
    }
    const dependency = workspace.framework.dependencies.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!dependency) throw new CompilerToolError("UNKNOWN_DEPENDENCY", "The requested dependency is not proven by the workspace profile.");

    const results: ContextCandidateV1[] = [];
    let hasInstalledApiEvidence = false;
    if (workspace.ecosystem === "react" || workspace.ecosystem === "nestjs") {
      const packageRoots = [...new Set([
        workspace.relativeRoot === "." ? `node_modules/${name}` : `${workspace.relativeRoot}/node_modules/${name}`,
        `node_modules/${name}`,
      ])];
      for (const packageRoot of packageRoots) {
        if (results.length >= request.maxItems) break;
        const manifestPath = `${packageRoot}/package.json`;
        const manifest = await this.#regularText(manifestPath);
        if (!manifest) continue;
        results.push(candidate(manifestPath, `Installed package metadata for ${name}: ${request.reason}`, undefined, "dependency"));
        try {
          const parsed = JSON.parse(manifest.text) as Record<string, unknown>;
          const typePaths = new Set<string>();
          if (typeof parsed.types === "string") typePaths.add(parsed.types);
          if (typeof parsed.typings === "string") typePaths.add(parsed.typings);
          const collectExportTypes = (value: unknown): void => {
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
              for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
                if (key === "types" && typeof nested === "string") typePaths.add(nested);
                else collectExportTypes(nested);
              }
            }
          };
          collectExportTypes(parsed.exports);
          for (const conventional of ["index.d.ts", "dist/index.d.ts", "types/index.d.ts"]) typePaths.add(conventional);
          for (const typePath of typePaths) {
            if (results.length >= request.maxItems) break;
            if (typePath.includes("..") || isAbsolute(typePath)) continue;
            const full = `${packageRoot}/${typePath.replace(/^\.\//u, "")}`;
            if (await this.#regularText(full)) {
              results.push(candidate(full, `Installed declarations for ${name}: ${request.reason}`, undefined, "dependency"));
              hasInstalledApiEvidence = true;
            }
          }
        } catch {
          // The static profile already owns malformed-manifest diagnostics.
        }
      }
    }
    if (workspace.ecosystem === "fastapi") {
      const module = name.replaceAll("-", "_");
      const workspacePrefix = workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
      for (const environment of [".venv", "venv"]) {
        const lib = `${workspacePrefix}${environment}/lib`;
        const versions = await readdir(resolve(this.#root, lib), { withFileTypes: true }).catch(() => []);
        for (const version of versions.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!version.isDirectory() || !/^python\d+(?:\.\d+)*$/u.test(version.name)) continue;
          const site = `${lib}/${version.name}/site-packages`;
          for (const path of [
            `${site}/${module}/__init__.pyi`,
            `${site}/${module}/__init__.py`,
            `${site}/${module}.pyi`,
            `${site}/${module}.py`,
          ]) {
            if (results.length >= request.maxItems) break;
            if (await this.#regularText(path)) {
              results.push(candidate(path, `Installed Python API source/stubs for ${name}: ${request.reason}`, undefined, "dependency"));
              hasInstalledApiEvidence = true;
            }
          }
        }
      }
    }
    if (workspace.ecosystem === "rust") {
      const workspacePrefix = workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
      const vendorRoot = `${workspacePrefix}vendor`;
      const vendorEntries = await readdir(resolve(this.#root, vendorRoot), { withFileTypes: true }).catch(() => []);
      const normalized = name.replaceAll("_", "-").toLowerCase();
      for (const entry of vendorEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !(entry.name.toLowerCase() === normalized || entry.name.toLowerCase().startsWith(`${normalized}-`))) continue;
        for (const relativePath of ["Cargo.toml", "src/lib.rs"]) {
          if (results.length >= request.maxItems) break;
          const path = `${vendorRoot}/${entry.name}/${relativePath}`;
          if (await this.#regularText(path)) {
            results.push(candidate(path, `Vendored crate evidence for ${name}: ${request.reason}`, undefined, "dependency"));
            if (relativePath === "src/lib.rs") hasInstalledApiEvidence = true;
          }
        }
      }
    }
    for (const path of [...workspace.manifests, ...workspace.lockfiles]) {
      if (results.length >= request.maxItems) break;
      const file = await this.#regularText(path);
      if (!file) continue;
      const lines = file.text.split("\n");
      const index = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
      if (index >= 0) {
        results.push(candidate(path, `Declared/resolved version evidence for ${name}: ${request.reason}`, {
          startLine: Math.max(1, index + 1 - 8),
          endLine: Math.min(lines.length, index + 1 + 20),
        }, "dependency"));
      }
    }
    const exactVersion = dependency.resolvedVersion;
    if (!hasInstalledApiEvidence && results.length < request.maxItems && exactVersion && this.#officialDocumentation) {
      const documentation = await this.#officialDocumentation({
        workspace,
        dependency: dependency.name,
        version: exactVersion,
        reason: request.reason,
      });
      if (documentation) results.push(documentation);
    }
    return results.slice(0, request.maxItems);
  }

  async #diagnostic(request: ContextRequestV1, workspace: WorkspaceProfileV1): Promise<ContextCandidateV1[]> {
    const query = request.query.toLowerCase();
    const diagnostics = [...this.#profile.diagnostics, ...workspace.diagnostics]
      .filter((item) => item.code.toLowerCase().includes(query) || item.message.toLowerCase().includes(query));
    const results: ContextCandidateV1[] = [];
    for (const diagnostic of diagnostics) {
      for (const path of diagnostic.paths) {
        if (results.length >= request.maxItems) return results;
        if (!below(path, workspace.relativeRoot) || !(await this.#regularText(path))) continue;
        results.push(candidate(path, `Evidence for diagnostic ${diagnostic.code}: ${request.reason}`, undefined, "diagnostic"));
      }
    }
    return results;
  }
}

export function compilerToolPolicy(): ReadonlyArray<{ name: string; authority: string }> {
  return Object.freeze([
    { name: "symbol", authority: "literal search over bounded analyzed workspace files" },
    { name: "file", authority: "read one bounded non-protected workspace file" },
    { name: "dependency-doc", authority: "read proven installed declarations or manifest/lock evidence" },
    { name: "diagnostic", authority: "read files already named by analyzer diagnostics" },
  ]);
}
