/**
 * Rust ecosystem adapter: static recognition of Cargo crates and workspaces —
 * edition, toolchain, features, targets, `unsafe`/FFI, build scripts, proc
 * macros, and native dependencies — without invoking Cargo.
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
  evidenceFor,
  finalizeWorkspace,
  findAncestorFiles,
  globMatches,
  inlineTableString,
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
  tomlBoolean,
  tomlSection,
  tomlString,
  type SimpleTomlDocument,
} from "../analyzer-utils.ts";
import { supportFor } from "../support-matrix.ts";

const MAX_SOURCE_FILES = 2_000;

interface CargoDependency {
  name: string;
  declaredVersion?: string;
  path?: string;
  workspace: boolean;
  optional: boolean;
  features: string[];
  source: string;
}

interface CargoManifest {
  path: string;
  root: string;
  text: string;
  document: SimpleTomlDocument;
  packageName?: string;
  packageVersion?: string;
  edition?: string;
  rustVersion?: string;
  hasPackage: boolean;
  hasWorkspace: boolean;
  members: string[];
  excludes: string[];
  resolver?: string;
  dependencies: CargoDependency[];
  features: string[];
  procMacro: boolean;
}

interface CargoCandidate {
  root: string;
  manifest: CargoManifest;
  members: CargoManifest[];
  unmatchedMemberPatterns: string[];
}

async function readCargoManifest(
  context: AnalyzerContext,
  path: string,
): Promise<CargoManifest | undefined> {
  const text = await context.readText(path, 4 * 1024 * 1024);
  if (text === undefined) return undefined;
  const document = parseSimpleToml(text);
  const packageSection = tomlSection(document, "package");
  const workspaceSection = tomlSection(document, "workspace");
  const dependencySections = [...document.sections.keys()].filter(
    (name) =>
      name === "dependencies" ||
      name === "dev-dependencies" ||
      name === "build-dependencies" ||
      name === "workspace.dependencies" ||
      /\.dependencies$/.test(name),
  );
  const dependencies: CargoDependency[] = [];
  for (const sectionName of dependencySections) {
    for (const [name, raw] of tomlSection(document, sectionName)) {
      const quotedVersion = tomlString(raw);
      const declaredVersion = quotedVersion ?? inlineTableString(raw, "version");
      dependencies.push({
        name,
        ...(declaredVersion ? { declaredVersion } : {}),
        ...(inlineTableString(raw, "path") ? { path: inlineTableString(raw, "path") } : {}),
        workspace: /\bworkspace\s*=\s*true\b/.test(raw),
        optional: /\boptional\s*=\s*true\b/.test(raw),
        features: tomlArray(/\bfeatures\s*=\s*(\[[\s\S]*?\])/.exec(raw)?.[1]),
        source: path,
      });
    }
  }
  const features = [...tomlSection(document, "features").keys()];
  const hasPackage = document.sections.has("package");
  const hasWorkspace = document.sections.has("workspace");
  if (!hasPackage && !hasWorkspace) {
    context.addDiagnostic({
      code: "INVALID_CARGO_MANIFEST",
      message: "Cargo.toml has neither a [package] nor [workspace] section.",
      severity: "partial-scan",
      paths: [path],
    });
    return undefined;
  }
  return {
    path,
    root: projectDirname(path),
    text,
    document,
    ...(tomlString(packageSection.get("name")) ? { packageName: tomlString(packageSection.get("name")) } : {}),
    ...(tomlString(packageSection.get("version")) ? { packageVersion: tomlString(packageSection.get("version")) } : {}),
    ...(tomlString(packageSection.get("edition")) ? { edition: tomlString(packageSection.get("edition")) } : {}),
    ...(tomlString(packageSection.get("rust-version")) ? { rustVersion: tomlString(packageSection.get("rust-version")) } : {}),
    hasPackage,
    hasWorkspace,
    members: tomlArray(workspaceSection.get("members")),
    excludes: tomlArray(workspaceSection.get("exclude")),
    ...(tomlString(workspaceSection.get("resolver")) ? { resolver: tomlString(workspaceSection.get("resolver")) } : {}),
    dependencies,
    features,
    procMacro: tomlBoolean(tomlSection(document, "lib").get("proc-macro")) === true,
  };
}

function workspacePatternMatches(root: string, pattern: string, memberRoot: string): boolean {
  const relative = relativeToWorkspace(root, memberRoot);
  return globMatches(pattern, relative) || globMatches(joinProjectPath(pattern, "Cargo.toml"), joinProjectPath(relative, "Cargo.toml"));
}

async function loadCargoCandidates(context: AnalyzerContext): Promise<CargoCandidate[]> {
  const manifests = (
    await Promise.all(
      context.inventory.files
        .filter((path) => projectBasename(path) === "Cargo.toml")
        .map((path) => readCargoManifest(context, path)),
    )
  ).filter((manifest): manifest is CargoManifest => manifest !== undefined);
  const candidates: CargoCandidate[] = [];
  const owned = new Set<string>();

  for (const workspace of manifests.filter((manifest) => manifest.hasWorkspace)) {
    const matches = manifests.filter((manifest) => {
      if (manifest === workspace) return workspace.hasPackage;
      if (!isBelow(manifest.root, workspace.root)) return false;
      if (workspace.excludes.some((pattern) => workspacePatternMatches(workspace.root, pattern, manifest.root))) {
        return false;
      }
      return workspace.members.some((pattern) => workspacePatternMatches(workspace.root, pattern, manifest.root));
    });
    const unmatchedMemberPatterns = workspace.members.filter(
      (pattern) => !matches.some((manifest) => workspacePatternMatches(workspace.root, pattern, manifest.root)),
    );
    for (const member of matches) owned.add(member.path);
    owned.add(workspace.path);
    candidates.push({
      root: workspace.root,
      manifest: workspace,
      members: matches,
      unmatchedMemberPatterns,
    });
  }

  for (const manifest of manifests) {
    if (!owned.has(manifest.path)) {
      candidates.push({ root: manifest.root, manifest, members: [manifest], unmatchedMemberPatterns: [] });
    }
  }
  return candidates.sort((left, right) => left.root.localeCompare(right.root));
}

async function cargoLockVersions(
  context: AnalyzerContext,
  lockfile: string | undefined,
): Promise<Map<string, string[]>> {
  const versions = new Map<string, string[]>();
  if (!lockfile) return versions;
  const text = await context.readText(lockfile, 16 * 1024 * 1024);
  if (!text) return versions;
  const document = parseSimpleToml(text);
  const packages = document.sections.get("package");
  if (!packages) {
    context.addDiagnostic({
      code: "INVALID_CARGO_LOCKFILE",
      message: "Cargo.lock has no statically readable package records.",
      severity: "partial-scan",
      paths: [lockfile],
    });
    return versions;
  }
  for (const record of packages) {
    const name = tomlString(record.get("name"));
    const version = tomlString(record.get("version"));
    if (!name || !version) continue;
    versions.set(name, sortedUnique([...(versions.get(name) ?? []), version]));
  }
  return versions;
}

function exactCargoDeclaredVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^=?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value.trim())?.[1];
}

function cargoDependencyEvidence(
  dependencies: CargoDependency[],
  resolutions: Map<string, string[]>,
  lockfile: string | undefined,
): DependencyVersionEvidence[] {
  const result: DependencyVersionEvidence[] = [];
  for (const dependency of dependencies) {
    const resolved = resolutions.get(dependency.name);
    const resolvedVersion = resolved?.length === 1
      ? resolved[0]
      : exactCargoDeclaredVersion(dependency.declaredVersion);
    result.push({
      name: dependency.name,
      ...(dependency.declaredVersion ? { declaredVersion: dependency.declaredVersion } : {}),
      ...(resolvedVersion ? { resolvedVersion } : {}),
      source: resolvedVersion && lockfile ? lockfile : dependency.source,
    });
  }
  const deduplicated = new Map<string, DependencyVersionEvidence>();
  for (const item of result) {
    const key = `${item.name}\u0000${item.declaredVersion ?? ""}\u0000${item.resolvedVersion ?? ""}`;
    deduplicated.set(key, item);
  }
  return [...deduplicated.values()].sort((left, right) => left.name.localeCompare(right.name));
}

interface RustToolchain {
  path?: string;
  channel?: string;
  components: string[];
  targets: string[];
}

async function readToolchain(
  context: AnalyzerContext,
  root: string,
  diagnostics: AnalyzerDiagnostic[],
): Promise<RustToolchain> {
  const candidates = findAncestorFiles(context, root, ["rust-toolchain.toml", "rust-toolchain"]);
  if (candidates.length === 0) return { components: [], targets: [] };
  const closestLength = Math.max(...candidates.map((path) => projectDirname(path).length));
  const closest = candidates.filter((path) => projectDirname(path).length === closestLength);
  if (closest.length > 1) {
    diagnostics.push({
      code: "CONFLICTING_RUST_TOOLCHAINS",
      message: "Both rust-toolchain and rust-toolchain.toml own the same workspace.",
      severity: "needs-input",
      paths: closest,
    });
  }
  const path = closest[0];
  if (!path) return { components: [], targets: [] };
  const text = await context.readText(path);
  if (!text) return { path, components: [], targets: [] };
  if (projectBasename(path) === "rust-toolchain") {
    const channel = text.trim();
    return { path, ...(channel ? { channel } : {}), components: [], targets: [] };
  }
  const toolchain = tomlSection(parseSimpleToml(text), "toolchain");
  return {
    path,
    ...(tomlString(toolchain.get("channel")) ? { channel: tomlString(toolchain.get("channel")) } : {}),
    components: tomlArray(toolchain.get("components")),
    targets: tomlArray(toolchain.get("targets")),
  };
}

async function cargoConfigTargets(
  context: AnalyzerContext,
  root: string,
): Promise<{ paths: string[]; targets: string[] }> {
  const candidates: string[] = [];
  let current = normalizeProjectPath(root);
  while (true) {
    for (const name of ["config.toml", "config"]) {
      const path = joinProjectPath(current, ".cargo", name);
      if (context.hasFile(path)) candidates.push(path);
    }
    if (current === ".") break;
    current = projectDirname(current);
  }
  if (candidates.length === 0) return { paths: [], targets: [] };
  const closestLength = Math.max(...candidates.map((path) => projectDirname(path).length));
  const selected = candidates.filter((path) => projectDirname(path).length === closestLength);
  const targets: string[] = [];
  for (const path of selected) {
    const text = await context.readText(path);
    if (!text) continue;
    const document = parseSimpleToml(text);
    const raw = tomlSection(document, "build").get("target");
    targets.push(...tomlArray(raw));
    const single = tomlString(raw);
    if (single) targets.push(single);
    for (const section of document.sections.keys()) {
      const match = /^target\.['"]?([^'"]+)['"]?$/.exec(section);
      if (match?.[1]) targets.push(match[1]);
    }
  }
  return { paths: selected, targets: sortedUnique(targets) };
}

function resolveInheritedPackageValue(
  member: CargoManifest,
  workspace: CargoManifest,
  key: "edition" | "rust-version" | "version",
): string | undefined {
  const direct = tomlString(tomlSection(member.document, "package").get(key));
  if (direct) return direct;
  const inherited = tomlBoolean(tomlSection(member.document, "package").get(`${key}.workspace`));
  return inherited ? tomlString(tomlSection(workspace.document, "workspace.package").get(key)) : undefined;
}

function cargoCommand(
  candidate: CargoCandidate,
  category: ValidationCategory,
  suffix: string,
  argv: string[],
  required: boolean,
): ValidationCommandV1 {
  return {
    id: `cargo:${candidate.root}:${category}:${suffix}`,
    category,
    cwd: candidate.root,
    argv,
    source: "language-toolchain",
    sourcePath: candidate.manifest.path,
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

function cargoValidationPlan(
  candidate: CargoCandidate,
  hasLockfile: boolean,
  clippy: boolean,
): ValidationCommandV1[] {
  const locked = hasLockfile ? ["--locked"] : [];
  const scope = candidate.manifest.hasWorkspace ? ["--workspace"] : [];
  const plan = [
    cargoCommand(
      candidate,
      "typecheck",
      "metadata",
      ["cargo", "metadata", "--format-version", "1", "--offline", ...locked],
      true,
    ),
    cargoCommand(candidate, "format", "fmt", ["cargo", "fmt", "--all", "--", "--check"], true),
    cargoCommand(
      candidate,
      "typecheck",
      "check",
      ["cargo", "check", "--offline", ...locked, ...scope],
      true,
    ),
    cargoCommand(
      candidate,
      "test",
      "test",
      ["cargo", "test", "--no-fail-fast", "--offline", ...locked, ...scope],
      true,
    ),
  ];
  if (clippy) {
    plan.push(
      cargoCommand(
        candidate,
        "lint",
        "clippy",
        ["cargo", "clippy", "--offline", ...locked, ...scope, "--all-targets"],
        true,
      ),
    );
  }
  return plan;
}

async function analyzeRustSource(
  context: AnalyzerContext,
  candidate: CargoCandidate,
  diagnostics: AnalyzerDiagnostic[],
): Promise<{
  noStdFiles: string[];
  unsafeFiles: string[];
  ffiFiles: string[];
  publicModules: string[];
  entryPoints: string[];
  evidence: Array<{ path: string; hash?: string }>;
}> {
  const files = context
    .filesBelow(candidate.root)
    .filter((path) => path.endsWith(".rs"))
    .filter(
      (path) =>
        !candidate.members.some(
          (member) => member.root !== candidate.root && !isBelow(member.root, candidate.root) && isBelow(path, member.root),
        ),
    );
  if (files.length > MAX_SOURCE_FILES) {
    diagnostics.push({
      code: "SOURCE_ANALYSIS_LIMIT",
      message: `The Cargo workspace has ${files.length} Rust files; source analysis is capped at ${MAX_SOURCE_FILES}.`,
      severity: "partial-scan",
      paths: [candidate.root],
    });
  }
  const noStdFiles: string[] = [];
  const unsafeFiles: string[] = [];
  const ffiFiles: string[] = [];
  const publicModules: string[] = [];
  const entryPoints: string[] = [];
  const evidence: Array<{ path: string; hash?: string }> = [];
  for (const path of files.slice(0, MAX_SOURCE_FILES)) {
    const text = await context.readText(path, 512 * 1024);
    if (text === undefined) continue;
    evidence.push({ path, hash: await context.contentHash(path) });
    if (/#!\s*\[\s*no_std\s*\]/.test(text)) noStdFiles.push(path);
    if (/\bunsafe\s*(?:fn|impl|trait|extern|\{)/.test(text)) unsafeFiles.push(path);
    if (/extern\s+"C"|#\s*\[\s*(?:no_mangle|unsafe\s*\(\s*no_mangle\s*\))/.test(text)) ffiFiles.push(path);
    for (const match of text.matchAll(/\bpub\s+(?:unsafe\s+)?(?:mod|struct|enum|trait|fn|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (match[1]) publicModules.push(`${path}:${match[1]}`);
    }
    if (/(?:^|\/)(?:main|lib)\.rs$/.test(path) || /\/src\/bin\/[^/]+\.rs$/.test(path)) entryPoints.push(path);
  }
  return {
    noStdFiles: sortedUnique(noStdFiles),
    unsafeFiles: sortedUnique(unsafeFiles),
    ffiFiles: sortedUnique(ffiFiles),
    publicModules: sortedUnique(publicModules),
    entryPoints: sortedUnique(entryPoints),
    evidence,
  };
}

async function analyzeCargoCandidate(
  context: AnalyzerContext,
  candidate: CargoCandidate,
): Promise<WorkspaceProfileV1> {
  const diagnostics: AnalyzerDiagnostic[] = [];
  if (candidate.unmatchedMemberPatterns.length > 0) {
    diagnostics.push({
      code: "UNRESOLVED_CARGO_MEMBERS",
      message: `Cargo workspace member patterns matched no readable manifest: ${candidate.unmatchedMemberPatterns.join(", ")}.`,
      severity: "needs-input",
      paths: [candidate.manifest.path],
    });
  }
  const lockfile = joinProjectPath(candidate.root, "Cargo.lock");
  const hasLockfile = context.hasFile(lockfile);
  if (!hasLockfile) {
    diagnostics.push({
      code: "CARGO_LOCKFILE_MISSING",
      message: "No Cargo.lock is present; exact transitive dependency resolution cannot be proven offline.",
      severity: "warning",
      paths: [candidate.root],
    });
  }
  const toolchain = await readToolchain(context, candidate.root, diagnostics);
  const config = await cargoConfigTargets(context, candidate.root);
  const resolutions = await cargoLockVersions(context, hasLockfile ? lockfile : undefined);
  const allDependencies = candidate.members.flatMap((member) => member.dependencies);
  if (candidate.manifest.hasWorkspace) allDependencies.push(...candidate.manifest.dependencies);
  const dependencyVersions = cargoDependencyEvidence(
    allDependencies,
    resolutions,
    hasLockfile ? lockfile : undefined,
  );
  const memberSignals: Record<string, ProfileSignalValue> = {};
  const editions: string[] = [];
  const rustVersions: string[] = [];
  for (const member of candidate.members) {
    const edition = resolveInheritedPackageValue(member, candidate.manifest, "edition") ?? "2015";
    const rustVersion = resolveInheritedPackageValue(member, candidate.manifest, "rust-version");
    editions.push(edition);
    if (rustVersion) rustVersions.push(rustVersion);
    if (!["2015", "2018", "2021", "2024"].includes(edition)) {
      diagnostics.push({
        code: "UNSUPPORTED_RUST_EDITION",
        message: `Rust edition ${edition} is not recognized by this support matrix.`,
        severity: "unsupported",
        paths: [member.path],
      });
    }
    memberSignals[member.packageName ?? member.root] = {
      root: member.root,
      version: resolveInheritedPackageValue(member, candidate.manifest, "version") ?? member.packageVersion ?? "unknown",
      edition,
      rustVersion: rustVersion ?? "unspecified",
      features: member.features,
      procMacro: member.procMacro,
    };
  }
  if (candidate.manifest.hasWorkspace && !candidate.manifest.resolver) {
    diagnostics.push({
      code: "CARGO_RESOLVER_IMPLICIT",
      message: "The Cargo workspace does not declare a resolver; feature resolution depends on Cargo defaults.",
      severity: "warning",
      paths: [candidate.manifest.path],
    });
  }
  const source = await analyzeRustSource(context, candidate, diagnostics);
  const externalPathDependencies: string[] = [];
  const unresolvedPathDependencies: string[] = [];
  for (const dependency of allDependencies.filter((item) => item.path !== undefined)) {
    const rawPath = dependency.path ?? "";
    const resolved = normalizeProjectPath(posix.normalize(posix.join(projectDirname(dependency.source), rawPath)));
    if (resolved === ".." || resolved.startsWith("../")) externalPathDependencies.push(`${dependency.name}:${rawPath}`);
    else if (!context.hasFile(joinProjectPath(resolved, "Cargo.toml"))) {
      unresolvedPathDependencies.push(`${dependency.name}:${resolved}`);
    }
  }
  if (externalPathDependencies.length > 0) {
    diagnostics.push({
      code: "EXTERNAL_CARGO_PATH_DEPENDENCY",
      message: "A Cargo path dependency escapes the analysis root and cannot be validated in confinement.",
      severity: "unsupported",
      paths: candidate.members.map((member) => member.path),
    });
  }
  if (unresolvedPathDependencies.length > 0) {
    diagnostics.push({
      code: "UNRESOLVED_CARGO_PATH_DEPENDENCY",
      message: `Cargo path dependencies have no readable manifest: ${unresolvedPathDependencies.join(", ")}.`,
      severity: "needs-input",
      paths: candidate.members.map((member) => member.path),
    });
  }
  const sysCrates = sortedUnique(
    allDependencies.map((dependency) => dependency.name).filter((name) => name.endsWith("-sys")),
  );
  const buildScripts = candidate.members
    .map((member) => joinProjectPath(member.root, "build.rs"))
    .filter((path) => context.hasFile(path));
  const procMacroCrates = candidate.members
    .filter((member) => member.procMacro)
    .map((member) => member.packageName ?? member.root);
  const asyncRuntimes = sortedUnique(
    allDependencies
      .map((dependency) => dependency.name)
      .filter((name) => ["tokio", "async-std", "smol", "glommio"].includes(name)),
  );
  const errorLibraries = sortedUnique(
    allDependencies
      .map((dependency) => dependency.name)
      .filter((name) => ["anyhow", "thiserror", "eyre", "color-eyre", "miette"].includes(name)),
  );
  const sourceRoots = sortedUnique(
    candidate.members
      .map((member) => joinProjectPath(member.root, "src"))
      .filter((path) => context.hasDirectory(path)),
  );
  const testRoots = sortedUnique(
    candidate.members.flatMap((member) =>
      nearestExistingRoots(context, member.root, ["tests", "benches", "examples"]),
    ),
  );
  const migrationRoots = sortedUnique(
    candidate.members.flatMap((member) =>
      nearestExistingRoots(context, member.root, ["migrations"]),
    ),
  );
  const evidence = await Promise.all([
    ...sortedUnique([candidate.manifest.path, ...candidate.members.map((member) => member.path)]).map((path) =>
      evidenceFor(context, path, "manifest", "Static Cargo package/workspace manifest"),
    ),
    ...(hasLockfile ? [evidenceFor(context, lockfile, "lockfile", "Cargo dependency resolution")] : []),
    ...(toolchain.path
      ? [evidenceFor(context, toolchain.path, "toolchain", "Pinned Rust toolchain configuration")]
      : []),
    ...config.paths.map((path) => evidenceFor(context, path, "config", "Static Cargo target configuration")),
  ]);
  for (const item of source.evidence) {
    evidence.push({
      kind: "source",
      path: item.path,
      detail: "Inspected for no_std, unsafe/FFI, entry points, and public API signals",
      ...(item.hash === undefined ? {} : { contentHash: item.hash }),
    });
  }
  const variant = candidate.manifest.hasWorkspace ? "cargo-workspace" : "cargo-crate";
  const clippy =
    toolchain.components.includes("clippy") ||
    context.hasFile(joinProjectPath(candidate.root, "clippy.toml")) ||
    context.hasFile(joinProjectPath(candidate.root, ".clippy.toml"));
  const featureMap: Record<string, ProfileSignalValue> = {};
  for (const member of candidate.members) featureMap[member.packageName ?? member.root] = member.features;

  return finalizeWorkspace({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    id: `rust:${candidate.root}`,
    relativeRoot: candidate.root,
    ecosystem: "rust",
    variant,
    support: supportFor("rust", variant, toolchain.channel),
    ownership: {
      root: candidate.root,
      ...(candidate.manifest.packageName ? { owner: candidate.manifest.packageName } : {}),
      members: sortedUnique(candidate.members.map((member) => member.root)),
    },
    framework: {
      name: "Cargo/Rust",
      ...(toolchain.channel ? { resolvedVersion: toolchain.channel, versionSource: toolchain.path } : {}),
      dependencies: dependencyVersions,
    },
    packageManager: { name: "cargo", ...(hasLockfile ? { lockfile } : {}) },
    runtime: {
      toolchain: toolchain.channel ?? "ambient",
      components: toolchain.components,
      targets: sortedUnique([...toolchain.targets, ...config.targets]),
      editions: sortedUnique(editions),
      rustVersions: sortedUnique(rustVersions),
      resolver: candidate.manifest.resolver ?? "implicit",
    },
    manifests: sortedUnique([candidate.manifest.path, ...candidate.members.map((member) => member.path)]),
    lockfiles: hasLockfile ? [lockfile] : [],
    sourceRoots,
    testRoots,
    generatedRoots: nearestExistingRoots(context, candidate.root, ["target", "generated"]),
    migrationRoots,
    protectedRoots: sortedUnique([".git", "target", ".cargo/credentials", ".cargo/credentials.toml"]),
    moduleAliases: {},
    workspaceDependencies: sortedUnique(
      allDependencies.filter((dependency) => dependency.workspace || dependency.path).map((dependency) => dependency.name),
    ),
    publicExports: source.publicModules,
    entryPoints: source.entryPoints,
    routes: [],
    signals: {
      members: memberSignals,
      features: featureMap,
      optionalDependencies: sortedUnique(
        allDependencies.filter((dependency) => dependency.optional).map((dependency) => dependency.name),
      ),
      dependencyFeatures: Object.fromEntries(
        allDependencies
          .filter((dependency) => dependency.features.length > 0)
          .map((dependency) => [dependency.name, dependency.features]),
      ),
      asyncRuntimes,
      errorLibraries,
      noStdFiles: source.noStdFiles,
      unsafeFiles: source.unsafeFiles,
      ffiFiles: source.ffiFiles,
      buildScripts,
      procMacroCrates,
      nativeSysCrates: sysCrates,
      externalPathDependencies,
      unresolvedPathDependencies,
      allFeaturesValidationAllowed: false,
    },
    validationPlan: cargoValidationPlan(candidate, hasLockfile, clippy),
    manualAcceptance: [
      "Review unsafe, FFI, build-script, proc-macro, native-link, and public-API changes as elevated risk.",
      "Validate only declared feature/target profiles; never assume --all-features is valid.",
    ],
    diagnostics,
    evidence,
  });
}

export class RustEcosystemAdapter implements EcosystemAdapter {
  readonly ecosystem = "rust" as const;

  async analyze(context: AnalyzerContext): Promise<WorkspaceProfileV1[]> {
    const candidates = await loadCargoCandidates(context);
    const profiles: WorkspaceProfileV1[] = [];
    for (const candidate of candidates) profiles.push(await analyzeCargoCandidate(context, candidate));
    return profiles;
  }
}

export const rustEcosystemAdapter = new RustEcosystemAdapter();
