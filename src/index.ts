/** Stable public API for embedding the Human-to-Code pipeline. */

export type {
  Config,
  ProviderConfig,
  ProviderName,
  TargetLanguage,
  SourceFile,
  SourceKind,
  DiscoveryResult,
} from "./types.ts";

export * from "./config.ts";
export * from "./discovery.ts";
export * from "./contracts.ts";
export * from "./context.ts";
export * from "./documentation.ts";
export * from "./provider.ts";
export * from "./providers.ts";
export * from "./schemas.ts";
export * from "./secret-scan.ts";
export * from "./compiler-skills.ts";
export * from "./compiler-tools.ts";
export * from "./planner.ts";
export * from "./patch.ts";
export * from "./snapshot.ts";
export * from "./run-store.ts";
export * from "./validation.ts";
export * from "./workflow.ts";

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
} from "./analyzer.ts";

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
} from "./analyzer.ts";
