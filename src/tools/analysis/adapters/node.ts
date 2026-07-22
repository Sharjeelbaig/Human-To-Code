/**
 * Node.js ecosystem adapter: static recognition of React (Vite, Next, CRA,
 * libraries, Nx) and NestJS (standalone, Nest CLI monorepo, Nx) workspaces
 * from manifests, lockfiles, and configuration — without executing project
 * code — plus their version evidence and candidate validation commands.
 */
import { posix } from "node:path";
import type {
  AnalyzerContext,
  AnalyzerDiagnostic,
  DependencyVersionEvidence,
  EcosystemAdapter,
  ProfileSignalValue,
  ValidationCategory,
  ValidationCommandV1,
  WorkspaceProfileV1,
} from "../analyzer-types.ts";
import { PROJECT_PROFILE_SCHEMA_VERSION } from "../analyzer-types.ts";
import {
  asObject,
  evidenceFor,
  finalizeWorkspace,
  findAncestorFiles,
  globMatches,
  isBelow,
  joinProjectPath,
  nearestExistingRoots,
  normalizeProjectPath,
  parseJsonc,
  projectBasename,
  projectDirname,
  relativeToWorkspace,
  sortedUnique,
} from "../analyzer-utils.ts";
import { supportFor } from "../support-matrix.ts";

const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const MAX_SOURCE_FILES = 2_000;

interface NodeManifest {
  path: string;
  root: string;
  data: Record<string, unknown>;
  name?: string;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  workspacePatterns: string[];
}

interface NodeCandidate {
  ecosystem: "react" | "nestjs";
  root: string;
  manifest: NodeManifest;
  projectConfig?: string;
  forcedVariant?: "nx-react" | "nx-nest" | "nest-monorepo";
  projectName?: string;
  sourceRoot?: string;
}

function stringRecord(value: unknown): Record<string, string> {
  const object = asObject(value);
  if (!object) return {};
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === "string") result[key] = child;
  }
  return result;
}

function allDependencies(data: Record<string, unknown>): Record<string, string> {
  return {
    ...stringRecord(data.dependencies),
    ...stringRecord(data.devDependencies),
    ...stringRecord(data.peerDependencies),
    ...stringRecord(data.optionalDependencies),
  };
}

function workspacePatterns(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.workspaces)) {
    return data.workspaces.filter((value): value is string => typeof value === "string");
  }
  const object = asObject(data.workspaces);
  if (object && Array.isArray(object.packages)) {
    return object.packages.filter((value): value is string => typeof value === "string");
  }
  return [];
}

async function readManifest(
  context: AnalyzerContext,
  path: string,
): Promise<NodeManifest | undefined> {
  const text = await context.readText(path);
  if (text === undefined) return undefined;
  try {
    const data = asObject(JSON.parse(text));
    if (!data) throw new Error("root is not an object");
    const dependencies = allDependencies(data);
    return {
      path,
      root: projectDirname(path),
      data,
      ...(typeof data.name === "string" ? { name: data.name } : {}),
      dependencies,
      scripts: stringRecord(data.scripts),
      workspacePatterns: workspacePatterns(data),
    };
  } catch (error) {
    context.addDiagnostic({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `package.json could not be parsed statically: ${String(error)}`,
      severity: "partial-scan",
      paths: [path],
    });
    return undefined;
  }
}

function frameworkKinds(manifest: NodeManifest): Array<"react" | "nestjs"> {
  const names = new Set(Object.keys(manifest.dependencies));
  const result: Array<"react" | "nestjs"> = [];
  if (names.has("react") || names.has("react-dom") || names.has("next") || names.has("react-scripts")) {
    result.push("react");
  }
  if (names.has("@nestjs/core") || names.has("@nestjs/common")) result.push("nestjs");
  return result;
}

function inferNxEcosystem(value: unknown): "react" | "nestjs" | undefined {
  const serialized = JSON.stringify(value).toLowerCase();
  if (/(@nx|@nrwl)\/(nest|node):/.test(serialized) || serialized.includes("@nestjs/")) {
    return "nestjs";
  }
  if (/(@nx|@nrwl)\/(react|next|web):/.test(serialized) || serialized.includes("next:")) {
    return "react";
  }
  return undefined;
}

