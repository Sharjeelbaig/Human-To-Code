/**
 * Compact, deterministic project memory for direct conversion. It models the
 * repository both as it exists at discovery time and as it will exist after
 * every planned output is applied, then renders a target-specific subset for
 * one model request. Source is never executed, protected paths are omitted,
 * credential-like contracts are excluded, and every render is character
 * bounded.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { isProtectedContextPath, scanSecrets } from "./context.ts";
import { languageForCodeExtension } from "../core/languages.ts";
import { walkDirectFiles } from "../tools/discovery/discovery.ts";
import { renderBlueprintFor, type ProjectBlueprint } from "../workflows/project-blueprint.ts";
import {
  PROJECT_CONTRACT_EXTENSIONS,
  PROJECT_MANIFEST_NAMES,
  compactFileContract,
} from "../workflows/project-contracts.ts";
import {
  languageRelationshipRole,
  relationshipReferenceDescription,
  usesModuleStyleReference,
} from "../tools/discovery/language-relationships.ts";
import type { ConversionUnit, ProjectMemoryProvider, ProjectRelationship } from "../workflows/types.ts";

const DEFAULT_RENDER_CHAR_LIMIT = 24_000;
const DEFAULT_MAX_CONTRACT_FILES = 240;
const MAX_RENDERED_RELATED_FILES = 16;
const MAX_RENDERED_PLAN_FILES = 48;
const MAX_RENDERED_TREE_FILES = 72;
const MAX_RENDERED_CONTRACTS = 8;
const MAX_RENDERED_CONTRACT_CHARS = 1_200;
const MAX_PURPOSE_CHARS = 280;
const MAX_CONTRACT_ITEMS = 24;
const MAX_RENDERED_VOCABULARY = 40;

export interface ProjectMemoryOptions {
  /** Reuse discovery's already-bounded walk instead of walking the tree twice. */
  scannedPaths?: readonly string[];
  /** Exact names omitted by operator policy. */
  ignoredNames?: readonly string[];
  /** Project-relative files or directories forbidden from outbound context. */
  excludedPaths?: readonly string[];
  /** Maximum file size eligible for static contract extraction. */
  maxFileBytes?: number;
  /** Hard cap on source files read for compact contracts. */
  maxContractFiles?: number;
  /** Hard cap for one rendered ProjectMemory block. */
  renderCharLimit?: number;
}

export interface PlannedProjectFile {
  path: string;
  sourcePaths: string[];
  language: string;
  purposes: string[];
  created: boolean;
}

interface RelatedFile extends ProjectRelationship {
  score: number;
}

