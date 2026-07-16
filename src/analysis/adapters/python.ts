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
  isBelow,
  joinProjectPath,
  nearestExistingRoots,
  normalizeProjectPath,
  parseSimpleToml,
  projectBasename,
  projectDirname,
  relativeToWorkspace,
  sortedUnique,
  tomlArray,
  tomlSection,
  tomlString,
} from "../analyzer-utils.ts";
import { supportFor } from "../support-matrix.ts";

const PYTHON_METADATA_NAMES = new Set([
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "environment.yml",
  "environment.yaml",
  "setup.py",
  "setup.cfg",
]);
const MAX_SOURCE_FILES = 2_000;

interface PythonCandidate {
  root: string;
  manifests: string[];
  sourceFiles: string[];
}

type PythonManager = "uv" | "poetry" | "pdm" | "pipenv" | "pip" | "conda" | "unknown";

function isRequirements(path: string): boolean {
  return /^requirements(?:[-.][^/]*)?\.txt$/i.test(projectBasename(path));
}

function metadataFiles(context: AnalyzerContext): string[] {
  return context.inventory.files.filter(
    (path) => PYTHON_METADATA_NAMES.has(projectBasename(path)) || isRequirements(path),
  );
}

async function candidateContainsFastApi(
  context: AnalyzerContext,
  manifests: string[],
  sourceFiles: string[],
): Promise<boolean> {
  for (const path of manifests) {
    const text = await context.readText(path, 4 * 1024 * 1024);
    if (text && /(?:^|[^A-Za-z0-9_-])fastapi(?:[^A-Za-z0-9_-]|$)/i.test(text)) return true;
  }
  for (const path of sourceFiles.slice(0, MAX_SOURCE_FILES)) {
    const text = await context.readText(path, 512 * 1024);
    if (text && /(?:from\s+fastapi\s+import|import\s+fastapi\b)/.test(text)) return true;
  }
  return false;
}

async function loadPythonCandidates(context: AnalyzerContext): Promise<PythonCandidate[]> {
  const metadata = metadataFiles(context);
  const roots = sortedUnique(metadata.map(projectDirname));
  const pythonFiles = context.inventory.files.filter((path) => path.endsWith(".py"));
  const candidates: PythonCandidate[] = [];

  for (const root of roots) {
    // A nested declared Python project owns its files; an outer project should
    // not absorb that project merely because it is below the repository root.
    const nestedRoots = roots.filter((candidate) => candidate !== root && isBelow(candidate, root));
    const sourceFiles = pythonFiles.filter(
      (path) => isBelow(path, root) && !nestedRoots.some((nested) => isBelow(path, nested)),
    );
    const manifests = metadata.filter((path) => projectDirname(path) === root);
    if (await candidateContainsFastApi(context, manifests, sourceFiles)) {
      candidates.push({ root, manifests, sourceFiles });
    }
  }

  // Manifest-less FastAPI applications are recognized, but explicitly marked
  // incomplete later because versions and environment ownership are unknown.
  const owned = new Set(candidates.flatMap((candidate) => candidate.sourceFiles));
  const unowned = pythonFiles.filter((path) => !owned.has(path));
  if (unowned.length > 0 && (await candidateContainsFastApi(context, [], unowned))) {
    candidates.push({ root: ".", manifests: [], sourceFiles: unowned });
  }

  const deduplicated = new Map<string, PythonCandidate>();
  for (const candidate of candidates) deduplicated.set(candidate.root, candidate);
  return [...deduplicated.values()].sort((left, right) => left.root.localeCompare(right.root));
}

function parseRequirement(value: string): { name: string; spec?: string } | undefined {
  const trimmed = value.trim().replace(/^['"]|['"],?$/g, "");
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-") || trimmed.includes(" @ ")) {
    return undefined;
  }
  const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/.exec(trimmed);
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase().replace(/_/g, "-"), ...(match[2] ? { spec: match[2] } : {}) };
}

