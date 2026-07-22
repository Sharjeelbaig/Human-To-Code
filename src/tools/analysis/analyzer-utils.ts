/**
 * Shared analyzer infrastructure: bounded read-only repository scanning,
 * hashing, evidence collection, diagnostics, and workspace finalization used
 * by every ecosystem adapter.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnalysisEvidenceV1,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerInventory,
  AnalyzerOptions,
  ProfileSignalValue,
  ScanSummaryV1,
  WorkspaceProfileV1,
} from "./analyzer-types.ts";

const DEFAULT_MAX_DIRECTORIES = 25_000;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_TEXT_BYTES = 1_048_576;

const ALWAYS_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  ".coverage",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

export interface ScanResult {
  inventory: AnalyzerInventory;
  diagnostics: AnalyzerDiagnostic[];
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function normalizeProjectPath(path: string): string {
  const normalized = toPosix(path).replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "" ? "." : normalized;
}

export function joinProjectPath(...parts: string[]): string {
  const joined = parts
    .filter((part) => part !== "" && part !== ".")
    .join("/")
    .replace(/\/{2,}/g, "/");
  return normalizeProjectPath(joined);
}

export function projectDirname(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (normalized === "." || !normalized.includes("/")) return ".";
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

export function projectBasename(path: string): string {
  const normalized = normalizeProjectPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function isBelow(path: string, root: string): boolean {
  const candidate = normalizeProjectPath(path);
  const parent = normalizeProjectPath(root);
  return parent === "." || candidate === parent || candidate.startsWith(`${parent}/`);
}

export async function scanProject(
  rootInput: string,
  options: AnalyzerOptions = {},
): Promise<ScanResult> {
  const root = resolve(rootInput);
  const diagnostics: AnalyzerDiagnostic[] = [];
  const scan: ScanSummaryV1 = {
    directoriesVisited: 0,
    filesVisited: 0,
    symlinksSkipped: 0,
    ignoredEntries: 0,
    unreadablePaths: [],
    truncated: false,
  };
  const inventory: AnalyzerInventory = {
    root,
    files: [],
    directories: [],
    scan,
  };

  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    diagnostics.push({
      code: "ROOT_UNREADABLE",
      message: "The analysis root does not exist or cannot be read.",
      severity: "partial-scan",
      paths: ["."],
    });
    scan.unreadablePaths.push(".");
    return { inventory, diagnostics };
  }
  if (rootStat.isSymbolicLink()) {
    diagnostics.push({
      code: "ROOT_IS_SYMLINK",
      message: "A symbolic-link root is refused because workspace confinement would be ambiguous.",
      severity: "partial-scan",
      paths: ["."],
    });
    return { inventory, diagnostics };
  }
  if (!rootStat.isDirectory()) {
    diagnostics.push({
      code: "ROOT_NOT_DIRECTORY",
      message: "The analysis root must be a directory.",
      severity: "partial-scan",
      paths: ["."],
    });
    return { inventory, diagnostics };
  }

  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: root, relative: "." },
  ];

  while (pending.length > 0) {
    if (scan.directoriesVisited >= maxDirectories || scan.filesVisited >= maxFiles) {
      scan.truncated = true;
      diagnostics.push({
        code: "SCAN_LIMIT_EXCEEDED",
        message: `Static scan stopped at ${maxDirectories} directories or ${maxFiles} files; no complete profile can be claimed.`,
        severity: "partial-scan",
        paths: ["."],
      });
      break;
    }
    const current = pending.shift();
    if (!current) break;
    scan.directoriesVisited++;
    inventory.directories.push(current.relative);

    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      scan.unreadablePaths.push(current.relative);
      diagnostics.push({
        code: "UNREADABLE_PATH",
        message: "A directory could not be read, so project analysis is incomplete.",
        severity: "partial-scan",
        paths: [current.relative],
      });
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relPath = joinProjectPath(current.relative, entry.name);
      if (entry.isSymbolicLink()) {
        scan.symlinksSkipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) {
          scan.ignoredEntries++;
          continue;
        }
        pending.push({ absolute: resolve(current.absolute, entry.name), relative: relPath });
        continue;
      }
      if (!entry.isFile()) continue;
      scan.filesVisited++;
      inventory.files.push(relPath);
      if (scan.filesVisited >= maxFiles) break;
    }
  }

  inventory.directories.sort();
  inventory.files.sort();
  scan.unreadablePaths.sort();
  return { inventory, diagnostics };
}

class StaticAnalyzerContext implements AnalyzerContext {
  readonly inventory: AnalyzerInventory;
  private readonly diagnostics: AnalyzerDiagnostic[];
  private readonly maximumTextBytes: number;
  private readonly textCache = new Map<string, string | undefined>();

  constructor(
    inventory: AnalyzerInventory,
    diagnostics: AnalyzerDiagnostic[],
    options: AnalyzerOptions,
  ) {
    this.inventory = inventory;
    this.diagnostics = diagnostics;
    this.maximumTextBytes = options.maxTextFileBytes ?? DEFAULT_MAX_TEXT_BYTES;
  }

  hasFile(path: string): boolean {
    return this.inventory.files.includes(normalizeProjectPath(path));
  }

  hasDirectory(path: string): boolean {
    return this.inventory.directories.includes(normalizeProjectPath(path));
  }

  filesBelow(path: string): string[] {
    const root = normalizeProjectPath(path);
    return this.inventory.files.filter((file) => isBelow(file, root));
  }

  addDiagnostic(diagnostic: AnalyzerDiagnostic): void {
    this.diagnostics.push({
      ...diagnostic,
      paths: [...diagnostic.paths].map(normalizeProjectPath).sort(),
    });
  }

  async readText(path: string, maxBytes = this.maximumTextBytes): Promise<string | undefined> {
    const relPath = normalizeProjectPath(path);
    const cacheKey = `${relPath}\u0000${maxBytes}`;
    if (this.textCache.has(cacheKey)) return this.textCache.get(cacheKey);
    if (!this.hasFile(relPath) || isAbsolute(relPath) || relPath.split("/").includes("..")) {
      this.addDiagnostic({
        code: "READ_OUTSIDE_INVENTORY",
        message: "An adapter attempted to read a path outside the confined static inventory.",
        severity: "partial-scan",
        paths: [relPath],
      });
      this.textCache.set(cacheKey, undefined);
      return undefined;
    }
    const absolute = resolve(this.inventory.root, relPath);
    const relativeCheck = relative(this.inventory.root, absolute);
    if (relativeCheck.startsWith("..") || isAbsolute(relativeCheck)) {
      this.addDiagnostic({
        code: "PATH_ESCAPE_BLOCKED",
        message: "A path escaped the analysis root and was blocked.",
        severity: "partial-scan",
        paths: [relPath],
      });
      this.textCache.set(cacheKey, undefined);
      return undefined;
    }
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.addDiagnostic({
          code: "NON_REGULAR_FILE_BLOCKED",
          message: "Only regular, non-symbolic-link files may be inspected.",
          severity: "partial-scan",
          paths: [relPath],
        });
        this.textCache.set(cacheKey, undefined);
        return undefined;
      }
      if (stat.size > maxBytes) {
        this.addDiagnostic({
          code: "ANALYSIS_FILE_TOO_LARGE",
          message: `A ${stat.size}-byte file exceeded the ${maxBytes}-byte static-analysis limit.`,
          severity: "partial-scan",
          paths: [relPath],
        });
        this.textCache.set(cacheKey, undefined);
        return undefined;
      }
      const text = await readFile(absolute, "utf8");
      if (text.includes("\u0000")) {
        this.addDiagnostic({
          code: "BINARY_FILE_BLOCKED",
          message: "A binary-looking file was not interpreted as project configuration.",
          severity: "warning",
          paths: [relPath],
        });
        this.textCache.set(cacheKey, undefined);
        return undefined;
      }
      this.textCache.set(cacheKey, text);
      return text;
    } catch {
      this.addDiagnostic({
        code: "UNREADABLE_FILE",
        message: "A discovered file could not be read, so project analysis is incomplete.",
        severity: "partial-scan",
        paths: [relPath],
      });
      this.textCache.set(cacheKey, undefined);
      return undefined;
    }
  }

  async contentHash(path: string): Promise<string | undefined> {
    const text = await this.readText(path);
    return text === undefined ? undefined : sha256(text);
  }
}

export function createAnalyzerContext(
  inventory: AnalyzerInventory,
  diagnostics: AnalyzerDiagnostic[],
  options: AnalyzerOptions = {},
): AnalyzerContext {
  return new StaticAnalyzerContext(inventory, diagnostics, options);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function finalizeWorkspace(
  profile: Omit<WorkspaceProfileV1, "fingerprint">,
): WorkspaceProfileV1 {
  const normalized = {
    ...profile,
    manifests: sortedUnique(profile.manifests),
    lockfiles: sortedUnique(profile.lockfiles),
    sourceRoots: sortedUnique(profile.sourceRoots),
    testRoots: sortedUnique(profile.testRoots),
    generatedRoots: sortedUnique(profile.generatedRoots),
    migrationRoots: sortedUnique(profile.migrationRoots),
    protectedRoots: sortedUnique(profile.protectedRoots),
    workspaceDependencies: sortedUnique(profile.workspaceDependencies),
    publicExports: sortedUnique(profile.publicExports),
    entryPoints: sortedUnique(profile.entryPoints),
    routes: sortedUnique(profile.routes),
    manualAcceptance: sortedUnique(profile.manualAcceptance),
    diagnostics: [...profile.diagnostics].sort(compareDiagnostics),
    evidence: [...profile.evidence].sort((left, right) =>
      `${left.path}\u0000${left.kind}\u0000${left.detail}`.localeCompare(
        `${right.path}\u0000${right.kind}\u0000${right.detail}`,
      ),
    ),
    validationPlan: [...profile.validationPlan].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  return { ...normalized, fingerprint: fingerprint(normalized) };
}

export function compareDiagnostics(
  left: AnalyzerDiagnostic,
  right: AnalyzerDiagnostic,
): number {
  return `${left.severity}\u0000${left.code}\u0000${left.paths.join("\u0000")}`.localeCompare(
    `${right.severity}\u0000${right.code}\u0000${right.paths.join("\u0000")}`,
  );
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function jsonSignal(value: unknown): ProfileSignalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => String(child));
  if (typeof value === "object") {
    const result: Record<string, ProfileSignalValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = jsonSignal(child);
    }
    return result;
  }
  return String(value);
}

/** Parse JSON-with-comments without loading or executing a JS/TS config file. */
export function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (char === "\n") {
        output += "\n";
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    output += char;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"));
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface SimpleTomlDocument {
  sections: Map<string, Array<Map<string, string>>>;
}

function stripTomlComment(line: string): string {
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (quoted === '"' && escaped) escaped = false;
      else if (quoted === '"' && char === "\\") escaped = true;
      else if (char === quoted) quoted = undefined;
      continue;
    }
    if (char === '"' || char === "'") quoted = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function bracketDelta(value: string): number {
  let delta = 0;
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (const char of value) {
    if (quoted) {
      if (quoted === '"' && escaped) escaped = false;
      else if (quoted === '"' && char === "\\") escaped = true;
      else if (char === quoted) quoted = undefined;
      continue;
    }
    if (char === '"' || char === "'") quoted = char;
    else if (char === "[" || char === "{") delta++;
    else if (char === "]" || char === "}") delta--;
  }
  return delta;
}

/** A conservative TOML reader for manifests; it never evaluates values. */
export function parseSimpleToml(text: string): SimpleTomlDocument {
  const sections = new Map<string, Array<Map<string, string>>>();
  let section = "";
  let current = new Map<string, string>();
  sections.set(section, [current]);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = stripTomlComment(lines[index] ?? "").trim();
    if (line === "") continue;
    const arrayHeader = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayHeader) {
      section = (arrayHeader[1] ?? "").trim();
      current = new Map<string, string>();
      const existing = sections.get(section) ?? [];
      existing.push(current);
      sections.set(section, existing);
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim();
      const existing = sections.get(section);
      if (existing?.[0]) current = existing[0];
      else {
        current = new Map<string, string>();
        sections.set(section, [current]);
      }
      continue;
    }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = (assignment[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    let raw = (assignment[2] ?? "").trim();
    let depth = bracketDelta(raw);
    while (depth > 0 && index + 1 < lines.length) {
      index++;
      const continued = stripTomlComment(lines[index] ?? "").trim();
      raw += `\n${continued}`;
      depth += bracketDelta(continued);
    }
    current.set(key, raw);
  }
  return { sections };
}

export function tomlSection(
  document: SimpleTomlDocument,
  name: string,
): Map<string, string> {
  return document.sections.get(name)?.[0] ?? new Map<string, string>();
}

export function tomlString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const match = /^(?:"((?:\\.|[^"])*)"|'([^']*)')$/.exec(trimmed);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? "").replace(/\\"/g, '"');
}

