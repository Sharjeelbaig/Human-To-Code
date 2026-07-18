import { languageProfile } from "./languages.ts";
import type { ConversionUnit } from "./types.ts";

export function renderReceipt(
  units: readonly ConversionUnit[],
  provider: string,
  model: string,
  language: string,
): string {
  const profile = languageProfile(language);
  const lines = [
    "human-to-code — conversion receipt",
    "",
    `  Language : ${profile.label} (.${profile.ext})`,
    `  Provider : ${provider}`,
    `  Model    : ${model}`,
    `  Engine   : direct (one model request per prompt)`,
    `  Requests : ${units.length}`,
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
  const match = /^```(?:[\w.+-]+)?\s*\n?([\s\S]*?)\n?```$/u.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}