async function collectDeclaredDependencies(
  context: AnalyzerContext,
  candidate: PythonCandidate,
): Promise<Map<string, { spec?: string; source: string }>> {
  const dependencies = new Map<string, { spec?: string; source: string }>();
  const add = (raw: string, source: string): void => {
    const parsed = parseRequirement(raw);
    if (!parsed) return;
    dependencies.set(parsed.name, { ...(parsed.spec ? { spec: parsed.spec } : {}), source });
  };
  for (const path of candidate.manifests) {
    const text = await context.readText(path, 4 * 1024 * 1024);
    if (!text) continue;
    const basename = projectBasename(path);
    if (basename === "pyproject.toml" || basename === "Pipfile") {
      const document = parseSimpleToml(text);
      for (const value of tomlArray(tomlSection(document, "project").get("dependencies"))) add(value, path);
      for (const sectionName of [
        "project.optional-dependencies",
        "tool.poetry.dependencies",
        "tool.poetry.group.dev.dependencies",
        "packages",
        "dev-packages",
      ]) {
        const section = tomlSection(document, sectionName);
        for (const [name, raw] of section) {
          const normalized = name.toLowerCase().replace(/_/g, "-");
          if (normalized === "python") continue;
          const stringValue = tomlString(raw) ?? raw.replace(/^['"]|['"]$/g, "");
          dependencies.set(normalized, { spec: stringValue, source: path });
        }
      }
    } else if (isRequirements(path)) {
      for (const line of text.split(/\r?\n/)) add(line, path);
    } else if (basename === "environment.yml" || basename === "environment.yaml") {
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*-\s*([A-Za-z0-9_.-]+)([=<>!~].*)?$/.exec(line);
        if (match?.[1]) add(`${match[1]}${match[2] ?? ""}`, path);
      }
    } else if (basename === "setup.py" || basename === "setup.cfg") {
      for (const match of text.matchAll(/["'](fastapi|pydantic|starlette|sqlalchemy|sqlmodel|pytest|ruff|mypy)([^"']*)["']/gi)) {
        add(`${match[1] ?? ""}${match[2] ?? ""}`, path);
      }
    }
  }
  return dependencies;
}

async function resolvedPythonVersions(
  context: AnalyzerContext,
  candidate: PythonCandidate,
): Promise<Map<string, { version: string; source: string }>> {
  const result = new Map<string, { version: string; source: string }>();
  for (const path of candidate.manifests) {
    const basename = projectBasename(path);
    if (!["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"].includes(basename)) continue;
    const text = await context.readText(path, 8 * 1024 * 1024);
    if (!text) continue;
    if (basename === "Pipfile.lock") {
      try {
        const root = asObject(JSON.parse(text));
        for (const groupName of ["default", "develop"]) {
          const group = asObject(root?.[groupName]);
          if (!group) continue;
          for (const [name, raw] of Object.entries(group)) {
            const record = asObject(raw);
            if (typeof record?.version === "string") {
              result.set(name.toLowerCase().replace(/_/g, "-"), {
                version: record.version.replace(/^==/, ""),
                source: path,
              });
            }
          }
        }
      } catch {
        context.addDiagnostic({
          code: "INVALID_PYTHON_LOCKFILE",
          message: "Pipfile.lock is invalid JSON, so dependency versions are unresolved.",
          severity: "partial-scan",
          paths: [path],
        });
      }
      continue;
    }
    const document = parseSimpleToml(text);
    for (const record of document.sections.get("package") ?? []) {
      const name = tomlString(record.get("name"));
      const version = tomlString(record.get("version"));
      if (name && version) {
        result.set(name.toLowerCase().replace(/_/g, "-"), { version, source: path });
      }
    }
  }
  return result;
}

function exactPythonVersion(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const match = /^(?:==|===)?\s*(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/.exec(spec.trim());
  return match?.[1];
}

function dependencyVersion(
  name: string,
  declared: Map<string, { spec?: string; source: string }>,
  resolved: Map<string, { version: string; source: string }>,
): DependencyVersionEvidence | undefined {
  const declaration = declared.get(name);
  const resolution = resolved.get(name);
  if (!declaration && !resolution) return undefined;
  const exact = resolution?.version ?? exactPythonVersion(declaration?.spec);
  return {
    name,
    ...(declaration?.spec ? { declaredVersion: declaration.spec } : {}),
    ...(exact ? { resolvedVersion: exact } : {}),
    source: resolution?.source ?? declaration?.source,
  };
}

async function managerFor(
  context: AnalyzerContext,
  candidate: PythonCandidate,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{ manager: PythonManager; lockfile?: string; managers: PythonManager[] }> {
  const basenames = new Set(candidate.manifests.map(projectBasename));
  const managers: PythonManager[] = [];
  const pyproject = candidate.manifests.find((path) => projectBasename(path) === "pyproject.toml");
  const pyprojectText = pyproject ? await context.readText(pyproject) : undefined;
  if (basenames.has("uv.lock") || pyprojectText?.includes("[tool.uv")) managers.push("uv");
  if (basenames.has("poetry.lock") || pyprojectText?.includes("[tool.poetry")) managers.push("poetry");
  if (basenames.has("pdm.lock") || pyprojectText?.includes("[tool.pdm")) managers.push("pdm");
  if (basenames.has("Pipfile") || basenames.has("Pipfile.lock")) managers.push("pipenv");
  if (basenames.has("environment.yml") || basenames.has("environment.yaml")) managers.push("conda");
  if (candidate.manifests.some(isRequirements)) managers.push("pip");
  const ownershipManagers = sortedUnique(
    managers.filter((manager) => manager !== "pip"),
  ) as PythonManager[];
  if (ownershipManagers.length > 1) {
    diagnostics.push({
      code: "CONFLICTING_PYTHON_ENVIRONMENTS",
      message: `Multiple Python environment owners were detected: ${ownershipManagers.join(", ")}.`,
      severity: "needs-input",
      paths: candidate.manifests,
    });
  }
  const manager = ownershipManagers[0] ?? managers[0] ?? "unknown";
  const lockNames: Record<PythonManager, string[]> = {
    uv: ["uv.lock"],
    poetry: ["poetry.lock"],
    pdm: ["pdm.lock"],
    pipenv: ["Pipfile.lock"],
    pip: [],
    conda: ["environment.yml", "environment.yaml"],
    unknown: [],
  };
  const lockfile = candidate.manifests.find((path) => lockNames[manager].includes(projectBasename(path)));
  return { manager, ...(lockfile ? { lockfile } : {}), managers: sortedUnique(managers) as PythonManager[] };
}

function pythonArgv(manager: PythonManager, module: string, args: string[]): string[] {
  const python = ["python", "-m", module, ...args];
  if (manager === "uv") return ["uv", "run", ...python];
  if (manager === "poetry") return ["poetry", "run", ...python];
  if (manager === "pdm") return ["pdm", "run", ...python];
  if (manager === "pipenv") return ["pipenv", "run", ...python];
  return python;
}

function pythonValidationCommand(
  candidate: PythonCandidate,
  manager: PythonManager,
  module: string,
  args: string[],
  category: ValidationCategory,
  sourcePath: string,
  required: boolean,
  suffix: string,
): ValidationCommandV1 {
  return {
    id: `python:${candidate.root}:${category}:${suffix}`,
    category,
    cwd: candidate.root,
    argv: pythonArgv(manager, module, args),
    source: module === "compileall" ? "language-toolchain" : "declared-tool",
    sourcePath,
    required,
    network: false,
    timeoutMs:
      category === "format"
        ? 120_000
        : category === "test" || category === "integration"
          ? 600_000
          : 300_000,
    risk: "executes-project-code",
  };
}

function validationPlan(
  candidate: PythonCandidate,
  manager: PythonManager,
  dependencies: Map<string, { spec?: string; source: string }>,
  toolsText: string,
  sourceRoots: string[],
): ValidationCommandV1[] {
  const sourcePath =
    candidate.manifests.find((path) => projectBasename(path) === "pyproject.toml") ??
    candidate.manifests[0] ??
    "python-toolchain";
  const roots = sourceRoots.length > 0
    ? sourceRoots.map((root) => relativeToWorkspace(candidate.root, root))
    : ["."];
  const plan: ValidationCommandV1[] = [
    pythonValidationCommand(
      candidate,
      manager,
      "compileall",
      ["-q", ...roots],
      "typecheck",
      sourcePath,
      true,
      "compileall",
    ),
  ];
  if (dependencies.has("ruff") || toolsText.includes("[tool.ruff")) {
    plan.push(
      pythonValidationCommand(candidate, manager, "ruff", ["format", "--check", "."], "format", sourcePath, true, "ruff-format"),
      pythonValidationCommand(candidate, manager, "ruff", ["check", "."], "lint", sourcePath, true, "ruff-check"),
    );
  }
  if (dependencies.has("mypy") || toolsText.includes("[tool.mypy")) {
    plan.push(
      pythonValidationCommand(candidate, manager, "mypy", roots, "typecheck", sourcePath, true, "mypy"),
    );
  }
  if (
    dependencies.has("pytest") ||
    toolsText.includes("[tool.pytest") ||
    candidate.sourceFiles.some((path) => /(?:^|\/)tests?\//.test(path))
  ) {
    plan.push(
      pythonValidationCommand(candidate, manager, "pytest", [], "test", sourcePath, true, "pytest"),
    );
  }
  return plan;
}

async function analyzePythonSource(
  context: AnalyzerContext,
  candidate: PythonCandidate,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{
  routes: string[];
  routerFiles: string[];
  dependencies: string[];
  appFactories: string[];
  entryPoints: string[];
  asyncRoutes: number;
  syncRoutes: number;
  authFiles: string[];
  tenancyFiles: string[];
  settingsFiles: string[];
  transactionFiles: string[];
  exceptionFiles: string[];
  namespacePackages: string[];
  evidence: Array<{ path: string; hash?: string }>;
}> {
  if (candidate.sourceFiles.length > MAX_SOURCE_FILES) {
    diagnostics.push({
      code: "SOURCE_ANALYSIS_LIMIT",
      message: `The workspace has ${candidate.sourceFiles.length} Python files; source analysis is capped at ${MAX_SOURCE_FILES}.`,
      severity: "partial-scan",
      paths: [candidate.root],
    });
  }
  const routes: string[] = [];
  const routerFiles: string[] = [];
  const dependencies: string[] = [];
  const appFactories: string[] = [];
  const entryPoints: string[] = [];
  const authFiles: string[] = [];
  const tenancyFiles: string[] = [];
  const settingsFiles: string[] = [];
  const transactionFiles: string[] = [];
  const exceptionFiles: string[] = [];
  const evidence: Array<{ path: string; hash?: string }> = [];
  let asyncRoutes = 0;
  let syncRoutes = 0;
  for (const path of candidate.sourceFiles.slice(0, MAX_SOURCE_FILES)) {
    const text = await context.readText(path, 512 * 1024);
    if (text === undefined) continue;
    evidence.push({ path, hash: await context.contentHash(path) });
    const prefix = /APIRouter\s*\([^)]*\bprefix\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? "";
    for (const match of text.matchAll(/@(\w+)\.(get|post|put|patch|delete|options|head|api_route)\s*\(\s*["']([^"']*)["']/g)) {
      const route = match[3] ?? "";
      routes.push(`${prefix}${route}` || "/");
      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 500);
      if (/^\s*\)?[^\n]*\n?\s*async\s+def\s+/.test(after)) asyncRoutes++;
      else if (/^\s*\)?[^\n]*\n?\s*def\s+/.test(after)) syncRoutes++;
    }
    if (/\b(?:APIRouter|include_router)\s*\(/.test(text)) routerFiles.push(path);
    for (const match of text.matchAll(/\bDepends\s*\(\s*([A-Za-z_$][\w.$]*)/g)) {
      if (match[1]) dependencies.push(match[1]);
    }
    if (/\bdef\s+(?:create_app|build_app|make_app)\s*\(/.test(text)) appFactories.push(path);
    if (/\bFastAPI\s*\(/.test(text) || /(?:^|\/)(?:main|app|asgi)\.py$/.test(path)) entryPoints.push(path);
    if (/\b(?:OAuth2|JWT|HTTPBearer|Security\s*\(|current_user|require_user)\b/.test(text)) authFiles.push(path);
    if (/\b(?:tenant|organisation|organization|owner_id|account_id)\b/i.test(text)) tenancyFiles.push(path);
    if (/\b(?:BaseSettings|pydantic_settings)\b/.test(text)) settingsFiles.push(path);
    if (/\b(?:session\.(?:begin|commit|rollback)|get_db|AsyncSession|Session)\b/.test(text)) transactionFiles.push(path);
    if (/\b(?:exception_handler|HTTPException|RequestValidationError)\b/.test(text)) exceptionFiles.push(path);
  }
  const sourceDirectories = sortedUnique(candidate.sourceFiles.map(projectDirname)).filter(
    (directory) => directory !== candidate.root && directory !== ".",
  );
  const namespacePackages = sourceDirectories.filter(
    (directory) => !context.hasFile(joinProjectPath(directory, "__init__.py")),
  );
  return {
    routes: sortedUnique(routes),
    routerFiles: sortedUnique(routerFiles),
    dependencies: sortedUnique(dependencies),
    appFactories: sortedUnique(appFactories),
    entryPoints: sortedUnique(entryPoints),
    asyncRoutes,
    syncRoutes,
    authFiles: sortedUnique(authFiles),
    tenancyFiles: sortedUnique(tenancyFiles),
    settingsFiles: sortedUnique(settingsFiles),
    transactionFiles: sortedUnique(transactionFiles),
    exceptionFiles: sortedUnique(exceptionFiles),
    namespacePackages,
    evidence,
  };
}

function dependencyNamesMatching(
  dependencies: Map<string, { spec?: string; source: string }>,
  names: readonly string[],
): string[] {
  return names.filter((name) => dependencies.has(name));
}

function sourceRootsFor(context: AnalyzerContext, candidate: PythonCandidate): string[] {
  const explicit = nearestExistingRoots(context, candidate.root, ["src", "app"]);
  if (explicit.length > 0) return explicit;
  const topLevel = sortedUnique(
    candidate.sourceFiles.map((path) => {
      const relative = relativeToWorkspace(candidate.root, path);
      const segment = relative.split("/")[0] ?? ".";
      return segment.endsWith(".py") ? candidate.root : joinProjectPath(candidate.root, segment);
    }),
  );
  return topLevel.filter((path) => context.hasDirectory(path));
}

async function analyzeFastApi(
  context: AnalyzerContext,
  candidate: PythonCandidate,
): Promise<WorkspaceProfileV1> {
  const diagnostics: AnalyzerDiagnostic[] = [];
  const { manager, lockfile, managers } = await managerFor(context, candidate, diagnostics);
  const declared = await collectDeclaredDependencies(context, candidate);
  const resolved = await resolvedPythonVersions(context, candidate);
  const dependencyVersions = ["fastapi", "starlette", "pydantic", "pydantic-settings", "sqlalchemy", "sqlmodel"]
    .map((name) => dependencyVersion(name, declared, resolved))
    .filter((value): value is DependencyVersionEvidence => value !== undefined);
  const fastapi = dependencyVersions.find((dependency) => dependency.name === "fastapi");
  if (!fastapi?.resolvedVersion) {
    diagnostics.push({
      code: "UNRESOLVED_FRAMEWORK_VERSION",
      message: "FastAPI has no exact version in a statically readable lockfile or exact requirement.",
      severity: "needs-input",
      paths: candidate.manifests.length > 0 ? candidate.manifests : [candidate.root],
    });
  }
  if (candidate.manifests.length === 0) {
    diagnostics.push({
      code: "MISSING_PYTHON_MANIFEST",
      message: "FastAPI imports were found without a declared Python environment or dependency manifest.",
      severity: "needs-input",
      paths: [candidate.root],
    });
  }
  const setupPath = candidate.manifests.find((path) => projectBasename(path) === "setup.py");
  const pyproject = candidate.manifests.find((path) => projectBasename(path) === "pyproject.toml");
  if (setupPath && !pyproject) {
    diagnostics.push({
      code: "DYNAMIC_SETUP_METADATA",
      message: "setup.py is executable metadata and cannot be trusted as a complete static environment description.",
      severity: "needs-input",
      paths: [setupPath],
    });
  }

  const source = await analyzePythonSource(context, candidate, diagnostics);
  const sourceRoots = sourceRootsFor(context, candidate);
  const toolsText = (
    await Promise.all(candidate.manifests.map((path) => context.readText(path, 4 * 1024 * 1024)))
  )
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const pythonConstraint = (() => {
    if (!pyproject) return "unspecified";
    const text = toolsText;
    const document = parseSimpleToml(text);
    return (
      tomlString(tomlSection(document, "project").get("requires-python")) ??
      tomlString(tomlSection(document, "tool.poetry.dependencies").get("python")) ??
      "unspecified"
    );
  })();
  const pydantic = dependencyVersions.find((dependency) => dependency.name === "pydantic");
  const pydanticVersion = pydantic?.resolvedVersion ?? pydantic?.declaredVersion ?? "unknown";
  const pydanticGeneration = /(?:^|\D)1(?:\.|$)/.test(pydanticVersion)
    ? "1"
    : /(?:^|\D)2(?:\.|$)/.test(pydanticVersion)
      ? "2"
      : "unknown";
  const orms = dependencyNamesMatching(declared, [
    "sqlalchemy",
    "sqlmodel",
    "tortoise-orm",
    "peewee",
    "django",
  ]);
  const databaseDrivers = dependencyNamesMatching(declared, [
    "asyncpg",
    "psycopg",
    "psycopg2",
    "aiosqlite",
    "pymysql",
    "mysqlclient",
  ]);
  const syncModel =
    source.asyncRoutes > 0 && source.syncRoutes > 0
      ? "mixed"
      : source.asyncRoutes > 0
        ? "async"
        : source.syncRoutes > 0
          ? "sync"
          : "undetermined";
  const evidence = await Promise.all([
    ...candidate.manifests.map((path) =>
      evidenceFor(
        context,
        path,
        ["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"].includes(projectBasename(path))
          ? "lockfile"
          : "manifest",
        "Static Python environment and dependency evidence",
      ),
    ),
  ]);
  for (const item of source.evidence) {
    evidence.push({
      kind: "source",
      path: item.path,
      detail: "Inspected for FastAPI routes, dependencies, app factories, and runtime conventions",
      ...(item.hash === undefined ? {} : { contentHash: item.hash }),
    });
  }
  const migrationRoots = nearestExistingRoots(context, candidate.root, ["migrations", "alembic", "versions"]);

  return finalizeWorkspace({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    id: `fastapi:${candidate.root}`,
    relativeRoot: candidate.root,
    ecosystem: "fastapi",
    variant: "fastapi-application",
    support: supportFor("fastapi", "fastapi-application", fastapi?.resolvedVersion),
    ownership: { root: candidate.root, members: [candidate.root] },
    framework: {
      name: "FastAPI",
      ...(fastapi?.declaredVersion ? { declaredVersion: fastapi.declaredVersion } : {}),
      ...(fastapi?.resolvedVersion ? { resolvedVersion: fastapi.resolvedVersion } : {}),
      ...(fastapi?.source ? { versionSource: fastapi.source } : {}),
      dependencies: dependencyVersions,
    },
    packageManager: {
      name: manager,
      ...(lockfile ? { lockfile } : {}),
    },
    runtime: {
      python: pythonConstraint,
      pydanticGeneration,
      concurrencyModel: syncModel,
    },
    manifests: candidate.manifests,
    lockfiles: candidate.manifests.filter((path) =>
      ["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"].includes(projectBasename(path)),
    ),
    sourceRoots,
    testRoots: nearestExistingRoots(context, candidate.root, ["test", "tests"]),
    generatedRoots: nearestExistingRoots(context, candidate.root, ["generated", "build", "dist"]),
    migrationRoots,
    protectedRoots: sortedUnique([".git", ".venv", "venv", joinProjectPath(candidate.root, ".env")]),
    moduleAliases: {},
    workspaceDependencies: [],
    publicExports: [],
    entryPoints: source.entryPoints,
    routes: source.routes,
    signals: {
      environmentManagers: managers,
      routerFiles: source.routerFiles,
      dependencyFunctions: source.dependencies,
      appFactories: source.appFactories,
      asyncRouteCount: source.asyncRoutes,
      syncRouteCount: source.syncRoutes,
      orms,
      databaseDrivers,
      authFiles: source.authFiles,
      tenancyFiles: source.tenancyFiles,
      settingsFiles: source.settingsFiles,
      transactionFiles: source.transactionFiles,
      exceptionFiles: source.exceptionFiles,
      namespacePackages: source.namespacePackages,
    },
    validationPlan: validationPlan(candidate, manager, declared, toolsText, sourceRoots),
    manualAcceptance: [
      "Verify external database, cache, queue, and cloud dependencies only against explicitly configured ephemeral test services.",
      "Preserve the detected Pydantic generation and sync/async ownership unless the reviewed contract explicitly changes them.",
    ],
    diagnostics,
    evidence,
  });
}

export class FastApiEcosystemAdapter implements EcosystemAdapter {
  readonly ecosystem = "fastapi" as const;

  async analyze(context: AnalyzerContext): Promise<WorkspaceProfileV1[]> {
    const candidates = await loadPythonCandidates(context);
    const profiles: WorkspaceProfileV1[] = [];
    for (const candidate of candidates) profiles.push(await analyzeFastApi(context, candidate));
    return profiles;
  }
}

export const fastApiEcosystemAdapter = new FastApiEcosystemAdapter();