async function loadNodeCandidates(
  context: AnalyzerContext,
): Promise<{ candidates: NodeCandidate[]; manifests: NodeManifest[] }> {
  const packagePaths = context.inventory.files.filter(
    (path) => projectBasename(path) === "package.json",
  );
  const manifests = (
    await Promise.all(packagePaths.map((path) => readManifest(context, path)))
  ).filter((manifest): manifest is NodeManifest => manifest !== undefined);
  for (const manifest of manifests) {
    const pnpmWorkspace = joinProjectPath(manifest.root, "pnpm-workspace.yaml");
    if (!context.hasFile(pnpmWorkspace) || manifest.workspacePatterns.length > 0) continue;
    const text = await context.readText(pnpmWorkspace);
    if (!text) continue;
    let inPackages = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) break;
      const match = inPackages ? /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line) : undefined;
      if (match?.[1]) manifest.workspacePatterns.push(match[1].trim());
    }
  }
  const candidates: NodeCandidate[] = [];
  const rootsClaimedByVirtualProjects = new Set<string>();

  // Nx project.json files describe app boundaries without requiring per-app
  // package.json files. Parse the data only; never load Nx plugins.
  for (const projectPath of context.inventory.files.filter(
    (path) => projectBasename(path) === "project.json",
  )) {
    const text = await context.readText(projectPath);
    if (!text) continue;
    let data: Record<string, unknown> | undefined;
    try {
      data = asObject(JSON.parse(text));
    } catch {
      context.addDiagnostic({
        code: "INVALID_NX_PROJECT",
        message: "Nx project.json is not valid static JSON.",
        severity: "partial-scan",
        paths: [projectPath],
      });
      continue;
    }
    if (!data) continue;
    const ecosystem = inferNxEcosystem(data);
    if (!ecosystem) continue;
    const projectRoot = projectDirname(projectPath);
    const owner = [...manifests]
      .filter((manifest) => isBelow(projectRoot, manifest.root))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (!owner) continue;
    rootsClaimedByVirtualProjects.add(owner.root);
    candidates.push({
      ecosystem,
      root: projectRoot,
      manifest: owner,
      projectConfig: projectPath,
      forcedVariant: ecosystem === "react" ? "nx-react" : "nx-nest",
      ...(typeof data.name === "string" ? { projectName: data.name } : {}),
      ...(typeof data.sourceRoot === "string"
        ? { sourceRoot: normalizeProjectPath(data.sourceRoot) }
        : {}),
    });
  }

  // Nest CLI monorepos also centralize dependencies at the root.
  for (const manifest of manifests) {
    const cliPath = joinProjectPath(manifest.root, "nest-cli.json");
    if (!context.hasFile(cliPath)) continue;
    const text = await context.readText(cliPath);
    if (!text) continue;
    let data: Record<string, unknown> | undefined;
    try {
      data = asObject(JSON.parse(text));
    } catch {
      context.addDiagnostic({
        code: "INVALID_NEST_CLI_CONFIG",
        message: "nest-cli.json is not valid static JSON.",
        severity: "partial-scan",
        paths: [cliPath],
      });
      continue;
    }
    const projects = asObject(data?.projects);
    if (!projects || Object.keys(projects).length === 0) continue;
    rootsClaimedByVirtualProjects.add(manifest.root);
    for (const [name, rawProject] of Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))) {
      const project = asObject(rawProject);
      const projectRoot =
        typeof project?.root === "string"
          ? joinProjectPath(manifest.root, project.root)
          : joinProjectPath(manifest.root, "apps", name);
      const sourceRoot =
        typeof project?.sourceRoot === "string"
          ? joinProjectPath(manifest.root, project.sourceRoot)
          : joinProjectPath(projectRoot, "src");
      candidates.push({
        ecosystem: "nestjs",
        root: projectRoot,
        manifest,
        projectConfig: cliPath,
        forcedVariant: "nest-monorepo",
        projectName: name,
        sourceRoot,
      });
    }
  }

  for (const manifest of manifests) {
    const kinds = frameworkKinds(manifest);
    for (const ecosystem of kinds) {
      if (rootsClaimedByVirtualProjects.has(manifest.root)) {
        // Keep an unrelated framework at a mixed root, but avoid duplicating
        // the ecosystem already represented by explicit virtual projects.
        if (candidates.some((candidate) => candidate.manifest === manifest && candidate.ecosystem === ecosystem)) {
          continue;
        }
      }
      candidates.push({ ecosystem, root: manifest.root, manifest });
    }
    if (kinds.length > 1 && !rootsClaimedByVirtualProjects.has(manifest.root)) {
      context.addDiagnostic({
        code: "MULTIPLE_FRAMEWORKS_ONE_WORKSPACE",
        message: "One package manifest owns both React and NestJS; target ownership must be explicit.",
        severity: "needs-input",
        paths: [manifest.path],
      });
    }
  }

  const deduplicated = new Map<string, NodeCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.ecosystem}\u0000${candidate.root}\u0000${candidate.projectConfig ?? ""}`;
    deduplicated.set(key, candidate);
  }
  return { candidates: [...deduplicated.values()], manifests };
}

function packageManagerFromLock(path: string): "npm" | "pnpm" | "yarn" | "bun" {
  const basename = projectBasename(path);
  if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") return "npm";
  if (basename === "pnpm-lock.yaml") return "pnpm";
  if (basename === "yarn.lock") return "yarn";
  return "bun";
}

function declaredPackageManager(manifest: NodeManifest): string | undefined {
  const value = manifest.data.packageManager;
  return typeof value === "string" ? value.split("@")[0] : undefined;
}

function nearestLockfiles(context: AnalyzerContext, root: string): string[] {
  const all = findAncestorFiles(context, root, NODE_LOCKFILES);
  if (all.length === 0) return [];
  const closestLength = Math.max(...all.map((path) => projectDirname(path).length));
  return all.filter((path) => projectDirname(path).length === closestLength);
}

async function resolveFromPackageLock(
  context: AnalyzerContext,
  path: string,
  dependency: string,
): Promise<string | undefined> {
  const text = await context.readText(path, 8 * 1024 * 1024);
  if (!text) return undefined;
  try {
    const root = asObject(JSON.parse(text));
    const packages = asObject(root?.packages);
    const installed = asObject(packages?.[`node_modules/${dependency}`]);
    if (typeof installed?.version === "string") return installed.version;
    const dependencies = asObject(root?.dependencies);
    const record = asObject(dependencies?.[dependency]);
    return typeof record?.version === "string" ? record.version : undefined;
  } catch {
    context.addDiagnostic({
      code: "INVALID_NODE_LOCKFILE",
      message: "The npm lockfile could not be parsed, so exact dependency versions are unresolved.",
      severity: "partial-scan",
      paths: [path],
    });
    return undefined;
  }
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveFromTextLock(
  context: AnalyzerContext,
  path: string,
  dependency: string,
): Promise<string | undefined> {
  const text = await context.readText(path, 8 * 1024 * 1024);
  if (!text) return undefined;
  const escaped = escapedRegExp(dependency);
  if (projectBasename(path) === "yarn.lock") {
    const block = new RegExp(`(?:^|\\n)[^\\n]*${escaped}@[^ \\n]*:\\s*\\n(?:[ \\t].*\\n)*?[ \\t]+version[ \\t]+["']?([^"'\\s]+)`, "m").exec(text);
    return block?.[1];
  }
  const packageKey = new RegExp(`(?:^|\\n)\\s{2,}["']?/?${escaped}@([^:\\s"']+)["']?:`, "m").exec(text);
  if (packageKey?.[1]) return packageKey[1];
  const dependencyBlock = new RegExp(
    `(?:^|\\n)\\s{2,}["']?${escaped}["']?:\\s*\\n(?:\\s{4,}.*\\n){0,4}?\\s{4,}version:\\s*["']?([^"'\\s(]+)`,
    "m",
  ).exec(text);
  return dependencyBlock?.[1];
}

function exactDeclaredVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:npm:)?(?:v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value.trim());
  return match?.[1];
}

async function dependencyEvidence(
  context: AnalyzerContext,
  manifest: NodeManifest,
  lockfiles: string[],
  name: string,
): Promise<DependencyVersionEvidence | undefined> {
  const declaredVersion = manifest.dependencies[name];
  if (declaredVersion === undefined) return undefined;
  let resolvedVersion: string | undefined;
  let source: string | undefined;
  for (const lockfile of lockfiles) {
    resolvedVersion =
      packageManagerFromLock(lockfile) === "npm"
        ? await resolveFromPackageLock(context, lockfile, name)
        : await resolveFromTextLock(context, lockfile, name);
    if (resolvedVersion) {
      source = lockfile;
      break;
    }
  }
  resolvedVersion ??= exactDeclaredVersion(declaredVersion);
  source ??= resolvedVersion ? manifest.path : undefined;
  return {
    name,
    declaredVersion,
    ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
    ...(source === undefined ? {} : { source }),
  };
}

function packageScriptCommand(
  manager: "npm" | "pnpm" | "yarn" | "bun",
  workspaceRoot: string,
  manifestPath: string,
  script: string,
  category: ValidationCategory,
  required: boolean,
): ValidationCommandV1 {
  const timeoutMs =
    category === "format"
      ? 120_000
      : category === "test" || category === "integration"
        ? 600_000
        : 300_000;
  return {
    id: `node:${workspaceRoot}:${category}:${script}`,
    category,
    cwd: workspaceRoot,
    argv: [manager, "run", script],
    source: "package-script",
    sourcePath: manifestPath,
    required,
    network: false,
    timeoutMs,
    risk: "executes-project-code",
  };
}

function validationFromScripts(
  manifest: NodeManifest,
  workspaceRoot: string,
  manager: "npm" | "pnpm" | "yarn" | "bun",
): ValidationCommandV1[] {
  const plan: ValidationCommandV1[] = [];
  const candidates: Array<{ names: string[]; category: ValidationCategory; required: boolean }> = [
    { names: ["format:check", "format-check"], category: "format", required: false },
    { names: ["lint"], category: "lint", required: true },
    { names: ["typecheck", "type-check", "check:types", "types"], category: "typecheck", required: true },
    { names: ["build"], category: "build", required: true },
    { names: ["test", "test:unit"], category: "test", required: true },
    { names: ["test:e2e", "test:integration", "e2e"], category: "integration", required: false },
  ];
  for (const candidate of candidates) {
    const selected = candidate.names.find((name) => manifest.scripts[name] !== undefined);
    if (selected) {
      plan.push(
        packageScriptCommand(
          manager,
          workspaceRoot,
          manifest.path,
          selected,
          candidate.category,
          candidate.required,
        ),
      );
    }
  }
  return plan;
}

async function readTsAliases(
  context: AnalyzerContext,
  workspaceRoot: string,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{ aliases: Record<string, string[]>; configs: string[] }> {
  const names = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json", "jsconfig.json"];
  const starting = names
    .map((name) => joinProjectPath(workspaceRoot, name))
    .find((path) => context.hasFile(path));
  const aliases: Record<string, string[]> = {};
  const configs: string[] = [];
  const visited = new Set<string>();

  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 8 || visited.has(path)) return;
    visited.add(path);
    const text = await context.readText(path);
    if (!text) return;
    configs.push(path);
    let data: Record<string, unknown> | undefined;
    try {
      data = asObject(parseJsonc(text));
    } catch {
      diagnostics.push({
        code: "INVALID_TSCONFIG",
        message: "TypeScript/JavaScript config is not valid static JSONC.",
        severity: "partial-scan",
        paths: [path],
      });
      return;
    }
    const compiler = asObject(data?.compilerOptions);
    const paths = asObject(compiler?.paths);
    if (paths) {
      for (const [key, value] of Object.entries(paths)) {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          aliases[key] = value as string[];
        }
      }
    }
    if (typeof data?.extends !== "string") return;
    if (!data.extends.startsWith(".")) {
      diagnostics.push({
        code: "UNRESOLVED_TSCONFIG_EXTENDS",
        message: "A package-based tsconfig extends target cannot be resolved without inspecting installed dependencies.",
        severity: "needs-input",
        paths: [path],
      });
      return;
    }
    let inherited = normalizeProjectPath(
      posix.normalize(posix.join(projectDirname(path), data.extends)),
    );
    if (!inherited.endsWith(".json")) inherited += ".json";
    if (!context.hasFile(inherited)) {
      diagnostics.push({
        code: "UNRESOLVED_TSCONFIG_EXTENDS",
        message: "A relative tsconfig extends target does not exist in the static inventory.",
        severity: "needs-input",
        paths: [path, inherited],
      });
      return;
    }
    await visit(inherited, depth + 1);
  }

  if (starting) await visit(starting, 0);
  return { aliases, configs: sortedUnique(configs) };
}

function dependenciesMatching(
  dependencies: Record<string, string>,
  names: readonly string[],
): string[] {
  return names.filter((name) => dependencies[name] !== undefined);
}

