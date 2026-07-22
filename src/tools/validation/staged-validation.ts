/**
 * Staged, project-aware validation for multi-file JS/TS direct conversions.
 * All successfully generated units enter an in-memory candidate overlay; the
 * TypeScript and explicitly opted-in JavaScript are compiled with the
 * TypeScript Compiler API and compared against the unchanged baseline.
 * Dependency-connected groups that
 * introduce new diagnostics are repaired within a bounded budget or rejected
 * whole, and only units proven independent of every failure are applied.
 *
 * This is static compiler validation: no project code is imported, executed,
 * or sandboxed here, and passing it is never presented as `VERIFIED`.
 */
import { ContextSecurityError, scanSecrets } from "../../memory/context.ts";
import { extname } from "node:path";
import { buildCandidateOverlay, type CandidateOverlay } from "./candidate-overlay.ts";
import { validateGeneratedUnit } from "./candidate-validation.ts";
import { attributeDiagnostics, buildOverlayDependencyGroups } from "./dependency-graph.ts";
import {
  collectProjectDiagnostics,
  createValidationProgramContext,
  newlyIntroducedProjectDiagnostics,
  type ProjectDiagnostic,
} from "./program-diagnostics.ts";
import type { ConversionUnit, GeneratedConversionUnit, ProjectMemoryProvider } from "../../workflows/types.ts";

export interface StagedRepairRequest {
  unit: ConversionUnit;
  /** Project-relative path of the candidate being repaired. */
  targetPath: string;
  /** The unit's current generated code (whole file contents). */
  currentCode: string;
  /** Normalized new diagnostics attributed to this candidate's dependency group. */
  diagnostics: ProjectDiagnostic[];
  /** Trusted deterministic guidance for recognized compiler diagnostics. */
  hints: string[];
  /** Other generated candidate files in the same dependency group. */
  relatedFiles: Array<{ path: string; content: string }>;
  /** Target-specific current/projected repository evidence within the same budget. */
  projectMemory?: string;
}

export type StagedValidationProgress =
  | { kind: "project-validate"; files: number; pass: number }
  | { kind: "repair"; unit: ConversionUnit; attempt: number }
  | { kind: "reject"; unit: ConversionUnit; reason: string };

export interface StagedValidationOptions {
  /** Bounded cross-file repair callback; omitted means failing groups are rejected directly. */
  repair?: (request: StagedRepairRequest) => Promise<string>;
  /** Repair requests allowed per whole-file unit (default 1). */
  maxRepairAttemptsPerUnit?: number;
  /** Character budget for one repair request's code-and-diagnostics context. */
  contextCharBudget?: number;
  /** Shared project memory, refreshed when a repair changes a candidate. */
  projectMemory?: ProjectMemoryProvider;
  onProgress?: (event: StagedValidationProgress) => void;
}

export interface StagedValidationOutcome {
  /** One result per input unit, in input order; rejected units carry `error`. */
  results: GeneratedConversionUnit[];
  /** True when a combined candidate program was actually type-checked. */
  validated: boolean;
  /** Number of bounded repair requests issued. */
  repairRequests: number;
}

const MAX_DIAGNOSTICS_PER_REQUEST = 20;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 400;
const DEFAULT_CONTEXT_CHAR_BUDGET = 48_000;

/** Strip control characters so compiler output stays plain, single-line data. */
function sanitizeDiagnostic(diagnostic: ProjectDiagnostic): ProjectDiagnostic {
  const message = diagnostic.message
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\r?\n/gu, " ")
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  return { ...diagnostic, message };
}

