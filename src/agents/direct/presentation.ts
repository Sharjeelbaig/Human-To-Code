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
  language: string | readonly string[],
): string {
  const list = typeof language === "string" ? [language] : language;
  const rendered = list
    .map((entry) => {
      const profile = languageProfile(entry);
      return `${profile.label} (.${profile.ext})`;
    })
    .join(", ");
  const lines = [
    "human-to-code — conversion receipt",
    "",
    `  ${list.length > 1 ? "Languages:" : "Language :"} ${rendered}`,
    `  Provider : ${provider}`,
    `  Model    : ${model}`,
    `  Engine   : direct (one model request per prompt; bounded cross-file repair may add requests)`,
    `  Requests : ${units.length} planned (up to ${units.length} extra bounded repair requests for JS/TS)`,
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