function routeFromAppFile(file: string, appRoot: string): string | undefined {
  const relative = relativeToWorkspace(appRoot, file);
  if (!/(^|\/)page\.(?:[cm]?[jt]sx?)$/.test(relative)) return undefined;
  const directory = projectDirname(relative);
  if (directory === ".") return "/";
  const segments = directory
    .split("/")
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

function routeFromPagesFile(file: string, pagesRoot: string): string | undefined {
  const relative = relativeToWorkspace(pagesRoot, file).replace(/\.(?:[cm]?[jt]sx?)$/, "");
  if (relative.startsWith("_") || relative.startsWith("api/")) return undefined;
  const withoutIndex = relative === "index" ? "" : relative.replace(/\/index$/, "");
  return `/${withoutIndex}`.replace(/\/$/, "") || "/";
}

async function analyzeReactSource(
  context: AnalyzerContext,
  root: string,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{
  routes: string[];
  clientFiles: string[];
  serverFiles: string[];
  routerPaths: string[];
  sourceEvidence: Array<{ path: string; hash?: string }>;
}> {
  const sourceFiles = context
    .filesBelow(root)
    .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));
  if (sourceFiles.length > MAX_SOURCE_FILES) {
    diagnostics.push({
      code: "SOURCE_ANALYSIS_LIMIT",
      message: `The workspace has ${sourceFiles.length} source files; static source analysis is capped at ${MAX_SOURCE_FILES}.`,
      severity: "partial-scan",
      paths: [root],
    });
  }
  const selected = sourceFiles.slice(0, MAX_SOURCE_FILES);
  const clientFiles: string[] = [];
  const serverFiles: string[] = [];
  const routerPaths: string[] = [];
  const evidence: Array<{ path: string; hash?: string }> = [];
  for (const file of selected) {
    const text = await context.readText(file, 512 * 1024);
    if (text === undefined) continue;
    const beginning = text.slice(0, 512);
    if (/^[\s;]*["']use client["']/.test(beginning)) clientFiles.push(file);
    if (/^[\s;]*["']use server["']/.test(beginning)) serverFiles.push(file);
    for (const match of text.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)) {
      if (match[1]) routerPaths.push(match[1]);
    }
    for (const match of text.matchAll(/\bpath\s*:\s*["']([^"']+)["']/g)) {
      if (match[1]) routerPaths.push(match[1]);
    }
    evidence.push({ path: file, hash: await context.contentHash(file) });
  }

  const routes: string[] = [];
  for (const appRoot of [joinProjectPath(root, "app"), joinProjectPath(root, "src/app")]) {
    if (!context.hasDirectory(appRoot)) continue;
    for (const file of selected.filter((candidate) => isBelow(candidate, appRoot))) {
      const route = routeFromAppFile(file, appRoot);
      if (route) routes.push(route);
    }
  }
  for (const pagesRoot of [joinProjectPath(root, "pages"), joinProjectPath(root, "src/pages")]) {
    if (!context.hasDirectory(pagesRoot)) continue;
    for (const file of selected.filter((candidate) => isBelow(candidate, pagesRoot))) {
      const route = routeFromPagesFile(file, pagesRoot);
      if (route) routes.push(route);
    }
  }
  routes.push(...routerPaths);
  return {
    routes: sortedUnique(routes),
    clientFiles: sortedUnique(clientFiles),
    serverFiles: sortedUnique(serverFiles),
    routerPaths: sortedUnique(routerPaths),
    sourceEvidence: evidence,
  };
}

function reactVariant(
  context: AnalyzerContext,
  candidate: NodeCandidate,
): { variant: string; hostVariant: string } {
  const { dependencies } = candidate.manifest;
  const app = [joinProjectPath(candidate.root, "app"), joinProjectPath(candidate.root, "src/app")].some(
    (path) => context.hasDirectory(path),
  );
  const pages = [
    joinProjectPath(candidate.root, "pages"),
    joinProjectPath(candidate.root, "src/pages"),
  ].some((path) => context.hasDirectory(path));
  let hostVariant: string;
  if (dependencies.next !== undefined) {
    hostVariant = app && pages ? "next-hybrid" : app ? "next-app-router" : "next-pages-router";
  } else if (dependencies.vite !== undefined || context.hasFile(joinProjectPath(candidate.root, "vite.config.ts")) || context.hasFile(joinProjectPath(candidate.root, "vite.config.js"))) {
    const ssr = context.inventory.files.some(
      (path) => isBelow(path, candidate.root) && /(?:entry-server|server-entry)\.[cm]?[jt]sx?$/.test(path),
    );
    hostVariant = ssr ? "vite-ssr" : "vite-spa";
  } else if (dependencies["react-scripts"] !== undefined) hostVariant = "cra";
  else hostVariant = "react-library";
  return { variant: candidate.forcedVariant ?? hostVariant, hostVariant };
}

function publicExports(data: Record<string, unknown>): string[] {
  const result: string[] = [];
  if (typeof data.main === "string") result.push(data.main);
  if (typeof data.module === "string") result.push(data.module);
  if (typeof data.types === "string") result.push(data.types);
  if (typeof data.exports === "string") result.push(data.exports);
  else {
    const exportsObject = asObject(data.exports);
    if (exportsObject) result.push(...Object.keys(exportsObject));
  }
  return sortedUnique(result);
}

function workspaceOwner(manifest: NodeManifest, all: NodeManifest[]): NodeManifest {
  return (
    [...all]
      .filter(
        (candidate) =>
          candidate.workspacePatterns.length > 0 &&
          candidate.root !== manifest.root &&
          isBelow(manifest.root, candidate.root),
      )
      .sort((left, right) => right.root.length - left.root.length)[0] ?? manifest
  );
}

function membersOf(owner: NodeManifest, all: NodeManifest[]): string[] {
  if (owner.workspacePatterns.length === 0) return [owner.root];
  const includes = owner.workspacePatterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = owner.workspacePatterns.filter((pattern) => pattern.startsWith("!"));
  return all
    .map((manifest) => manifest.root)
    .filter((root) => {
      const relative = relativeToWorkspace(owner.root, root);
      return (
        includes.some((pattern) => globMatches(pattern, relative)) &&
        !excludes.some((pattern) => globMatches(pattern.slice(1), relative))
      );
    });
}

async function analyzeReact(
  context: AnalyzerContext,
  candidate: NodeCandidate,
  manifests: NodeManifest[],
): Promise<WorkspaceProfileV1> {
  const diagnostics: AnalyzerDiagnostic[] = [];
  const lockfiles = nearestLockfiles(context, candidate.root);
  const managers = sortedUnique(lockfiles.map(packageManagerFromLock));
  const declaredManager = declaredPackageManager(candidate.manifest);
  if (managers.length > 1) {
    diagnostics.push({
      code: "CONFLICTING_NODE_LOCKFILES",
      message: "Multiple package-manager lockfiles own this workspace.",
      severity: "needs-input",
      paths: lockfiles,
    });
  }
  if (declaredManager && managers[0] && declaredManager !== managers[0]) {
    diagnostics.push({
      code: "PACKAGE_MANAGER_MISMATCH",
      message: `package.json declares ${declaredManager}, but the owning lockfile belongs to ${managers[0]}.`,
      severity: "needs-input",
      paths: [candidate.manifest.path, ...lockfiles],
    });
  }
  const manager = (managers[0] ?? declaredManager ?? "npm") as "npm" | "pnpm" | "yarn" | "bun";
  const versionNames = ["react", "react-dom", "next", "vite", "react-scripts"];
  const dependencyVersions = (
    await Promise.all(
      versionNames.map((name) => dependencyEvidence(context, candidate.manifest, lockfiles, name)),
    )
  ).filter((value): value is DependencyVersionEvidence => value !== undefined);
  const primary =
    dependencyVersions.find((dependency) => dependency.name === "next") ??
    dependencyVersions.find((dependency) => dependency.name === "react");
  if (primary && !primary.resolvedVersion) {
    diagnostics.push({
      code: "UNRESOLVED_FRAMEWORK_VERSION",
      message: `${primary.name} has no exact version in a statically readable lockfile.`,
      severity: "needs-input",
      paths: [candidate.manifest.path, ...lockfiles],
    });
  }

  const { aliases, configs } = await readTsAliases(context, candidate.root, diagnostics);
  const source = await analyzeReactSource(context, candidate.root, diagnostics);
  const { variant, hostVariant } = reactVariant(context, candidate);
  const supportDependency =
    hostVariant === "cra"
      ? dependencyVersions.find((dependency) => dependency.name === "react-scripts")
      : variant === "nx-react"
        ? dependencyVersions.find((dependency) => dependency.name === "react")
        : hostVariant.startsWith("next")
          ? dependencyVersions.find((dependency) => dependency.name === "next")
          : dependencyVersions.find((dependency) => dependency.name === "react");
  const viteVersion = dependencyVersions.find((dependency) => dependency.name === "vite")?.resolvedVersion;
  const viteMajor = viteVersion ? Number(viteVersion.split(".")[0]) : undefined;
  if (hostVariant.startsWith("vite") && viteMajor !== undefined && (viteMajor < 5 || viteMajor > 7)) {
    diagnostics.push({
      code: "UNSUPPORTED_VITE_VERSION",
      message: `Vite ${viteVersion} is outside the declared Vite 5-7 support range.`,
      severity: "unsupported",
      paths: [candidate.manifest.path, ...lockfiles],
    });
  }
  if (candidate.manifest.dependencies.next !== undefined && hostVariant === "next-pages-router") {
    const hasPages = [
      joinProjectPath(candidate.root, "pages"),
      joinProjectPath(candidate.root, "src/pages"),
    ].some((path) => context.hasDirectory(path));
    if (!hasPages) {
      diagnostics.push({
        code: "NEXT_ROUTER_UNDETERMINED",
        message: "Next.js is declared, but neither an App Router nor Pages Router root was found.",
        severity: "needs-input",
        paths: [candidate.root],
      });
    }
  }

  const dependencies = candidate.manifest.dependencies;
  const owner = workspaceOwner(candidate.manifest, manifests);
  const members = membersOf(owner, manifests);
  const packageNames = new Set(manifests.map((manifest) => manifest.name).filter(Boolean));
  const workspaceDependencies = Object.entries(dependencies)
    .filter(([name, version]) => version.startsWith("workspace:") || packageNames.has(name))
    .map(([name]) => name);
  const entryPoints = [
    "src/main.tsx",
    "src/main.jsx",
    "src/index.tsx",
    "src/index.jsx",
    "app/layout.tsx",
    "src/app/layout.tsx",
    "pages/_app.tsx",
    "src/pages/_app.tsx",
  ]
    .map((path) => joinProjectPath(candidate.root, path))
    .filter((path) => context.hasFile(path));
  const manifestsForProfile = sortedUnique([
    candidate.manifest.path,
    owner.path,
    ...(context.hasFile(joinProjectPath(owner.root, "pnpm-workspace.yaml"))
      ? [joinProjectPath(owner.root, "pnpm-workspace.yaml")]
      : []),
    ...(candidate.projectConfig ? [candidate.projectConfig] : []),
    ...configs,
  ]);
  const evidence = await Promise.all([
    evidenceFor(context, candidate.manifest.path, "manifest", "Node package manifest"),
    ...(owner.path !== candidate.manifest.path
      ? [evidenceFor(context, owner.path, "workspace", "Owning Node workspace manifest")]
      : []),
    ...(context.hasFile(joinProjectPath(owner.root, "pnpm-workspace.yaml"))
      ? [evidenceFor(context, joinProjectPath(owner.root, "pnpm-workspace.yaml"), "workspace", "pnpm workspace ownership")]
      : []),
    ...lockfiles.map((path) => evidenceFor(context, path, "lockfile", "Owning dependency lockfile")),
    ...configs.map((path) => evidenceFor(context, path, "config", "Static TypeScript alias configuration")),
    ...(candidate.projectConfig
      ? [evidenceFor(context, candidate.projectConfig, "workspace", "Static workspace project boundary")]
      : []),
  ]);
  for (const item of source.sourceEvidence) {
    evidence.push({
      kind: "source",
      path: item.path,
      detail: "Inspected for routes and server/client directives",
      ...(item.hash === undefined ? {} : { contentHash: item.hash }),
    });
  }

  const sourceRoots = nearestExistingRoots(context, candidate.root, ["src", "app", "pages"]);
  if (candidate.sourceRoot && context.hasDirectory(candidate.sourceRoot)) sourceRoots.push(candidate.sourceRoot);
  const testRoots = nearestExistingRoots(context, candidate.root, ["test", "tests", "__tests__", "e2e"]);
  const state = dependenciesMatching(dependencies, [
    "@reduxjs/toolkit",
    "redux",
    "zustand",
    "mobx",
    "recoil",
    "jotai",
  ]);
  const data = dependenciesMatching(dependencies, [
    "@tanstack/react-query",
    "swr",
    "@apollo/client",
    "urql",
  ]);
  const forms = dependenciesMatching(dependencies, ["react-hook-form", "formik"]);
  const ui = dependenciesMatching(dependencies, [
    "@mui/material",
    "antd",
    "@chakra-ui/react",
    "@mantine/core",
    "@radix-ui/react-dialog",
  ]);
  const styling = dependenciesMatching(dependencies, [
    "tailwindcss",
    "styled-components",
    "@emotion/react",
    "sass",
  ]);
  const tests = dependenciesMatching(dependencies, [
    "vitest",
    "jest",
    "@playwright/test",
    "cypress",
    "@testing-library/react",
  ]);
  const apiClients = dependenciesMatching(dependencies, ["axios", "graphql-request", "@apollo/client"]);
  const router = dependenciesMatching(dependencies, ["next", "react-router", "react-router-dom"]);
  const workspaceSystem = context.hasFile("nx.json")
    ? "nx"
    : context.hasFile("turbo.json")
      ? "turborepo"
      : "package-workspaces";
  const environmentPrefix = hostVariant.startsWith("vite")
    ? "VITE_"
    : hostVariant.startsWith("next")
      ? "NEXT_PUBLIC_"
      : hostVariant === "cra"
        ? "REACT_APP_"
        : "unknown";

  return finalizeWorkspace({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    id: `react:${candidate.root}${candidate.projectName ? `:${candidate.projectName}` : ""}`,
    relativeRoot: candidate.root,
    ecosystem: "react",
    variant,
    support: supportFor("react", variant, supportDependency?.resolvedVersion),
    ownership: {
      root: owner.root,
      ...(owner.name ? { owner: owner.name } : {}),
      members: sortedUnique(members),
    },
    framework: {
      name: primary?.name === "next" ? "Next.js/React" : "React",
      ...(primary?.declaredVersion ? { declaredVersion: primary.declaredVersion } : {}),
      ...(primary?.resolvedVersion ? { resolvedVersion: primary.resolvedVersion } : {}),
      ...(primary?.source ? { versionSource: primary.source } : {}),
      dependencies: dependencyVersions,
    },
    packageManager: { name: manager, ...(lockfiles[0] ? { lockfile: lockfiles[0] } : {}) },
    runtime: {
      node: typeof candidate.manifest.data.engines === "object"
        ? String(asObject(candidate.manifest.data.engines)?.node ?? "unspecified")
        : "unspecified",
      typescript: dependencies.typescript ?? "not-declared",
    },
    manifests: manifestsForProfile,
    lockfiles,
    sourceRoots,
    testRoots,
    generatedRoots: nearestExistingRoots(context, candidate.root, ["dist", "build", ".next", "generated"]),
    migrationRoots: nearestExistingRoots(context, candidate.root, ["migrations", "prisma/migrations"]),
    protectedRoots: sortedUnique([".git", "node_modules", joinProjectPath(candidate.root, ".env")]),
    moduleAliases: aliases,
    workspaceDependencies,
    publicExports: publicExports(candidate.manifest.data),
    entryPoints,
    routes: source.routes,
    signals: {
      hostVariant,
      workspaceSystem,
      router,
      stateLibraries: state,
      dataLibraries: data,
      formLibraries: forms,
      uiLibraries: ui,
      stylingLibraries: styling,
      apiClients,
      testLibraries: tests,
      environmentExposurePrefix: environmentPrefix,
      clientBoundaryFiles: source.clientFiles,
      serverBoundaryFiles: source.serverFiles,
      staticRouterPaths: source.routerPaths,
    },
    validationPlan: validationFromScripts(candidate.manifest, candidate.manifest.root, manager),
    manualAcceptance: [
      "Visually verify changed UI states and responsive behavior unless existing browser/component tests cover them.",
      "Verify no new router, state, form, data, styling, or component system was introduced without contract permission.",
    ],
    diagnostics,
    evidence,
  });
}

function decoratorArray(source: string, field: string): string[] {
  const match = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, "s").exec(source);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z_$][\w$]*(?:\.(?:forRoot|forRootAsync)\([^)]*\))?$/.test(value));
}

