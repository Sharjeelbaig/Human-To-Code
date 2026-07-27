/** Orchestrates deterministic and optional semantic specification diagnostics. */
import type { CompilerConfigV1 } from "../config/config.ts";
import {
  diagnoseUnits,
  type SpecDiagnostic,
} from "../tools/compiler/spec-diagnostics.ts";
import { diagnoseInstructionImports } from "../tools/compiler/import-diagnostics.ts";
import type { ConversionUnit } from "./types.ts";

export interface CompileGateResult {
  blocked: boolean;
  diagnostics: SpecDiagnostic[];
  warnings: string[];
  semanticRequests: number;
}

export interface CompileGateHooks {
  diagnose?: (
    batch: readonly ConversionUnit[],
  ) => Promise<SpecDiagnostic[]>;
}

const SEMANTIC_BATCH_SIZE = 40;

function stableDiagnostics(
  diagnostics: readonly SpecDiagnostic[],
): SpecDiagnostic[] {
  const unique = new Map<string, SpecDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.sourcePath,
      diagnostic.line ?? 0,
      diagnostic.rule,
      diagnostic.facets.map((facet) => facet.id).join(","),
    ].join("\0");
    if (!unique.has(key)) unique.set(key, diagnostic);
  }
  return [...unique.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.rule.localeCompare(right.rule));
}

/** Run local diagnostics, then optionally append fail-open semantic results. */
export async function runCompileGate(
  units: readonly ConversionUnit[],
  compiler: CompilerConfigV1,
  hooks: CompileGateHooks = {},
): Promise<CompileGateResult> {
  const local = [
    ...diagnoseUnits(units, { vocabulary: compiler.vocabulary }),
    ...diagnoseInstructionImports(units),
  ];
  const semantic: SpecDiagnostic[] = [];
  const warnings: string[] = [];
  let semanticRequests = 0;
  if (compiler.semanticDiagnostics && hooks.diagnose !== undefined) {
    for (let offset = 0; offset < units.length; offset += SEMANTIC_BATCH_SIZE) {
      const batch = units.slice(offset, offset + SEMANTIC_BATCH_SIZE);
      semanticRequests += 1;
      try {
        semantic.push(...await hooks.diagnose(batch));
      } catch (error) {
        warnings.push(
          `semantic specification diagnostics were skipped for ${batch.length} item(s): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  const diagnostics = stableDiagnostics([...local, ...semantic]);
  return {
    blocked:
      diagnostics.some((item) =>
        item.severity === "error"
        && (
          item.code === "E-IMPORT-UNRESOLVED"
          || compiler.onUnderspecified === "error"
        )),
    diagnostics,
    warnings,
    semanticRequests,
  };
}
