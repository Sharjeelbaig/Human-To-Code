/**
 * Deterministically explains and diagnoses unresolved facets on conversion units.
 */
import { extname } from "node:path";
import type { ConversionUnit } from "../../workflows/types.ts";
import {
  REQUIREMENT_RULES,
  type DiagnosticSeverity,
  type RequirementRule,
} from "./requirement-rules.ts";

export interface UnresolvedFacet {
  id: string;
  question: string;
  example: string;
}

export interface SpecDiagnostic {
  code: "E-UNDERSPECIFIED" | "E-IMPORT-UNRESOLVED";
  rule: string;
  severity: DiagnosticSeverity;
  sourcePath: string;
  line?: number;
  targetPath: string;
  message: string;
  facets: UnresolvedFacet[];
}

export interface FacetResolution {
  id: string;
  question: string;
  example: string;
  satisfied: boolean;
}

export interface SpecExplanation {
  rule: string;
  sourcePath: string;
  line?: number;
  targetPath: string;
  facets: FacetResolution[];
}

export interface DiagnoseOptions {
  vocabulary?: Readonly<Record<string, string>>;
}

function targetPath(unit: ConversionUnit): string {
  return unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
}

function vocabularyTerms(
  vocabulary: Readonly<Record<string, string>> | undefined,
): ReadonlySet<string> {
  return new Set(
    Object.keys(vocabulary ?? {}).map((term) => term.trim().toLocaleLowerCase()),
  );
}

function applies(rule: RequirementRule, unit: ConversionUnit): boolean {
  rule.trigger.lastIndex = 0;
  if (!rule.trigger.test(unit.prompt.slice(0, 32_000))) return false;
  if (
    ["sort", "limit", "endpoint"].includes(rule.id)
    && isAlgorithmicProblemPrompt(unit.prompt)
  ) return false;
  if (rule.extensions === undefined || rule.extensions.length === 0) return true;
  return rule.extensions.includes(extname(targetPath(unit)).toLocaleLowerCase());
}

function describeRule(rule: string): string {
  if (rule === "subjective") return "a subjective change";
  if (rule === "limit") return "a timeout, retry, or limit";
  if (rule === "endpoint" || rule === "animation") return `an ${rule}`;
  return `a ${rule}`;
}

/**
 * UI facets need product-specific details; algorithm prompts use overlapping
 * words such as "sort" and "limit" as behavioral requirements and often omit
 * those UI details. Keep the facet gate from blocking data-structure work.
 */
function isAlgorithmicProblemPrompt(prompt: string): boolean {
  return /\b(?:algorithm|pseudocode|leetcode|hacker\s*rank|coding\s+challenge|competitive\s+programming)\b/iu.test(prompt)
    || /\b(?:arrays?|vectors?|matrices?|subarrays?|substrings?|nums|indices|in[- ]place|complexity|linked\s+lists?|graphs?|trees?|vertices|nodes)\b/iu.test(prompt);
}

function missingPhrase(rule: string, facet: UnresolvedFacet): string {
  if (rule === "sort" && facet.id === "direction") {
    return "whether it is ascending or descending";
  }
  const phrases: Readonly<Record<string, string>> = {
    colors: "which colors it uses",
    direction: "the direction or angle",
    target: "what it applies to",
    chartType: "which kind",
    dataSource: "what data it uses",
    label: "what it says",
    action: "what it does",
    placement: "where it belongs",
    property: "what changes",
    duration: "how long it lasts",
    easing: "which easing it uses",
    trigger: "what starts it",
    fields: "which fields it contains",
    validation: "how its fields are validated",
    submitTarget: "where it submits",
    method: "the HTTP method",
    path: "the path",
    request: "the request shape",
    response: "what it returns",
    errors: "which errors it handles",
    items: "how many items it has or where they come from",
    content: "what each item contains",
    key: "which field to use",
    breakpoints: "the breakpoints",
    changes: "what changes at each breakpoint",
    value: "the exact value",
    family: "the font family",
    size: "the font size",
    weight: "the font weight",
    specificChanges: "what specifically should change",
    columns: "which columns it has",
    rowsOrDataSource: "how many rows it has or where they come from",
    cellContent: "what each cell contains",
    labels: "the axes or series labels",
  };
  return phrases[facet.id] ?? facet.question.replace(/\?$/u, "").toLocaleLowerCase();
}

function naturalList(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function diagnosticMessage(
  rule: RequirementRule,
  facets: readonly UnresolvedFacet[],
): string {
  const missing = facets.map((item) => missingPhrase(rule.id, item));
  return `You asked for ${describeRule(rule.id)} but did not say ${naturalList(missing)}.`;
}

export function explainUnit(
  unit: ConversionUnit,
  options: DiagnoseOptions = {},
): SpecExplanation[] {
  const context = { vocabulary: vocabularyTerms(options.vocabulary) };
  const explanations: SpecExplanation[] = [];
  for (const rule of REQUIREMENT_RULES) {
    if (!applies(rule, unit)) continue;
    explanations.push({
      rule: rule.id,
      sourcePath: unit.sourcePath,
      ...(unit.line !== undefined ? { line: unit.line } : {}),
      targetPath: targetPath(unit),
      facets: rule.facets.map((required) => ({
        id: required.id,
        question: required.question,
        example: required.example,
        satisfied: required.satisfiedBy(unit.prompt, context),
      })),
    });
  }
  return explanations;
}

export function diagnoseUnit(
  unit: ConversionUnit,
  options: DiagnoseOptions = {},
): SpecDiagnostic[] {
  const explanations = explainUnit(unit, options);
  return explanations.flatMap((explanation) => {
    const rule = REQUIREMENT_RULES.find((item) => item.id === explanation.rule)!;
    const facets = explanation.facets
      .filter((item) => !item.satisfied)
      .map(({ id, question, example }) => ({ id, question, example }));
    if (facets.length === 0) return [];
    return [{
      code: "E-UNDERSPECIFIED" as const,
      rule: rule.id,
      severity: rule.severity,
      sourcePath: unit.sourcePath,
      ...(unit.line !== undefined ? { line: unit.line } : {}),
      targetPath: targetPath(unit),
      message: diagnosticMessage(rule, facets),
      facets,
    }];
  });
}

export function diagnoseUnits(
  units: readonly ConversionUnit[],
  options: DiagnoseOptions = {},
): SpecDiagnostic[] {
  return units
    .flatMap((unit) => diagnoseUnit(unit, options))
    .sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath)
      || (left.line ?? 0) - (right.line ?? 0)
      || left.rule.localeCompare(right.rule));
}

/** Stable facet record included in compile-key inputs. */
export function resolvedFacetRecord(
  unit: ConversionUnit,
  options: DiagnoseOptions = {},
): Record<string, string> {
  return Object.fromEntries(
    explainUnit(unit, options)
      .flatMap((explanation) => explanation.facets
        .filter((item) => item.satisfied)
        .map((item) => [`${explanation.rule}.${item.id}`, "specified"] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
