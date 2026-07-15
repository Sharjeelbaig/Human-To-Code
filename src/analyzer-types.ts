/**
 * Public, versioned types produced by the static project analyzer.
 *
 * The analyzer deliberately describes commands without running them. A later
 * validation stage must execute these plans inside an approved sandbox.
 */

export const PROJECT_PROFILE_SCHEMA_VERSION = "1" as const;

export type Ecosystem = "react" | "nestjs" | "fastapi" | "rust";

export type ProjectAnalysisStatus =
  | "SUPPORTED"
  | "NEEDS_INPUT"
  | "UNSUPPORTED"
  | "PARTIAL_SCAN";

export type AnalyzerDiagnosticSeverity =
  | "warning"
  | "needs-input"
  | "unsupported"
  | "partial-scan";

export interface AnalyzerDiagnostic {
  /** Stable machine-readable identifier. */
  code: string;
  message: string;
  severity: AnalyzerDiagnosticSeverity;
  /** Project-relative, forward-slash paths. */
  paths: string[];
}

export type SupportTier = "certified" | "preview" | "legacy" | "unsupported";

export interface SupportDecision {
  tier: SupportTier;
  matrixKey: string;
  reason: string;
  matchedVersion?: string;
}

export interface DependencyVersionEvidence {
  name: string;
  declaredVersion?: string;
  resolvedVersion?: string;
  source?: string;
}

export interface FrameworkIdentity {
  name: string;
  declaredVersion?: string;
  resolvedVersion?: string;
  versionSource?: string;
  dependencies: DependencyVersionEvidence[];
}

export type ValidationCategory =
  | "format"
  | "lint"
  | "typecheck"
  | "build"
  | "test"
  | "integration";

export interface ValidationCommandV1 {
  id: string;
  category: ValidationCategory;
  /** Project-relative workspace directory. */
  cwd: string;
  /** An argv vector: never a shell command string. */
  argv: string[];
  source: "package-script" | "declared-tool" | "language-toolchain";
  sourcePath: string;
  required: boolean;
  network: false;
  /** Hard upper bound enforced by the validation sandbox. */
  timeoutMs: number;
  /** Project validation is untrusted code even when the command is known. */
  risk: "executes-project-code";
}

export interface AnalysisEvidenceV1 {
  kind:
    | "manifest"
    | "lockfile"
    | "config"
    | "source"
    | "toolchain"
    | "workspace";
  path: string;
  detail: string;
  /** SHA-256 of content read while producing this evidence. */
  contentHash?: string;
}

export type ProfileSignalValue =
  | null
  | boolean
  | number
  | string
  | string[]
  | { [key: string]: ProfileSignalValue };

export interface WorkspaceOwnershipV1 {
  /** Owning package/workspace root, project-relative. */
  root: string;
  owner?: string;
  members: string[];
}

export interface WorkspaceProfileV1 {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  /** Deterministic within the project; normally `<ecosystem>:<relativeRoot>`. */
  id: string;
  relativeRoot: string;
  ecosystem: Ecosystem;
  variant: string;
  support: SupportDecision;
  ownership: WorkspaceOwnershipV1;
  framework: FrameworkIdentity;
  packageManager?: {
    name: "npm" | "pnpm" | "yarn" | "bun" | "uv" | "poetry" | "pdm" | "pipenv" | "pip" | "conda" | "cargo" | "unknown";
    lockfile?: string;
  };
  runtime: Record<string, ProfileSignalValue>;
  manifests: string[];
  lockfiles: string[];
  sourceRoots: string[];
  testRoots: string[];
  generatedRoots: string[];
  migrationRoots: string[];
  protectedRoots: string[];
  moduleAliases: Record<string, string[]>;
  workspaceDependencies: string[];
  publicExports: string[];
  entryPoints: string[];
  routes: string[];
  signals: Record<string, ProfileSignalValue>;
  validationPlan: ValidationCommandV1[];
  manualAcceptance: string[];
  diagnostics: AnalyzerDiagnostic[];
  evidence: AnalysisEvidenceV1[];
  fingerprint: string;
}

export interface ScanSummaryV1 {
  directoriesVisited: number;
  filesVisited: number;
  symlinksSkipped: number;
  ignoredEntries: number;
  unreadablePaths: string[];
  truncated: boolean;
}

export interface ProjectProfileV1 {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  root: string;
  status: ProjectAnalysisStatus;
  workspaces: WorkspaceProfileV1[];
  diagnostics: AnalyzerDiagnostic[];
  scan: ScanSummaryV1;
  fingerprint: string;
}

export interface AnalyzerOptions {
  /** Hard limits prevent a repository from silently exhausting resources. */
  maxDirectories?: number;
  maxFiles?: number;
  maxTextFileBytes?: number;
}

/** A safe inventory passed to ecosystem adapters. */
export interface AnalyzerInventory {
  root: string;
  files: string[];
  directories: string[];
  scan: ScanSummaryV1;
}

export interface AnalyzerContext {
  inventory: AnalyzerInventory;
  hasFile(path: string): boolean;
  hasDirectory(path: string): boolean;
  filesBelow(path: string): string[];
  readText(path: string, maxBytes?: number): Promise<string | undefined>;
  contentHash(path: string): Promise<string | undefined>;
  addDiagnostic(diagnostic: AnalyzerDiagnostic): void;
}

/**
 * Adapters must be static and read-only. They may inspect files through the
 * context, but must not import project modules, execute configs, or spawn tools.
 */
export interface EcosystemAdapter {
  readonly ecosystem: Ecosystem;
  analyze(context: AnalyzerContext): Promise<WorkspaceProfileV1[]>;
}
