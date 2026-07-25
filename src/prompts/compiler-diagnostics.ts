/** Strict prompt and parser for opt-in semantic specification diagnostics. */
import type { PromptMessages } from "./direct-conversion.ts";

export interface CompilerDiagnosticPromptItem {
  id: number;
  sourcePath: string;
  targetPath: string;
  instruction: string;
}

export interface SemanticFacet {
  id: string;
  question: string;
  example: string;
}

export interface SemanticDiagnostic {
  id: number;
  rule: string;
  message: string;
  facets: SemanticFacet[];
}

const SAFE_TEXT = /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;

export function buildCompilerDiagnosticsPrompt(
  items: readonly CompilerDiagnosticPromptItem[],
): PromptMessages {
  return {
    system: [
      "Find material decisions left unresolved by natural-language code requests.",
      "Do not answer any decision. Do not generate code. Do not repeat decisions that are already explicitly fixed.",
      "Return exactly one JSON object with key diagnostics.",
      'Each diagnostic is {"id":number,"rule":string,"message":string,"facets":[{"id":string,"question":string,"example":string}]}.',
      "Use only ids present in the input. Return at most 5 facets per item and no more than 40 diagnostics.",
    ].join("\n"),
    user: JSON.stringify({ items }),
  };
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\n")
    && SAFE_TEXT.test(value);
}

export function parseCompilerDiagnostics(
  raw: string,
  itemCount: number,
): SemanticDiagnostic[] {
  if (raw.length > 64_000) {
    throw new Error("semantic diagnostics response is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("semantic diagnostics response is not valid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, ["diagnostics"])
  ) {
    throw new Error("semantic diagnostics response has an invalid root");
  }
  const diagnostics = (parsed as { diagnostics: unknown }).diagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length > 40) {
    throw new Error("semantic diagnostics response has an invalid diagnostic list");
  }
  return diagnostics.map((rawDiagnostic, index) => {
    if (
      typeof rawDiagnostic !== "object"
      || rawDiagnostic === null
      || Array.isArray(rawDiagnostic)
    ) {
      throw new Error(`semantic diagnostic ${index} is invalid`);
    }
    const diagnostic = rawDiagnostic as Record<string, unknown>;
    if (
      !exactKeys(diagnostic, ["id", "rule", "message", "facets"])
      || typeof diagnostic.id !== "number"
      || !Number.isInteger(diagnostic.id)
      || diagnostic.id < 0
      || diagnostic.id >= itemCount
      || typeof diagnostic.rule !== "string"
      || !SAFE_ID.test(diagnostic.rule)
      || !safeText(diagnostic.message, 500)
      || !Array.isArray(diagnostic.facets)
      || diagnostic.facets.length === 0
      || diagnostic.facets.length > 5
    ) {
      throw new Error(`semantic diagnostic ${index} has invalid values`);
    }
    const facets = diagnostic.facets.map((rawFacet, facetIndex) => {
      if (
        typeof rawFacet !== "object"
        || rawFacet === null
        || Array.isArray(rawFacet)
      ) {
        throw new Error(`semantic diagnostic ${index} facet ${facetIndex} is invalid`);
      }
      const facet = rawFacet as Record<string, unknown>;
      if (
        !exactKeys(facet, ["id", "question", "example"])
        || typeof facet.id !== "string"
        || !SAFE_ID.test(facet.id)
        || !safeText(facet.question, 240)
        || !safeText(facet.example, 240)
      ) {
        throw new Error(`semantic diagnostic ${index} facet ${facetIndex} has invalid values`);
      }
      return {
        id: facet.id,
        question: facet.question,
        example: facet.example,
      };
    });
    return {
      id: diagnostic.id,
      rule: diagnostic.rule,
      message: diagnostic.message,
      facets,
    };
  });
}
