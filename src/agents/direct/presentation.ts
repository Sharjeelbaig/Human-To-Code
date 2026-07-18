import { languageProfile } from "./languages.ts";
import { potentialIntegrationRequests } from "./integration-validation.ts";
import type { ConversionUnit } from "./types.ts";

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export interface ConditionalRequestAllowance {
  integrationAuditUpTo: number;
  integrationRepairUpTo: number;
  compilerRepairUpTo: number;
}

/** Conservative opt-in request ceilings for pre-generation disclosure. */
export function conditionalRequestAllowance(
  units: readonly ConversionUnit[],
  configuredLanguages: string | readonly string[],
): ConditionalRequestAllowance {
  const configured = typeof configuredLanguages === "string" ? [configuredLanguages] : configuredLanguages;
  const primary = configured[0] ?? "typescript";
  const integration = potentialIntegrationRequests(units);
  return {
    integrationAuditUpTo: integration.auditUpTo,
    integrationRepairUpTo: integration.repairUpTo,
    compilerRepairUpTo: units.filter((unit) => {
      const language = unit.language ?? primary;
      return unit.kind === "file" && (language === "typescript" || language === "javascript");
    }).length,
  };
}

export function renderReceipt(
  units: readonly ConversionUnit[],
  provider: string,
  model: string,
  configuredLanguages: string | readonly string[],
  options: { reconcileIntegrations?: boolean } = {},
): string {
  const configured = typeof configuredLanguages === "string"
    ? [configuredLanguages]
    : configuredLanguages;
  const primary = configured[0] ?? "typescript";
  const selected = units.length === 0
    ? [...configured]
    : [...new Set(units.map((unit) => unit.language ?? primary))];
  const rendered = selected
    .map((entry) => {
      const profile = languageProfile(entry);
      return `${profile.label} (.${profile.ext})`;
    })
    .join(", ");
  const repairableUnits = units.filter((unit) => {
    const language = unit.language ?? primary;
    return language === "typescript" || language === "javascript";
  });
  const repairLanguages = [...new Set(repairableUnits.map((unit) => unit.language ?? primary))]
    .map((language) => languageProfile(language).label)
    .join("/");
  const repairAllowance = repairableUnits.length > 0
    ? ` (up to ${repairableUnits.length} extra bounded repair request${repairableUnits.length === 1 ? "" : "s"} for ${repairLanguages})`
    : "";
  const conditional = options.reconcileIntegrations
    ? conditionalRequestAllowance(units, configured)
    : undefined;
  const integrationDisclaimer = conditional !== undefined && conditional.integrationAuditUpTo > 0
    ? `  Additional: opt-in cross-file reconciliation may issue up to ${conditional.integrationAuditUpTo} bounded audit request${conditional.integrationAuditUpTo === 1 ? "" : "s"} and ${conditional.integrationRepairUpTo} target-repair request${conditional.integrationRepairUpTo === 1 ? "" : "s"}; only ProjectMemory-evidenced generated relationships are audited.`
    : undefined;
  const lines = [
    "human-to-code — conversion receipt",
    "",
    `  ${selected.length > 1 ? "Languages:" : "Language :"} ${rendered}`,
    `  Provider : ${provider}`,
    `  Model    : ${model}`,
    `  Engine   : direct (one model request per prompt; bounded cross-file repair may add requests)`,
    `  Context  : compact current/projected ProjectMemory (target-specific, bounded)`,
    `  Requests : ${units.length} planned${options.reconcileIntegrations ? "" : repairAllowance}`,
    ...(integrationDisclaimer ? [integrationDisclaimer] : []),
    ...(conditional !== undefined && conditional.compilerRepairUpTo > 0
      ? [`  Validation: up to ${conditional.compilerRepairUpTo} additional bounded JS/TS compiler-repair request${conditional.compilerRepairUpTo === 1 ? "" : "s"}, only if validation fails.`]
      : []),
    "",
  ];
  if (units.length === 0) lines.push("  No .human files or @human markers were found.");
  else {
    lines.push("  The following will be generated:");
    for (const unit of units) lines.push(`    • ${unit.describe}`);
  }
  return `${lines.join("\n")}\n`;
}

export function stripCodeFence(output: string): string {
  const trimmed = output.trim();
  const fences = [...trimmed.matchAll(/```(?:[\w.+-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gu)];
  if (fences.length > 1) {
    throw new ModelOutputError("Model returned multiple fenced code blocks; refusing an ambiguous replacement.");
  }
  if (fences.length === 1) return (fences[0]?.[1] ?? "").trim();
  if (trimmed.includes("```")) {
    throw new ModelOutputError("Model returned an unterminated code fence; refusing to write formatting as source.");
  }
  return trimmed;
}