async function analyzeNestSource(
  context: AnalyzerContext,
  root: string,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{
  moduleGraph: Record<string, ProfileSignalValue>;
  routes: string[];
  globals: string[];
  injectionTokens: string[];
  dynamicModules: string[];
  authSignals: string[];
  tenancySignals: string[];
  evidence: Array<{ path: string; hash?: string }>;
}> {
  const files = context
    .filesBelow(root)
    .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));
  if (files.length > MAX_SOURCE_FILES) {
    diagnostics.push({
      code: "SOURCE_ANALYSIS_LIMIT",
      message: `The workspace has ${files.length} source files; Nest graph analysis is capped at ${MAX_SOURCE_FILES}.`,
      severity: "partial-scan",
      paths: [root],
    });
  }
  const moduleGraph: Record<string, ProfileSignalValue> = {};
  const routes: string[] = [];
  const globals: string[] = [];
  const injectionTokens: string[] = [];
  const dynamicModules: string[] = [];
  const authSignals: string[] = [];
  const tenancySignals: string[] = [];
  const evidence: Array<{ path: string; hash?: string }> = [];
  for (const file of files.slice(0, MAX_SOURCE_FILES)) {
    const source = await context.readText(file, 512 * 1024);
    if (source === undefined) continue;
    evidence.push({ path: file, hash: await context.contentHash(file) });
    if (/\.module\.[cm]?[jt]s$/.test(file) && /@Module\s*\(/.test(source)) {
      const imports = decoratorArray(source, "imports");
      const providers = decoratorArray(source, "providers");
      const controllers = decoratorArray(source, "controllers");
      const exported = decoratorArray(source, "exports");
      moduleGraph[file] = { imports, providers, controllers, exports: exported };
      dynamicModules.push(...imports.filter((value) => /\.(?:forRoot|forRootAsync)\(/.test(value)));
    }
    const controller = /@Controller\s*\(\s*(?:["']([^"']*)["']|\{[^}]*path\s*:\s*["']([^"']+)["'][^}]*\})?/.exec(source);
    if (controller) {
      const base = controller[1] ?? controller[2] ?? "";
      for (const method of source.matchAll(/@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:["']([^"']*)["'])?/g)) {
        const suffix = method[2] ?? "";
        routes.push(`/${[base, suffix].filter(Boolean).join("/")}`.replace(/\/{2,}/g, "/"));
      }
    }
    for (const match of source.matchAll(/@Inject\s*\(\s*([^\n,)]+)/g)) {
      if (match[1]) injectionTokens.push(match[1].trim());
    }
    for (const global of [
      "useGlobalGuards",
      "useGlobalPipes",
      "useGlobalFilters",
      "useGlobalInterceptors",
      "setGlobalPrefix",
      "enableVersioning",
    ]) {
      if (source.includes(`.${global}(`)) globals.push(global);
    }
    if (/@(?:UseGuards|Public|Roles|Permissions)\b|isPublic|AuthGuard/.test(source)) authSignals.push(file);
    if (/\b(?:tenant|organisation|organization|ownerId|accountId)\b/i.test(source)) tenancySignals.push(file);
  }
  return {
    moduleGraph,
    routes: sortedUnique(routes),
    globals: sortedUnique(globals),
    injectionTokens: sortedUnique(injectionTokens),
    dynamicModules: sortedUnique(dynamicModules),
    authSignals: sortedUnique(authSignals),
    tenancySignals: sortedUnique(tenancySignals),
    evidence,
  };
}

