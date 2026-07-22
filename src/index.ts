/**
 * Stable public API for embedding Human-to-Code.
 *
 * Exports are grouped by the agentic folders described in
 * `docs/Codebase_Tour.md`. The CLI (`src/cli.ts`) is a shell over this same
 * surface, so reorganizing internal files does not change consumer imports.
 */

// Core primitives: shared types and versioned artifact contracts.
export type {
  Config,
  HumanFileExtensionConfig,
  ProviderConfig,
  ProviderName,
  TargetLanguage,
  SourceFile,
  SourceKind,
  DiscoveryResult,
} from "./core/types.ts";
export * from "./core/contracts.ts";

// Configuration and `.human` source discovery.
export * from "./config/config.ts";
export * from "./config/discovery.ts";

// Static project analysis: analyzer, support matrix, ecosystem adapters.
export {
  analyzeProject,
  DEFAULT_ECOSYSTEM_ADAPTERS,
  SUPPORT_MATRIX,
  SUPPORT_MATRIX_VERSION,
  supportFor,
  NodeEcosystemAdapter,
  nodeEcosystemAdapter,
  FastApiEcosystemAdapter,
  fastApiEcosystemAdapter,
  RustEcosystemAdapter,
  rustEcosystemAdapter,
} from "./tools/analysis/analyzer.ts";
export type {
  AnalysisEvidenceV1,
  AnalyzerContext,
  AnalyzerDiagnostic,
  AnalyzerDiagnosticSeverity,
  AnalyzerInventory,
  AnalyzerOptions,
  DependencyVersionEvidence,
  Ecosystem,
  EcosystemAdapter,
  FrameworkIdentity,
  ProfileSignalValue,
  ProjectAnalysisStatus,
  ProjectProfileV1,
  ScanSummaryV1,
  SupportDecision,
  SupportTier,
  WorkspaceOwnershipV1,
  WorkspaceProfileV1,
  ValidationCategory as AnalyzerValidationCategory,
  ValidationCommandV1 as AnalyzerValidationCommandV1,
} from "./tools/analysis/analyzer.ts";

// Security: fail-closed repository secret scanning.
export * from "./tools/security/secret-scan.ts";

// Grounded context: selection, documentation retrieval, compiler skills/tools.
export * from "./memory/context.ts";
export * from "./memory/documentation.ts";
export * from "./memory/compiler-skills.ts";
export * from "./memory/compiler-tools.ts";
export * from "./memory/project-memory.ts";
export * from "./memory/file-memory.ts";

// Providers: adapter contract, bundled adapters, certification gate, schemas.
export * from "./llms/index.ts";

// Workflows sequence model-facing work; focused capabilities remain in tools.
export * from "./workflows/index.ts";
export * from "./tools/discovery/languages.ts";
export * from "./tools/discovery/marker-parser.ts";
export * from "./tools/discovery/language-relationships.ts";
export * from "./tools/discovery/discovery.ts";
export * from "./tools/discovery/declarations.ts";
export * from "./tools/validation/index.ts";
export * from "./tools/file-ops/index.ts";
export * from "./prompts/index.ts";
export * from "./skills/index.ts";
