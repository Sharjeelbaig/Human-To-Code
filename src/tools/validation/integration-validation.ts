/**
 * Optional, bounded, cross-language integration auditing. ProjectMemory owns
 * relationship discovery; this module is language-agnostic orchestration over
 * generated paths, compact contracts, a strict JSON audit, target-scoped
 * repairs, and one verification audit. No application/framework scenario is
 * embedded here.
 */
import { posix } from "node:path";
import { ContextSecurityError, scanSecrets } from "../../memory/context.ts";
import type {
  DirectIntegrationAuditFile,
  DirectIntegrationIssue,
  DirectIntegrationRelationship,
} from "../../prompts/direct-integration.ts";
import { validateGeneratedUnit } from "./candidate-validation.ts";
import { compactFileContract } from "../../workflows/project-contracts.ts";
import {
  unitOwnsCompleteFile,
  type ConversionUnit,
  type GeneratedConversionUnit,
  type ProjectMemoryProvider,
  type ProjectRelationship,
} from "../../workflows/types.ts";

export interface IntegrationAuditRequest {
  /** Representative unit used for provider defaults and target-specific memory. */
  unit: ConversionUnit;
  units: ConversionUnit[];
  files: DirectIntegrationAuditFile[];
  relationships: DirectIntegrationRelationship[];
  projectMemory?: string;
}

export interface IntegrationRepairRequest {
  unit: ConversionUnit;
  targetPath: string;
  instruction: string;
  currentCode: string;
  issues: DirectIntegrationIssue[];
  relatedFiles: Array<{ path: string; content: string }>;
  projectMemory?: string;
}

export interface IntegrationAuditResult {
  status: "consistent" | "issues";
  issues: DirectIntegrationIssue[];
}

export type IntegrationProgress =
  | { kind: "integration-audit"; unit: ConversionUnit; pass: number; files: number }
  | { kind: "integration-repair"; unit: ConversionUnit; attempt: number; issues: number }
  | { kind: "reject"; unit: ConversionUnit; reason: string };

export interface IntegrationValidationOptions {
  audit?: (request: IntegrationAuditRequest) => Promise<string>;
  repair?: (request: IntegrationRepairRequest) => Promise<string>;
  /** Initial audit plus one verification audit by default. */
  maxAuditPassesPerGroup?: number;
  /** One target-scoped repair per generated file by default. */
  maxRepairAttemptsPerUnit?: number;
  contextCharBudget?: number;
  projectMemory?: ProjectMemoryProvider;
  onProgress?: (event: IntegrationProgress) => void;
}

export interface IntegrationValidationOutcome {
  results: GeneratedConversionUnit[];
  auditRequests: number;
  repairRequests: number;
  checkedGroups: number;
}

interface RelationshipGroup {
  units: ConversionUnit[];
  relationships: DirectIntegrationRelationship[];
}

const DEFAULT_CONTEXT_CHAR_BUDGET = 48_000;
const MAX_COMPONENT_FILES = 24;
const MAX_NEIGHBORHOOD_FILES = 17;
const MAX_CONTRACT_CHARS = 2_000;
const MAX_PURPOSE_CHARS = 400;
const MAX_AUDIT_ISSUES = 64;
const MAX_ISSUE_MESSAGE_CHARS = 600;

function targetPath(unit: ConversionUnit): string {
  return unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
}

