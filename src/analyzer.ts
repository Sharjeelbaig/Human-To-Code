/**
 * Deterministic, static project analysis.
 *
 * This module never imports application modules, evaluates config files, or
 * invokes project commands. It only inventories regular files and delegates
 * bounded text inspection to static ecosystem adapters.
 */

import type {
  AnalyzerDiagnostic,
  AnalyzerOptions,
  EcosystemAdapter,
  ProjectAnalysisStatus,
  ProjectProfileV1,
  WorkspaceProfileV1,
} from "./analyzer-types.ts";
import { PROJECT_PROFILE_SCHEMA_VERSION } from "./analyzer-types.ts";
import {
  compareDiagnostics,
  createAnalyzerContext,
  fingerprint,
  scanProject,
} from "./analyzer-utils.ts";
import { nodeEcosystemAdapter } from "./adapters/node.ts";
import { fastApiEcosystemAdapter } from "./adapters/python.ts";
import { rustEcosystemAdapter } from "./adapters/rust.ts";

export const DEFAULT_ECOSYSTEM_ADAPTERS: readonly EcosystemAdapter[] = [
  nodeEcosystemAdapter,
  fastApiEcosystemAdapter,
  rustEcosystemAdapter,
] as const;

function diagnosticKey(diagnostic: AnalyzerDiagnostic): string {
  return `${diagnostic.severity}\u0000${diagnostic.code}\u0000${diagnostic.message}\u0000${diagnostic.paths.join("\u0000")}`;
}

function uniqueDiagnostics(diagnostics: AnalyzerDiagnostic[]): AnalyzerDiagnostic[] {
  const result = new Map<string, AnalyzerDiagnostic>();
  for (const diagnostic of diagnostics) {
    const normalized = { ...diagnostic, paths: [...diagnostic.paths].sort() };
    result.set(diagnosticKey(normalized), normalized);
  }
  return [...result.values()].sort(compareDiagnostics);
}

function analysisStatus(
  workspaces: WorkspaceProfileV1[],
  diagnostics: AnalyzerDiagnostic[],
): ProjectAnalysisStatus {
  const all = [...diagnostics, ...workspaces.flatMap((workspace) => workspace.diagnostics)];
  if (all.some((diagnostic) => diagnostic.severity === "partial-scan")) return "PARTIAL_SCAN";
  if (all.some((diagnostic) => diagnostic.severity === "needs-input")) return "NEEDS_INPUT";
  if (
    workspaces.length === 0 ||
    all.some((diagnostic) => diagnostic.severity === "unsupported") ||
    workspaces.some((workspace) => workspace.support.tier === "unsupported")
  ) {
    return "UNSUPPORTED";
  }
  return "SUPPORTED";
}

/**
 * Analyze a project root using the built-in React/NestJS, FastAPI, and Cargo
 * adapters. Custom adapters are useful for downstream/private ecosystems, but
 * are held to the same read-only context boundary.
 */
export async function analyzeProject(
  root: string,
  options: AnalyzerOptions = {},
  adapters: readonly EcosystemAdapter[] = DEFAULT_ECOSYSTEM_ADAPTERS,
): Promise<ProjectProfileV1> {
  const scanned = await scanProject(root, options);
  const analyzerDiagnostics = [...scanned.diagnostics];
  const context = createAnalyzerContext(scanned.inventory, analyzerDiagnostics, options);
  const adapterResults = await Promise.all(
    adapters.map(async (adapter): Promise<WorkspaceProfileV1[]> => {
      try {
        return await adapter.analyze(context);
      } catch (error) {
        context.addDiagnostic({
          code: "ADAPTER_ANALYSIS_FAILED",
          message: `The ${adapter.ecosystem} static adapter failed safely: ${String(error)}`,
          severity: "partial-scan",
          paths: ["."],
        });
        return [];
      }
    }),
  );
  const workspaces = adapterResults
    .flat()
    .sort((left, right) => left.id.localeCompare(right.id));
  const diagnostics = uniqueDiagnostics([
    ...analyzerDiagnostics,
    ...workspaces.flatMap((workspace) => workspace.diagnostics),
  ]);
  if (workspaces.length === 0 && !diagnostics.some((item) => item.severity === "partial-scan")) {
    diagnostics.push({
      code: "NO_SUPPORTED_WORKSPACE",
      message: "No statically recognizable React, NestJS, FastAPI, or Cargo workspace was found.",
      severity: "unsupported",
      paths: ["."],
    });
  }
  const finalDiagnostics = uniqueDiagnostics(diagnostics);
  const status = analysisStatus(workspaces, finalDiagnostics);
  const fingerprintInput = {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    status,
    workspaces: workspaces.map((workspace) => ({ id: workspace.id, fingerprint: workspace.fingerprint })),
    diagnostics: finalDiagnostics,
    scan: scanned.inventory.scan,
  };
  return {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    root: scanned.inventory.root,
    status,
    workspaces,
    diagnostics: finalDiagnostics,
    scan: scanned.inventory.scan,
    fingerprint: fingerprint(fingerprintInput),
  };
}

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
  ValidationCategory,
  ValidationCommandV1,
  WorkspaceOwnershipV1,
  WorkspaceProfileV1,
} from "./analyzer-types.ts";

export { SUPPORT_MATRIX, SUPPORT_MATRIX_VERSION, supportFor } from "./support-matrix.ts";
export { NodeEcosystemAdapter, nodeEcosystemAdapter } from "./adapters/node.ts";
export { FastApiEcosystemAdapter, fastApiEcosystemAdapter } from "./adapters/python.ts";
export { RustEcosystemAdapter, rustEcosystemAdapter } from "./adapters/rust.ts";
