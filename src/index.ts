/**
 * Stable public API for embedding the Human-to-Code pipeline.
 *
 * Exports are grouped by layer; see docs/ARCHITECTURE.md for how the layers
 * relate. The CLI (`src/cli.ts`) is a thin shell over this same surface.
 */

// Core primitives: shared types and versioned artifact contracts.
export type {
  Config,
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
} from "./analysis/analyzer.ts";
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
} from "./analysis/analyzer.ts";

// Security: fail-closed repository secret scanning.
export * from "./security/secret-scan.ts";

// Grounded context: selection, documentation retrieval, compiler skills/tools.
export * from "./context/context.ts";
export * from "./context/documentation.ts";
export * from "./context/compiler-skills.ts";
export * from "./context/compiler-tools.ts";

// Providers: adapter contract, bundled adapters, certification gate, schemas.
export * from "./providers/provider.ts";
export * from "./providers/providers.ts";
export * from "./providers/certification.ts";
export * from "./providers/schemas.ts";

// Pipeline: plan -> generate -> validate -> apply orchestration and storage.
export * from "./pipeline/planner.ts";
export * from "./pipeline/patch.ts";
export * from "./pipeline/snapshot.ts";
export * from "./pipeline/run-store.ts";
export * from "./pipeline/validation.ts";
export * from "./pipeline/workflow.ts";