function oneLine(value: string, limit: number): string {
  const clean = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

function ownKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly validate the model's audit JSON against the exact generated group. */
export function parseIntegrationAuditOutput(
  output: string,
  allowedPaths: ReadonlySet<string>,
): IntegrationAuditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Integration auditor returned invalid JSON.");
  }
  if (!object(parsed) || !ownKeys(parsed, ["issues", "status"])) {
    throw new Error("Integration audit must contain exactly status and issues.");
  }
  if (parsed.status !== "consistent" && parsed.status !== "issues") {
    throw new Error("Integration audit status must be consistent or issues.");
  }
  if (!Array.isArray(parsed.issues) || parsed.issues.length > MAX_AUDIT_ISSUES) {
    throw new Error(`Integration audit issues must be an array with at most ${MAX_AUDIT_ISSUES} entries.`);
  }
  const issues: DirectIntegrationIssue[] = parsed.issues.map((value, index) => {
    if (!object(value) || !ownKeys(value, ["code", "message", "relatedPaths", "targetPath"])) {
      throw new Error(`Integration audit issue ${index} has unknown or missing fields.`);
    }
    if (typeof value.targetPath !== "string" || !allowedPaths.has(value.targetPath)) {
      throw new Error(`Integration audit issue ${index} names an unknown targetPath.`);
    }
    if (!Array.isArray(value.relatedPaths) || value.relatedPaths.length === 0 || value.relatedPaths.length > 16) {
      throw new Error(`Integration audit issue ${index} must name 1-16 relatedPaths.`);
    }
    const relatedPaths = value.relatedPaths.map((path) => {
      if (typeof path !== "string" || path === value.targetPath || !allowedPaths.has(path)) {
        throw new Error(`Integration audit issue ${index} names an unknown related path.`);
      }
      return path;
    });
    if (new Set(relatedPaths).size !== relatedPaths.length) {
      throw new Error(`Integration audit issue ${index} repeats a related path.`);
    }
    if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.code)) {
      throw new Error(`Integration audit issue ${index} has an invalid code.`);
    }
    if (typeof value.message !== "string") {
      throw new Error(`Integration audit issue ${index} has an invalid message.`);
    }
    const message = oneLine(value.message, MAX_ISSUE_MESSAGE_CHARS);
    if (message.length === 0) throw new Error(`Integration audit issue ${index} has an empty message.`);
    return { targetPath: value.targetPath, relatedPaths, code: value.code, message };
  });
  if (parsed.status === "consistent" && issues.length !== 0 || parsed.status === "issues" && issues.length === 0) {
    throw new Error("Integration audit status contradicts its issues array.");
  }
  return { status: parsed.status, issues };
}