async function analyzeNest(
  context: AnalyzerContext,
  candidate: NodeCandidate,
  manifests: NodeManifest[],
): Promise<WorkspaceProfileV1> {
  const diagnostics: AnalyzerDiagnostic[] = [];
  const lockfiles = nearestLockfiles(context, candidate.root);
  const managers = sortedUnique(lockfiles.map(packageManagerFromLock));
  if (managers.length > 1) {
    diagnostics.push({
      code: "CONFLICTING_NODE_LOCKFILES",
      message: "Multiple package-manager lockfiles own this workspace.",
      severity: "needs-input",
      paths: lockfiles,
    });
  }
  const declaredManager = declaredPackageManager(candidate.manifest);
  if (declaredManager && managers[0] && declaredManager !== managers[0]) {
    diagnostics.push({
      code: "PACKAGE_MANAGER_MISMATCH",
      message: `package.json declares ${declaredManager}, but the owning lockfile belongs to ${managers[0]}.`,
      severity: "needs-input",
      paths: [candidate.manifest.path, ...lockfiles],
    });
  }
  const manager = (managers[0] ?? declaredManager ?? "npm") as "npm" | "pnpm" | "yarn" | "bun";
  const dependencyNames = [
    "@nestjs/core",
    "@nestjs/common",
    "@nestjs/platform-express",
    "@nestjs/platform-fastify",
    "@nestjs/typeorm",
    "typeorm",
    "@prisma/client",
    "prisma",
    "@nestjs/mongoose",
    "mongoose",
    "@mikro-orm/core",
    "sequelize",
    "@nestjs/sequelize",
  ];
  const dependencyVersions = (
    await Promise.all(
      dependencyNames.map((name) => dependencyEvidence(context, candidate.manifest, lockfiles, name)),
    )
  ).filter((value): value is DependencyVersionEvidence => value !== undefined);
  const primary = dependencyVersions.find((dependency) => dependency.name === "@nestjs/core");
  if (primary && !primary.resolvedVersion) {
    diagnostics.push({
      code: "UNRESOLVED_FRAMEWORK_VERSION",
      message: "@nestjs/core has no exact version in a statically readable lockfile.",
      severity: "needs-input",
      paths: [candidate.manifest.path, ...lockfiles],
    });
  }
  const express = candidate.manifest.dependencies["@nestjs/platform-express"] !== undefined;
  const fastify = candidate.manifest.dependencies["@nestjs/platform-fastify"] !== undefined;
  if (express && fastify) {
    diagnostics.push({
      code: "CONFLICTING_HTTP_ADAPTERS",
      message: "Both Nest Express and Fastify adapters are declared; the active bootstrap adapter must be explicit.",
      severity: "needs-input",
      paths: [candidate.manifest.path],
    });
  }
  const source = await analyzeNestSource(context, candidate.root, diagnostics);
  const { aliases, configs } = await readTsAliases(context, candidate.root, diagnostics);
  const dependencies = candidate.manifest.dependencies;
  const orms = [
    dependencies.typeorm || dependencies["@nestjs/typeorm"] ? "typeorm" : undefined,
    dependencies["@prisma/client"] || dependencies.prisma ? "prisma" : undefined,
    dependencies.mongoose || dependencies["@nestjs/mongoose"] ? "mongoose" : undefined,
    dependencies["@mikro-orm/core"] ? "mikroorm" : undefined,
    dependencies.sequelize || dependencies["@nestjs/sequelize"] ? "sequelize" : undefined,
  ].filter((value): value is string => value !== undefined);
  const variant = candidate.forcedVariant ?? "standard";
  const owner = workspaceOwner(candidate.manifest, manifests);
  const sourceRoots = nearestExistingRoots(context, candidate.root, ["src"]);
  if (candidate.sourceRoot && context.hasDirectory(candidate.sourceRoot)) sourceRoots.push(candidate.sourceRoot);
  const entryPoints = context.inventory.files.filter(
    (path) => isBelow(path, candidate.root) && /(?:^|\/)main\.[cm]?[jt]s$/.test(path),
  );
  const evidence = await Promise.all([
    evidenceFor(context, candidate.manifest.path, "manifest", "NestJS package manifest"),
    ...(owner.path !== candidate.manifest.path
      ? [evidenceFor(context, owner.path, "workspace", "Owning Node workspace manifest")]
      : []),
    ...(context.hasFile(joinProjectPath(owner.root, "pnpm-workspace.yaml"))
      ? [evidenceFor(context, joinProjectPath(owner.root, "pnpm-workspace.yaml"), "workspace", "pnpm workspace ownership")]
      : []),
    ...lockfiles.map((path) => evidenceFor(context, path, "lockfile", "Owning dependency lockfile")),
    ...configs.map((path) => evidenceFor(context, path, "config", "Static TypeScript alias configuration")),
    ...(candidate.projectConfig
      ? [evidenceFor(context, candidate.projectConfig, "workspace", "Static Nest/Nx project boundary")]
      : []),
  ]);
  for (const item of source.evidence) {
    evidence.push({
      kind: "source",
      path: item.path,
      detail: "Inspected for Nest modules, DI, routes, guards, and bootstrap globals",
      ...(item.hash === undefined ? {} : { contentHash: item.hash }),
    });
  }
  return finalizeWorkspace({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    id: `nestjs:${candidate.root}${candidate.projectName ? `:${candidate.projectName}` : ""}`,
    relativeRoot: candidate.root,
    ecosystem: "nestjs",
    variant,
    support: supportFor("nestjs", variant, primary?.resolvedVersion),
    ownership: {
      root: owner.root,
      ...(owner.name ? { owner: owner.name } : {}),
      members: membersOf(owner, manifests),
    },
    framework: {
      name: "NestJS",
      ...(primary?.declaredVersion ? { declaredVersion: primary.declaredVersion } : {}),
      ...(primary?.resolvedVersion ? { resolvedVersion: primary.resolvedVersion } : {}),
      ...(primary?.source ? { versionSource: primary.source } : {}),
      dependencies: dependencyVersions,
    },
    packageManager: { name: manager, ...(lockfiles[0] ? { lockfile: lockfiles[0] } : {}) },
    runtime: {
      node: typeof candidate.manifest.data.engines === "object"
        ? String(asObject(candidate.manifest.data.engines)?.node ?? "unspecified")
        : "unspecified",
      typescript: dependencies.typescript ?? "not-declared",
    },
    manifests: sortedUnique([
      candidate.manifest.path,
      owner.path,
      ...(context.hasFile(joinProjectPath(owner.root, "pnpm-workspace.yaml"))
        ? [joinProjectPath(owner.root, "pnpm-workspace.yaml")]
        : []),
      ...(candidate.projectConfig ? [candidate.projectConfig] : []),
      ...configs,
    ]),
    lockfiles,
    sourceRoots,
    testRoots: nearestExistingRoots(context, candidate.root, ["test", "tests", "e2e"]),
    generatedRoots: nearestExistingRoots(context, candidate.root, ["dist", "generated"]),
    migrationRoots: nearestExistingRoots(context, candidate.root, ["migrations", "prisma/migrations"]),
    protectedRoots: sortedUnique([".git", "node_modules", joinProjectPath(candidate.root, ".env")]),
    moduleAliases: aliases,
    workspaceDependencies: Object.entries(dependencies)
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name),
    publicExports: publicExports(candidate.manifest.data),
    entryPoints,
    routes: source.routes,
    signals: {
      projectName: candidate.projectName ?? candidate.manifest.name ?? "unknown",
      httpAdapter: fastify ? (express ? "ambiguous" : "fastify") : "express",
      orms,
      moduleGraph: source.moduleGraph,
      dynamicModules: source.dynamicModules,
      injectionTokens: source.injectionTokens,
      bootstrapGlobals: source.globals,
      authFiles: source.authSignals,
      tenancyFiles: source.tenancySignals,
      validationLibrary: dependencies["class-validator"] ? "class-validator" : "not-declared",
    },
    validationPlan: validationFromScripts(candidate.manifest, candidate.manifest.root, manager),
    manualAcceptance: [
      "For protected endpoints, verify unauthenticated, unauthorized, authorized, and foreign-owner/tenant behavior.",
      "Schema changes require an explicitly reviewed migration; never enable ORM synchronization as a shortcut.",
    ],
    diagnostics,
    evidence,
  });
}

/** Static Node adapter covering both React and NestJS project profiles. */
export class NodeEcosystemAdapter implements EcosystemAdapter {
  // The interface has a single ecosystem discriminator, while this shared
  // adapter statically emits two closely related Node ecosystem profiles.
  readonly ecosystem = "react" as const;

  async analyze(context: AnalyzerContext): Promise<WorkspaceProfileV1[]> {
    const { candidates, manifests } = await loadNodeCandidates(context);
    const profiles: WorkspaceProfileV1[] = [];
    for (const candidate of candidates.sort((left, right) =>
      `${left.root}\u0000${left.ecosystem}\u0000${left.projectName ?? ""}`.localeCompare(
        `${right.root}\u0000${right.ecosystem}\u0000${right.projectName ?? ""}`,
      ),
    )) {
      profiles.push(
        candidate.ecosystem === "react"
          ? await analyzeReact(context, candidate, manifests)
          : await analyzeNest(context, candidate, manifests),
      );
    }
    return profiles;
  }
}

export const nodeEcosystemAdapter = new NodeEcosystemAdapter();
