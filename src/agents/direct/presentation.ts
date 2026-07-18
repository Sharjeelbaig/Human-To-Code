import { languageProfile } from "./languages.ts";
import type { ConversionUnit } from "./types.ts";

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export function renderReceipt(
  units: readonly ConversionUnit[],
  provider: string,
  model: string,
  configuredLanguages: string | readonly string[],
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
  const lines = [
    "human-to-code — conversion receipt",
    "",
    `  ${selected.length > 1 ? "Languages:" : "Language :"} ${rendered}`,
    `  Provider : ${provider}`,
    `  Model    : ${model}`,
    `  Engine   : direct (one model request per prompt; bounded cross-file repair may add requests)`,
    `  Requests : ${units.length} planned${repairAllowance}`,
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