function describeDiagnostics(diagnostics: readonly ProjectDiagnostic[]): string {
  const shown = diagnostics.slice(0, 3).map((diagnostic) => {
    const location = diagnostic.path === undefined
      ? "project"
      : `${diagnostic.path}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ""}`;
    return `${location} TS${diagnostic.code} ${sanitizeDiagnostic(diagnostic).message}`;
  });
  const more = diagnostics.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

function repairHints(unit: ConversionUnit, diagnostics: readonly ProjectDiagnostic[]): string[] {
  const path = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
  const javascript = [".js", ".jsx", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
  if (!javascript) return [];
  const hints = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 2339) continue;
    const match = /Property '([^']+)' does not exist on type '([^']+)'/u.exec(diagnostic.message);
    if (!match) continue;
    const [, member, inferredType] = match;
    hints.add(`TS2339 means the inferred type ${inferredType} does not declare ${member}. Preserve the requested behavior by proving/narrowing the value to the correct subtype or by using an equivalent member that the inferred type actually declares; do not use an unsafe universal type or suppress validation.`);
  }
  return [...hints];
}

/**
 * Validate the combined candidate project before anything is written and
 * return per-unit accept/reject results. Units that do not produce JS/TS are
 * passed through unchanged and keep their per-unit validation level.
 */
export async function validateCandidateProject(
  root: string,
  generated: readonly GeneratedConversionUnit[],
  options: StagedValidationOptions = {},
): Promise<StagedValidationOutcome> {
  const results: GeneratedConversionUnit[] = generated.map((item) => ({ ...item }));
  const maxRepairAttempts = Math.max(0, options.maxRepairAttemptsPerUnit ?? 1);
  const contextCharBudget = options.contextCharBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;

  const initialOverlay = await buildCandidateOverlay(root, results);
  applyOverlayExclusions(results, initialOverlay, options);
  if (initialOverlay.files.size === 0) {
    return { results, validated: false, repairRequests: 0 };
  }

  const context = await createValidationProgramContext(root);
  const baseline = collectProjectDiagnostics(context);

  const repairAttempts = new Map<ConversionUnit, number>();
  let repairRequests = 0;
  const activeUnits = new Set<ConversionUnit>();
  for (const file of initialOverlay.files.values()) for (const unit of file.units) activeUnits.add(unit);
  const maxPasses = activeUnits.size * (1 + maxRepairAttempts) + 2;

  const rejectUnit = (unit: ConversionUnit, reason: string): void => {
    const item = results.find((entry) => entry.unit === unit);
    if (!item || item.error !== undefined) return;
    item.error = reason;
    item.code = "";
    options.onProgress?.({ kind: "reject", unit, reason });
  };

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const overlay = await buildCandidateOverlay(root, results);
    applyOverlayExclusions(results, overlay, options);
    if (overlay.files.size === 0) break;
    options.onProgress?.({ kind: "project-validate", files: overlay.files.size, pass });

    const candidate = collectProjectDiagnostics(context, overlay);
    const introduced = newlyIntroducedProjectDiagnostics(baseline, candidate, overlay);
    if (introduced.length === 0) break;

    const attribution = attributeDiagnostics(introduced, overlay, context);
    if (attribution.unattributed.length > 0) {
      // Safe isolation cannot be proven, so the whole staged batch fails
      // closed instead of writing a possibly-broken partial application.
      const reason = `combined project validation introduced errors that could not be safely attributed: ${describeDiagnostics(attribution.unattributed)}`;
      for (const file of overlay.files.values()) for (const unit of file.units) rejectUnit(unit, reason);
      break;
    }

    const groups = buildOverlayDependencyGroups(overlay, context);
    const groupDiagnostics = new Map<number, ProjectDiagnostic[]>();
    for (const [key, diagnostics] of attribution.byFile) {
      const group = groups.groupOf.get(key)!;
      groupDiagnostics.set(group, [...(groupDiagnostics.get(group) ?? []), ...diagnostics]);
    }

    let repaired = false;
    if (options.repair && maxRepairAttempts > 0) {
      for (const [key, diagnostics] of attribution.byFile) {
        const file = overlay.files.get(key)!;
        // Only whole-file candidates are repairable; an inline-modified file
        // may hold several markers whose replacements cannot be regenerated
        // independently without guessing, so its group fails closed instead.
        if (!file.created || file.units.length !== 1) continue;
        const unit = file.units[0]!;
        const attempts = repairAttempts.get(unit) ?? 0;
        if (attempts >= maxRepairAttempts) continue;
        repairAttempts.set(unit, attempts + 1);
        const item = results.find((entry) => entry.unit === unit)!;
        const group = groups.groupOf.get(key)!;
        const request = buildRepairRequest(unit, item.code, overlay, key, groups.members.get(group) ?? [], [
          ...(groupDiagnostics.get(group) ?? diagnostics),
        ], contextCharBudget, options.projectMemory);
        if (scanSecrets(`${request.currentCode}\n${request.relatedFiles.map((entry) => entry.content).join("\n")}`).length > 0) {
          // Never send credential-like content in repair context; the unit
          // simply stays unrepaired and its group is rejected on the next pass.
          repairAttempts.set(unit, maxRepairAttempts);
          continue;
        }
        options.onProgress?.({ kind: "repair", unit, attempt: attempts + 1 });
        repairRequests += 1;
        try {
          const repairedCode = await options.repair(request);
          if (repairedCode.trim().length === 0 || repairedCode === item.code) continue;
          await validateGeneratedUnit(unit, repairedCode);
          item.code = repairedCode;
          options.projectMemory?.remember(unit, repairedCode);
          repaired = true;
        } catch (error) {
          if (error instanceof ContextSecurityError) throw error;
          // A failed or invalid repair keeps the previous candidate; the
          // attempt budget is already consumed.
        }
      }
    }
    if (repaired) continue;

    for (const [group, diagnostics] of groupDiagnostics) {
      const reason = `combined project validation failed for this dependency group: ${describeDiagnostics(diagnostics)}`;
      for (const key of groups.members.get(group) ?? []) {
        for (const unit of overlay.files.get(key)!.units) rejectUnit(unit, reason);
      }
    }
  }

  return { results, validated: true, repairRequests };
}