export function tomlBoolean(raw: string | undefined): boolean | undefined {
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

export function tomlArray(raw: string | undefined): string[] {
  if (!raw) return [];
  const values: string[] = [];
  const matcher = /"((?:\\.|[^"])*)"|'([^']*)'/g;
  for (const match of raw.matchAll(matcher)) values.push(match[1] ?? match[2] ?? "");
  return values;
}

export function inlineTableString(
  raw: string | undefined,
  key: string,
): string | undefined {
  if (!raw) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,\\s{])${escaped}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`).exec(raw);
  return match?.[1] ?? match?.[2];
}

export function globMatches(pattern: string, path: string): boolean {
  const normalizedPattern = normalizeProjectPath(pattern).replace(/^!/, "");
  const normalizedPath = normalizeProjectPath(path);
  let expression = "";
  for (let index = 0; index < normalizedPattern.length; index++) {
    const char = normalizedPattern[index] ?? "";
    const next = normalizedPattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      expression += ".*";
      index++;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(normalizedPath);
}

export async function evidenceFor(
  context: AnalyzerContext,
  path: string,
  kind: AnalysisEvidenceV1["kind"],
  detail: string,
): Promise<AnalysisEvidenceV1> {
  const contentHash = await context.contentHash(path);
  return {
    kind,
    path: normalizeProjectPath(path),
    detail,
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}

export function nearestExistingRoots(
  context: AnalyzerContext,
  workspaceRoot: string,
  names: readonly string[],
): string[] {
  return names
    .map((name) => joinProjectPath(workspaceRoot, name))
    .filter((path) => context.hasDirectory(path));
}

export function filesWithExtensions(
  context: AnalyzerContext,
  root: string,
  extensions: readonly string[],
): string[] {
  return context
    .filesBelow(root)
    .filter((file) => extensions.some((extension) => file.endsWith(extension)));
}

export function relativeToWorkspace(workspaceRoot: string, path: string): string {
  const normalizedRoot = normalizeProjectPath(workspaceRoot);
  const normalizedPath = normalizeProjectPath(path);
  if (normalizedRoot === ".") return normalizedPath;
  return normalizedPath === normalizedRoot
    ? "."
    : normalizedPath.slice(normalizedRoot.length + 1);
}

export function findAncestorFiles(
  context: AnalyzerContext,
  startRoot: string,
  basenames: readonly string[],
): string[] {
  const result: string[] = [];
  let current = normalizeProjectPath(startRoot);
  while (true) {
    for (const basename of basenames) {
      const candidate = joinProjectPath(current, basename);
      if (context.hasFile(candidate)) result.push(candidate);
    }
    if (current === ".") break;
    current = projectDirname(current);
  }
  return sortedUnique(result);
}

export function withoutAbsoluteRoot(profile: WorkspaceProfileV1): ProfileSignalValue {
  return jsonSignal({ ...profile, fingerprint: undefined });
}

export function nativeDirname(path: string): string {
  return dirname(path);
}