function relationshipGroups(
  generated: readonly GeneratedConversionUnit[],
  projectMemory?: ProjectMemoryProvider,
): RelationshipGroup[] {
  const wholeFiles = generated.filter((item) => item.contextOnly !== true && unitOwnsCompleteFile(item.unit));
  const byPath = new Map(wholeFiles.map((item) => [targetPath(item.unit), item.unit]));
  const adjacency = new Map<string, Set<string>>([...byPath.keys()].map((path) => [path, new Set()]));
  const relationships = new Map<string, DirectIntegrationRelationship>();
  for (const { unit } of wholeFiles) {
    const fromPath = targetPath(unit);
    const evidenced = projectMemory?.relationsFor?.(unit) ?? [];
    for (const relationship of evidenced) {
      if (!byPath.has(relationship.path) || relationship.path === fromPath) continue;
      adjacency.get(fromPath)!.add(relationship.path);
      adjacency.get(relationship.path)!.add(fromPath);
      const entry = {
        fromPath,
        toPath: relationship.path,
        role: oneLine(relationship.role, 240),
        reference: oneLine(relationship.reference, 240),
      };
      relationships.set(`${entry.fromPath}\0${entry.toPath}`, entry);
    }
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const start of [...byPath.keys()].sort()) {
    if (visited.has(start) || adjacency.get(start)!.size === 0) continue;
    const queue = [start];
    const component: string[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const path = queue.shift()!;
      component.push(path);
      for (const next of adjacency.get(path) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(component.sort());
  }

  const pathGroups: string[][] = [];
  for (const component of components) {
    if (component.length <= MAX_COMPONENT_FILES) {
      pathGroups.push(component);
      continue;
    }
    const seen = new Set<string>();
    for (const focus of component) {
      const neighborhood = [focus, ...[...(adjacency.get(focus) ?? [])].sort()]
        .slice(0, MAX_NEIGHBORHOOD_FILES)
        .sort();
      const key = neighborhood.join("\0");
      if (neighborhood.length < 2 || seen.has(key)) continue;
      seen.add(key);
      pathGroups.push(neighborhood);
    }
  }

  return pathGroups.map((paths) => {
    const pathSet = new Set(paths);
    const groupRelationships = [...relationships.values()]
      .filter((entry) => pathSet.has(entry.fromPath) && pathSet.has(entry.toPath))
      .sort((left, right) => left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath));
    return { units: paths.map((path) => byPath.get(path)!), relationships: groupRelationships };
  });
}

/** Conservative pre-run ceiling: two audits and one repair per whole-file unit. */
export function potentialIntegrationRequests(units: readonly ConversionUnit[]): {
  auditUpTo: number;
  repairUpTo: number;
} {
  const files = units.filter(unitOwnsCompleteFile).length;
  return files < 2 ? { auditUpTo: 0, repairUpTo: 0 } : { auditUpTo: files * 2, repairUpTo: files };
}

function groupProjectMemory(
  group: RelationshipGroup,
  projectMemory: ProjectMemoryProvider | undefined,
  budget: number,
): string | undefined {
  if (!projectMemory || budget < 160) return undefined;
  const perUnit = Math.max(160, Math.floor(budget / Math.max(1, group.units.length)));
  const rendered: string[] = [];
  let remaining = budget;
  for (const unit of group.units) {
    if (remaining < 160) break;
    const block = projectMemory.renderFor(unit, Math.min(perUnit, remaining));
    if (block.length === 0 || rendered.includes(block)) continue;
    rendered.push(block);
    remaining -= block.length;
  }
  return rendered.length > 0 ? rendered.join("\n\n") : undefined;
}

function buildAuditRequest(
  group: RelationshipGroup,
  byUnit: ReadonlyMap<ConversionUnit, GeneratedConversionUnit>,
  contextCharBudget: number,
  projectMemory?: ProjectMemoryProvider,
): IntegrationAuditRequest | undefined {
  const baseFiles = group.units.map((unit) => {
    const item = byUnit.get(unit)!;
    const path = targetPath(unit);
    const contract = compactFileContract(path, item.code).slice(0, MAX_CONTRACT_CHARS);
    return {
      path,
      language: unit.language ?? (posix.extname(path).replace(/^\./u, "") || "unknown"),
      instruction: oneLine(unit.prompt, MAX_PURPOSE_CHARS),
      contract,
      code: item.code,
    };
  });
  const fixedChars = baseFiles.reduce((total, file) => total + file.path.length + file.language.length + file.instruction.length + file.contract.length + 120, 0)
    + group.relationships.reduce((total, relation) => total + relation.fromPath.length + relation.toPath.length + relation.role.length + relation.reference.length + 40, 0);
  if (fixedChars > contextCharBudget) return undefined;
  let remaining = contextCharBudget - fixedChars;
  const projectBlock = groupProjectMemory(group, projectMemory, Math.floor(remaining / 3));
  remaining -= projectBlock?.length ?? 0;
  const files: DirectIntegrationAuditFile[] = [];
  for (const file of baseFiles) {
    const content = file.code.length <= remaining ? file.code : undefined;
    files.push({
      path: file.path,
      language: file.language,
      instruction: file.instruction,
      contract: file.contract,
      ...(content !== undefined ? { content } : {}),
    });
    if (content !== undefined) remaining -= content.length;
  }
  return {
    unit: group.units[0]!,
    units: [...group.units],
    files,
    relationships: [...group.relationships],
    ...(projectBlock ? { projectMemory: projectBlock } : {}),
  };
}

function buildRepairRequest(
  unit: ConversionUnit,
  issues: DirectIntegrationIssue[],
  byUnit: ReadonlyMap<ConversionUnit, GeneratedConversionUnit>,
  contextCharBudget: number,
  projectMemory?: ProjectMemoryProvider,
): IntegrationRepairRequest | undefined {
  const item = byUnit.get(unit)!;
  const issueChars = issues.reduce((total, issue) => total + issue.code.length + issue.message.length + issue.relatedPaths.join("").length + 48, 0);
  let remaining = contextCharBudget - item.code.length - issueChars;
  if (remaining < 0) return undefined;
  const projectBlock = projectMemory?.renderFor(unit, Math.floor(remaining / 3));
  remaining -= projectBlock?.length ?? 0;
  const relatedPaths = [...new Set(issues.flatMap((issue) => issue.relatedPaths))].sort();
  const relatedFiles: Array<{ path: string; content: string }> = [];
  for (const path of relatedPaths) {
    const related = [...byUnit.values()].find((entry) => targetPath(entry.unit) === path);
    if (!related || related.code.length > remaining) continue;
    relatedFiles.push({ path, content: related.code });
    remaining -= related.code.length;
  }
  return {
    unit,
    targetPath: targetPath(unit),
    instruction: unit.prompt,
    currentCode: item.code,
    issues,
    relatedFiles,
    ...(projectBlock ? { projectMemory: projectBlock } : {}),
  };
}

function auditOutbound(request: IntegrationAuditRequest): string {
  return [
    request.projectMemory ?? "",
    ...request.files.flatMap((file) => [file.path, file.language, file.instruction, file.contract, file.content ?? ""]),
    ...request.relationships.flatMap((relationship) => [
      relationship.fromPath,
      relationship.toPath,
      relationship.role,
      relationship.reference,
    ]),
  ].join("\n");
}

function repairOutbound(request: IntegrationRepairRequest): string {
  return [
    request.targetPath,
    request.instruction,
    request.currentCode,
    request.projectMemory ?? "",
    ...request.issues.flatMap((issue) => [
      issue.targetPath,
      ...issue.relatedPaths,
      issue.code,
      issue.message,
    ]),
    ...request.relatedFiles.flatMap((file) => [file.path, file.content]),
  ].join("\n");
}

/** Audit, repair, and verify generated relationship groups without writing. */
export async function reconcileGeneratedIntegrations(
  generated: readonly GeneratedConversionUnit[],
  options: IntegrationValidationOptions = {},
): Promise<IntegrationValidationOutcome> {
  const results = generated.map((item) => ({ ...item }));
  const byUnit = new Map(results.map((item) => [item.unit, item]));
  const groups = relationshipGroups(results, options.projectMemory);
  const maxAuditPasses = Math.max(1, Math.min(2, options.maxAuditPassesPerGroup ?? 2));
  const maxRepairs = Math.max(0, options.maxRepairAttemptsPerUnit ?? 1);
  const contextCharBudget = Math.max(0, options.contextCharBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET);
  const repairedUnits = new Set<ConversionUnit>();
  let auditRequests = 0;
  let repairRequests = 0;

  const rejectGroup = (group: RelationshipGroup, reason: string): void => {
    for (const unit of group.units) {
      const item = byUnit.get(unit);
      if (!item || item.error !== undefined) continue;
      item.error = reason;
      item.code = "";
      options.onProgress?.({ kind: "reject", unit, reason });
    }
  };

  for (const group of groups) {
    const unavailable = group.units.map((unit) => byUnit.get(unit)!)
      .filter((item) => item.contextOnly !== true && (item.error !== undefined || item.code.trim().length === 0));
    if (unavailable.length > 0) {
      rejectGroup(group, `cross-file integration group is incomplete because ${unavailable.map((item) => item.unit.sourcePath).join(", ")} did not produce an applicable candidate`);
      continue;
    }
    if (!options.audit) continue;

    const runAudit = async (pass: number): Promise<IntegrationAuditResult | undefined> => {
      const request = buildAuditRequest(group, byUnit, contextCharBudget, options.projectMemory);
      if (!request || scanSecrets(auditOutbound(request)).length > 0) return undefined;
      options.onProgress?.({ kind: "integration-audit", unit: request.unit, pass, files: request.files.length });
      auditRequests += 1;
      try {
        return parseIntegrationAuditOutput(await options.audit!(request), new Set(group.units.map(targetPath)));
      } catch (error) {
        if (error instanceof ContextSecurityError) throw error;
        return undefined;
      }
    };

    const initial = await runAudit(1);
    if (!initial) {
      rejectGroup(group, "cross-file integration audit failed or exceeded its safe bounded context");
      continue;
    }
    if (initial.status === "consistent") continue;
    if (!options.repair || maxRepairs === 0) {
      rejectGroup(group, `cross-file integration audit reported ${initial.issues.length} unresolved issue(s)`);
      continue;
    }

    let repaired = true;
    const byTarget = new Map<string, DirectIntegrationIssue[]>();
    for (const issue of initial.issues) byTarget.set(issue.targetPath, [...(byTarget.get(issue.targetPath) ?? []), issue]);
    for (const [path, issues] of byTarget) {
      const unit = group.units.find((candidate) => targetPath(candidate) === path)!;
      if (repairedUnits.has(unit)) {
        repaired = false;
        break;
      }
      const request = buildRepairRequest(unit, issues, byUnit, contextCharBudget, options.projectMemory);
      if (!request || scanSecrets(repairOutbound(request)).length > 0) {
        repaired = false;
        break;
      }
      options.onProgress?.({ kind: "integration-repair", unit, attempt: 1, issues: issues.length });
      repairRequests += 1;
      repairedUnits.add(unit);
      try {
        const code = await options.repair(request);
        if (code.trim().length === 0 || code === byUnit.get(unit)!.code) {
          repaired = false;
          break;
        }
        await validateGeneratedUnit(unit, code);
        byUnit.get(unit)!.code = code;
        options.projectMemory?.remember(unit, code);
      } catch (error) {
        if (error instanceof ContextSecurityError) throw error;
        repaired = false;
        break;
      }
    }
    if (!repaired) {
      rejectGroup(group, "cross-file integration repair failed within its bounded target budget");
      continue;
    }
    if (maxAuditPasses < 2) continue;
    const verified = await runAudit(2);
    if (!verified || verified.status !== "consistent") {
      rejectGroup(group, "cross-file integration remained inconsistent after bounded repair and verification");
    }
  }

  return { results, auditRequests, repairRequests, checkedGroups: groups.length };
}

/** Helper for tests and alternative ProjectMemory implementations. */
export function generatedRelationshipsFor(
  unit: ConversionUnit,
  projectMemory: ProjectMemoryProvider,
): readonly ProjectRelationship[] {
  return projectMemory.relationsFor?.(unit) ?? [];
}