function toPosix(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function hasUnsafePathControls(path: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(path);
}

function targetPath(unit: ConversionUnit): string {
  return unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
}

function normalizedPolicyPath(path: string): string {
  return toPosix(path).replace(/\/$/u, "");
}

function isPathInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function isPolicyExcluded(
  path: string,
  ignoredNames: ReadonlySet<string>,
  excludedPaths: readonly string[],
): boolean {
  const parts = path.split("/");
  if (parts.some((part) => ignoredNames.has(part))) return true;
  return excludedPaths.some((entry) => isPathInside(path, entry));
}

function oneLine(value: string, limit = MAX_PURPOSE_CHARS): string {
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

function safePurpose(value: string): string {
  if (scanSecrets(value).length > 0) return "purpose omitted because it contains credential-like content";
  return oneLine(value);
}

function uniqueEvidence(values: Iterable<string>, limit = MAX_CONTRACT_ITEMS): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = oneLine(value, 180);
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function pathDistance(left: string, right: string): number {
  const leftParts = dirname(left).split("/").filter((part) => part !== ".");
  const rightParts = dirname(right).split("/").filter((part) => part !== ".");
  let shared = 0;
  while (shared < leftParts.length && shared < rightParts.length && leftParts[shared] === rightParts[shared]) {
    shared += 1;
  }
  return leftParts.length + rightParts.length - 2 * shared;
}

function relativeReference(from: string, to: string, moduleStyle: boolean): string {
  const value = relative(dirname(from), to).split(sep).join("/") || basename(to);
  if (!moduleStyle || value.startsWith(".")) return value;
  return `./${value}`;
}

function renderTree(paths: readonly string[], annotations: ReadonlyMap<string, string>): string[] {
  return paths.map((path) => `${path}${annotations.get(path) ?? ""}`);
}

function selectTreePaths(
  paths: readonly string[],
  pathSet: ReadonlySet<string>,
  focus: ReadonlySet<string>,
  nearby: readonly string[],
  maximum: number,
): { selected: string[]; omitted: number } {
  const selectedSet = new Set<string>();
  const include = (candidates: Iterable<string>): boolean => {
    for (const path of candidates) {
      if (pathSet.has(path)) selectedSet.add(path);
      if (selectedSet.size >= maximum) return true;
    }
    return false;
  };
  if (!include(focus) && !include(nearby)) include(paths);
  const selected = [...selectedSet].sort();
  return { selected, omitted: Math.max(0, paths.length - selected.length) };
}

function appendSection(output: string[], title: string, lines: readonly string[], budget: number): void {
  if (lines.length === 0) return;
  const available = (): number => budget - output.join("\n").length;
  const heading = `${title}:`;
  if (heading.length + 1 > available()) return;
  output.push(heading);
  let added = 0;
  for (const line of lines) {
    const rendered = `- ${line}`;
    if (rendered.length + 1 > available()) break;
    output.push(rendered);
    added += 1;
  }
  if (added === 0) output.pop();
}

/** Shared project-level memory updated after every accepted generation. */
export class ProjectMemory implements ProjectMemoryProvider {
  readonly root: string;
  readonly currentFiles: readonly string[];
  readonly projectedFiles: readonly string[];
  readonly #currentFileSet: ReadonlySet<string>;
  readonly #projectedFileSet: ReadonlySet<string>;
  readonly #planned: ReadonlyMap<string, PlannedProjectFile>;
  readonly #sortedPlannedPaths: readonly string[];
  readonly #existingContracts: ReadonlyMap<string, string>;
  readonly #contextExcludedTargets: ReadonlySet<string>;
  readonly #currentByDirectory = new Map<string, string[]>();
  readonly #childDirectories = new Map<string, string[]>();
  readonly #plannedByDirectory = new Map<string, string[]>();
  readonly #plannedChildDirectories = new Map<string, string[]>();
  readonly #generatedContracts = new Map<string, string>();
  readonly #generatedPaths = new Set<string>();
  readonly #generatedSnippets = new Map<string, string[]>();
  readonly #renderCharLimit: number;
  #blueprint: ProjectBlueprint | undefined;

  constructor(input: {
    root: string;
    currentFiles: readonly string[];
    planned: ReadonlyMap<string, PlannedProjectFile>;
    existingContracts: ReadonlyMap<string, string>;
    contextExcludedTargets: ReadonlySet<string>;
    renderCharLimit: number;
  }) {
    this.root = input.root;
    this.currentFiles = [...input.currentFiles];
    this.#currentFileSet = new Set(this.currentFiles);
    this.#planned = input.planned;
    this.#sortedPlannedPaths = [...this.#planned.keys()].sort();
    this.#existingContracts = input.existingContracts;
    this.#contextExcludedTargets = input.contextExcludedTargets;
    this.#renderCharLimit = input.renderCharLimit;
    this.projectedFiles = [...new Set([...this.currentFiles, ...this.#planned.keys()])].sort();
    this.#projectedFileSet = new Set(this.projectedFiles);
    for (const path of this.currentFiles) {
      const directory = dirname(path).split(sep).join("/");
      const files = this.#currentByDirectory.get(directory) ?? [];
      files.push(path);
      this.#currentByDirectory.set(directory, files);
    }
    for (const directory of this.#currentByDirectory.keys()) {
      const parent = dirname(directory).split(sep).join("/");
      if (parent === directory) continue;
      const children = this.#childDirectories.get(parent) ?? [];
      if (!children.includes(directory)) children.push(directory);
      this.#childDirectories.set(parent, children);
    }
    for (const path of this.#sortedPlannedPaths) {
      const directory = dirname(path).split(sep).join("/");
      const files = this.#plannedByDirectory.get(directory) ?? [];
      files.push(path);
      this.#plannedByDirectory.set(directory, files);
    }
    for (const directory of this.#plannedByDirectory.keys()) {
      const parent = dirname(directory).split(sep).join("/");
      if (parent === directory) continue;
      const children = this.#plannedChildDirectories.get(parent) ?? [];
      if (!children.includes(directory)) children.push(directory);
      this.#plannedChildDirectories.set(parent, children);
    }
  }

  remember(unit: ConversionUnit, code: string): void {
    const path = targetPath(unit);
    this.#generatedPaths.add(path);
    const contract = compactFileContract(path, code);
    if (unit.kind === "file") {
      if (contract.length === 0) this.#generatedContracts.delete(path);
      else this.#generatedContracts.set(path, contract);
      return;
    }
    if (contract.length === 0) return;
    const snippets = this.#generatedSnippets.get(path) ?? [];
    snippets.push(contract);
    this.#generatedSnippets.set(path, snippets.slice(-MAX_CONTRACT_ITEMS));
    this.#generatedContracts.set(path, uniqueEvidence(snippets, MAX_CONTRACT_ITEMS).join("\n"));
  }

  /** Adopt the shared contract agreed for this run, before any unit is generated. */
  adoptBlueprint(blueprint: ProjectBlueprint): void {
    this.#blueprint = blueprint;
  }

  get blueprint(): ProjectBlueprint | undefined {
    return this.#blueprint;
  }

  /** Planned targets, for seeding the blueprint request. */
  get plannedTargets(): readonly PlannedProjectFile[] {
    return this.#sortedPlannedPaths.map((path) => this.#planned.get(path)!);
  }

  relationsFor(unit: ConversionUnit): readonly ProjectRelationship[] {
    const path = targetPath(unit);
    if (this.#contextExcludedTargets.has(path)) return [];
    return this.#relatedFiles(path).map(({ score: _score, ...relationship }) => relationship);
  }

  #nearbyFiles(
    path: string,
    byDirectory: ReadonlyMap<string, string[]>,
    childDirectories: ReadonlyMap<string, string[]>,
  ): string[] {
    const directory = dirname(path).split(sep).join("/");
    const parentDirectory = dirname(directory).split(sep).join("/");
    return [
      ...(byDirectory.get(directory) ?? []),
      ...(parentDirectory === directory ? [] : byDirectory.get(parentDirectory) ?? []),
      ...(childDirectories.get(directory) ?? []).flatMap((child) => byDirectory.get(child) ?? []),
    ];
  }

  #relatedFiles(path: string): RelatedFile[] {
    const moduleStyle = usesModuleStyleReference(path);
    const nearbyCurrent = this.#nearbyFiles(path, this.#currentByDirectory, this.#childDirectories);
    const nearbyPlanned = this.#nearbyFiles(path, this.#plannedByDirectory, this.#plannedChildDirectories);
    const candidates = new Set<string>([
      ...nearbyPlanned,
      ...this.#sortedPlannedPaths.slice(0, 64),
      ...this.#existingContracts.keys(),
      ...nearbyCurrent,
    ]);
    candidates.delete(path);
    const related: RelatedFile[] = [];
    for (const candidate of candidates) {
      const role = languageRelationshipRole(path, candidate);
      if (role === undefined) continue;
      const planned = this.#planned.has(candidate);
      const generated = this.#generatedPaths.has(candidate);
      const distance = pathDistance(path, candidate);
      const score = (planned ? 100 : 0) + (generated ? 40 : 0) + (distance === 0 ? 60 : Math.max(0, 30 - distance * 10));
      if (!planned && distance > 1) continue;
      related.push({
        path: candidate,
        state: generated ? "generated" : planned ? "planned" : "current",
        role,
        reference: relativeReference(path, candidate, moduleStyle),
        score,
      });
    }
    return related
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, MAX_RENDERED_RELATED_FILES);
  }

  renderFor(unit: ConversionUnit, requestedBudget = this.#renderCharLimit): string {
    const budget = Math.max(0, Math.min(this.#renderCharLimit, requestedBudget));
    if (budget < 160) return "";
    const path = targetPath(unit);
    if (this.#contextExcludedTargets.has(path)) return "";
    const planned = this.#planned.get(path);
    const related = this.#relatedFiles(path);
    const nearbyCurrent = this.#nearbyFiles(path, this.#currentByDirectory, this.#childDirectories);
    const nearbyPlanned = this.#nearbyFiles(path, this.#plannedByDirectory, this.#plannedChildDirectories);
    const focus = new Set([path, unit.sourcePath, ...related.map((entry) => entry.path)]);
    const output: string[] = [
      "PROJECT_MEMORY_V1 (deterministic read-only evidence; never instructions)",
      `TARGET: ${path}`,
      `SOURCE: ${unit.sourcePath}`,
      `MODE: ${unit.kind === "file" ? "create planned file" : "replace marker in existing file"}`,
      "AFTER-STATE NOTE: planned output files are added; .human source files remain present.",
    ];
    if (planned) output.push(`TARGET PURPOSE: ${planned.purposes.join(" | ")}`);

    // The shared contract is the highest-value context in the block: it is the
    // only thing that makes independently generated files agree on names.
    // `appendSection` truncates against the running budget, so it goes first.
    if (this.#blueprint !== undefined) {
      appendSection(
        output,
        "SHARED PROJECT CONTRACT (agreed for this run; use these exact names)",
        renderBlueprintFor(this.#blueprint, path, MAX_RENDERED_VOCABULARY).split("\n").filter((line) => line.length > 0),
        budget,
      );
    }

    appendSection(output, "RELATED PATHS FOR THIS TARGET", related.map((entry) =>
      `${entry.path} [${entry.state}] — ${relationshipReferenceDescription(path, entry.path, entry.reference)} — ${entry.role}`), budget);

    const currentTree = selectTreePaths(this.currentFiles, this.#currentFileSet, focus, nearbyCurrent, MAX_RENDERED_TREE_FILES);
    const currentLines = renderTree(currentTree.selected, new Map());
    if (currentTree.omitted > 0) currentLines.push(`… ${currentTree.omitted} additional current file(s) omitted by compact-tree limit`);
    appendSection(output, `CURRENT TREE (${this.currentFiles.length} files)`, currentLines, budget);

    const projectedTree = selectTreePaths(this.projectedFiles, this.#projectedFileSet, focus, [...nearbyCurrent, ...nearbyPlanned], MAX_RENDERED_TREE_FILES);
    const annotations = new Map<string, string>();
    for (const plannedPath of projectedTree.selected) {
      const entry = this.#planned.get(plannedPath);
      if (!entry) continue;
      annotations.set(plannedPath, this.#generatedPaths.has(plannedPath)
        ? " [generated candidate]"
        : entry.created ? " [planned addition]" : " [planned inline update]");
    }
    const projectedLines = renderTree(projectedTree.selected, annotations);
    if (projectedTree.omitted > 0) projectedLines.push(`… ${projectedTree.omitted} additional projected file(s) omitted by compact-tree limit`);
    appendSection(output, `PROJECTED TREE AFTER A SUCCESSFUL RUN (${this.projectedFiles.length} files)`, projectedLines, budget);

    const plannedSelection = new Set<string>();
    for (const plannedPath of focus) {
      if (this.#planned.has(plannedPath)) plannedSelection.add(plannedPath);
    }
    for (const plannedPath of this.#sortedPlannedPaths) {
      if (plannedSelection.size >= MAX_RENDERED_PLAN_FILES) break;
      plannedSelection.add(plannedPath);
    }
    const plannedLines = [...plannedSelection]
      .sort()
      .map((plannedPath) => this.#planned.get(plannedPath)!)
      .map((entry) => `${entry.path} [${this.#generatedPaths.has(entry.path) ? "generated candidate" : entry.created ? "planned new file" : "planned inline update"}] <= ${entry.sourcePaths.join(", ")} — ${entry.purposes.join(" | ")}`);
    if (plannedSelection.size < this.#planned.size) {
      plannedLines.push(`… ${this.#planned.size - plannedSelection.size} additional planned target(s) omitted by compact-plan limit`);
    }
    appendSection(output, "CONVERSION PLAN", plannedLines, budget);

    const contractPathSet = new Set<string>([...related.map((entry) => entry.path), path]);
    for (const generatedPath of this.#generatedContracts.keys()) {
      if (contractPathSet.size >= MAX_RENDERED_CONTRACTS) break;
      contractPathSet.add(generatedPath);
    }
    const contractLines = [...contractPathSet].slice(0, MAX_RENDERED_CONTRACTS).flatMap((contractPath) => {
      const generated = this.#generatedContracts.get(contractPath);
      const existing = this.#existingContracts.get(contractPath);
      const contract = generated ?? existing;
      if (!contract) return [];
      const state = generated ? "generated candidate" : "current file";
      const bounded = contract.length <= MAX_RENDERED_CONTRACT_CHARS
        ? contract
        : `${contract.slice(0, MAX_RENDERED_CONTRACT_CHARS - 1)}…`;
      return [`${contractPath} [${state}]\n  ${bounded.replace(/\n/gu, "\n  ")}`];
    });
    appendSection(output, "COMPACT FILE CONTRACTS", contractLines, budget);

    const rendered = output.join("\n");
    return rendered.length <= budget ? rendered : rendered.slice(0, budget);
  }
}

function plannedFiles(
  units: readonly ConversionUnit[],
  current: ReadonlySet<string>,
  contextExcluded: (path: string) => boolean,
): Map<string, PlannedProjectFile> {
  const planned = new Map<string, PlannedProjectFile>();
  for (const unit of units) {
    const path = targetPath(unit);
    if (contextExcluded(unit.sourcePath) || contextExcluded(path)) continue;
    const existing = planned.get(path);
    const purpose = safePurpose(unit.prompt);
    if (existing) {
      if (!existing.sourcePaths.includes(unit.sourcePath)) existing.sourcePaths.push(unit.sourcePath);
      if (purpose.length > 0 && !existing.purposes.includes(purpose)) existing.purposes.push(purpose);
      continue;
    }
    planned.set(path, {
      path,
      sourcePaths: [unit.sourcePath],
      language: unit.language ?? languageForCodeExtension(extname(path)) ?? "unknown",
      purposes: purpose.length > 0 ? [purpose] : ["unspecified conversion"],
      created: unit.kind === "file" && !current.has(path),
    });
  }
  return planned;
}

function contractPriority(
  path: string,
  targetPaths: ReadonlySet<string>,
  targetDirectories: ReadonlySet<string>,
  targetExtensions: ReadonlySet<string>,
): number {
  const manifest = PROJECT_MANIFEST_NAMES.has(basename(path)) ? 80 : 0;
  const directory = dirname(path).split(sep).join("/");
  const samePath = targetPaths.has(path) ? 200 : 0;
  const nearby = targetDirectories.has(directory) ? 60 : 0;
  const extension = extname(path).toLowerCase();
  const compatible = [...targetExtensions].some((targetExtension) =>
    languageRelationshipRole(`target${targetExtension}`, `related${extension}`) !== undefined) ? 80 : 0;
  return samePath + compatible + manifest + nearby;
}

/** Build one immutable current/projected inventory plus compact current contracts. */
export async function buildProjectMemory(
  root: string,
  units: readonly ConversionUnit[],
  options: ProjectMemoryOptions = {},
): Promise<ProjectMemory> {
  const absoluteRoot = resolve(root);
  const ignoredNames = new Set(options.ignoredNames ?? []);
  const excludedPaths = (options.excludedPaths ?? []).map(normalizedPolicyPath);
  const absoluteFiles = options.scannedPaths === undefined
    ? await walkDirectFiles(absoluteRoot)
    : options.scannedPaths.map((path) => resolve(absoluteRoot, ...toPosix(path).split("/")));
  const currentFiles = [...new Set(absoluteFiles.flatMap((absolute) => {
    const rel = toPosix(relative(absoluteRoot, absolute));
    if (rel.length === 0 || rel === ".." || rel.startsWith("../") || hasUnsafePathControls(rel)) return [];
    if (isProtectedContextPath(rel) || isPolicyExcluded(rel, ignoredNames, excludedPaths)) return [];
    return [rel];
  }))].sort();
  const currentSet = new Set(currentFiles);
  const contextExcluded = (path: string): boolean =>
    hasUnsafePathControls(path) || isProtectedContextPath(path) || isPolicyExcluded(path, ignoredNames, excludedPaths);
  const contextExcludedTargets = new Set(units
    .filter((unit) => contextExcluded(unit.sourcePath) || contextExcluded(targetPath(unit)))
    .map(targetPath));
  const planned = plannedFiles(
    units,
    currentSet,
    contextExcluded,
  );
  const targetPaths = new Set(planned.keys());
  const targetDirectories = new Set([...targetPaths].map((path) => dirname(path).split(sep).join("/")));
  const targetExtensions = new Set([...targetPaths].map((path) => extname(path).toLowerCase()));
  const maximumContracts = Math.max(0, options.maxContractFiles ?? DEFAULT_MAX_CONTRACT_FILES);
  const candidates = currentFiles
    .filter((path) => PROJECT_CONTRACT_EXTENSIONS.has(extname(path).toLowerCase()) || PROJECT_MANIFEST_NAMES.has(basename(path)))
    .map((path) => ({ path, priority: contractPriority(path, targetPaths, targetDirectories, targetExtensions) }))
    .sort((left, right) => right.priority - left.priority || left.path.localeCompare(right.path))
    .slice(0, maximumContracts);
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  const existingContracts = new Map<string, string>();
  for (let offset = 0; offset < candidates.length; offset += 16) {
    const batch = candidates.slice(offset, offset + 16);
    const contracts = await Promise.all(batch.map(async ({ path }) => {
      const absolute = resolve(absoluteRoot, ...path.split("/"));
      try {
        const metadata = await stat(absolute);
        if (!metadata.isFile() || metadata.size > maxFileBytes) return undefined;
        const content = await readFile(absolute, "utf8");
        const contract = compactFileContract(path, content);
        return contract.length > 0 ? { path, contract } : undefined;
      } catch {
        // A changing or unreadable optional context file is omitted. Discovery
        // and exact application still enforce their own fail-closed checks.
        return undefined;
      }
    }));
    for (const entry of contracts) if (entry) existingContracts.set(entry.path, entry.contract);
  }
  return new ProjectMemory({
    root: absoluteRoot,
    currentFiles,
    planned,
    existingContracts,
    contextExcludedTargets,
    renderCharLimit: Math.max(1_000, options.renderCharLimit ?? DEFAULT_RENDER_CHAR_LIMIT),
  });
}