function applyOverlayExclusions(
  results: GeneratedConversionUnit[],
  overlay: CandidateOverlay,
  options: StagedValidationOptions,
): void {
  for (const { unit, reason } of overlay.excluded) {
    const item = results.find((entry) => entry.unit === unit);
    if (!item || item.error !== undefined) continue;
    item.error = reason;
    item.code = "";
    options.onProgress?.({ kind: "reject", unit, reason });
  }
}

function buildRepairRequest(
  unit: ConversionUnit,
  currentCode: string,
  overlay: CandidateOverlay,
  ownKey: string,
  groupKeys: readonly string[],
  diagnostics: ProjectDiagnostic[],
  contextCharBudget: number,
  projectMemory?: ProjectMemoryProvider,
): StagedRepairRequest {
  const normalized = diagnostics.slice(0, MAX_DIAGNOSTICS_PER_REQUEST).map(sanitizeDiagnostic);
  const hints = repairHints(unit, normalized);
  const diagnosticChars = normalized.reduce((total, item) => total + item.message.length + (item.path?.length ?? 0) + 32, 0);
  const hintChars = hints.reduce((total, hint) => total + hint.length + 4, 0);
  let budget = Math.max(0, contextCharBudget - currentCode.length - diagnosticChars - hintChars);
  const renderedProjectMemory = projectMemory?.renderFor(unit, Math.floor(budget / 2));
  budget = Math.max(0, budget - (renderedProjectMemory?.length ?? 0));
  const relatedFiles: Array<{ path: string; content: string }> = [];
  const related = groupKeys
    .filter((key) => key !== ownKey)
    .map((key) => overlay.files.get(key)!)
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const file of related) {
    if (file.content.length > budget) continue;
    relatedFiles.push({ path: file.path, content: file.content });
    budget -= file.content.length;
  }
  return {
    unit,
    targetPath: unit.kind === "file" ? unit.outputPath! : unit.sourcePath,
    currentCode,
    diagnostics: normalized,
    hints,
    relatedFiles,
    ...(renderedProjectMemory ? { projectMemory: renderedProjectMemory } : {}),
  };
}
