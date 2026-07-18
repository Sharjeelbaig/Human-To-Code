/** Pre-write direct-candidate syntax checks; this is not semantic or sandbox verification. */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ts from "typescript";
import { replaceInlineMarker } from "./replacement.ts";
import type { ConversionUnit } from "./types.ts";

export class DirectCandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectCandidateValidationError";
  }
}

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Delimiter balancing misreads prose-bearing markup: apostrophes in HTML text
// and unquoted `url(https://…)` in CSS are legal but read as unterminated
// strings/comments. These outputs keep only the fence and non-empty gates.
const UNBALANCED_TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".svg", ".md", ".markdown"]);

interface CandidateSyntaxDiagnostic {
  key: string;
  message: string;
}

function newlyIntroducedDiagnostic(
  baseline: readonly CandidateSyntaxDiagnostic[],
  candidate: readonly CandidateSyntaxDiagnostic[],
): CandidateSyntaxDiagnostic | undefined {
  const remainingBaseline = new Map<string, number>();
  for (const diagnostic of baseline) {
    remainingBaseline.set(diagnostic.key, (remainingBaseline.get(diagnostic.key) ?? 0) + 1);
  }
  for (const diagnostic of candidate) {
    const remaining = remainingBaseline.get(diagnostic.key) ?? 0;
    if (remaining > 0) remainingBaseline.set(diagnostic.key, remaining - 1);
    else return diagnostic;
  }
  return undefined;
}

function balancedSyntaxDiagnostics(text: string, sourcePath: string): CandidateSyntaxDiagnostic[] {
  const diagnostics: CandidateSyntaxDiagnostic[] = [];
  const stack: string[] = [];
  let quote: "'" | "\"" | "`" | undefined;
  let triple: "'''" | "\"\"\"" | undefined;
  let blockComment = false;
  let escaped = false;
  const extension = extname(sourcePath).toLowerCase();
  const hashComments = extension === ".py" || extension === ".rb";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (triple) {
      if (text.startsWith(triple, index)) {
        index += 2;
        triple = undefined;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index = text.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (hashComments && char === "#") {
      index = text.indexOf("\n", index + 1);
      if (index === -1) break;
      continue;
    }
    if (extension === ".py" && (text.startsWith("'''", index) || text.startsWith('"""', index))) {
      triple = text.startsWith("'''", index) ? "'''" : '"""';
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== expected) {
        diagnostics.push({ key: `delimiter:${expected}:${char}`, message: "mismatched delimiters" });
      }
    }
  }
  if (quote) diagnostics.push({ key: `quote:${quote}`, message: "an unterminated string" });
  if (triple) diagnostics.push({ key: `triple:${triple}`, message: "an unterminated multiline string" });
  if (blockComment) diagnostics.push({ key: "comment:block", message: "an unterminated block comment" });
  for (const delimiter of stack) {
    diagnostics.push({ key: `delimiter:${delimiter}`, message: "an unterminated delimiter" });
  }
  return diagnostics;
}

function typeScriptSyntaxDiagnostics(text: string, sourcePath: string): CandidateSyntaxDiagnostic[] {
  const extension = extname(sourcePath).toLowerCase();
  const jsx = extension === ".tsx" || extension === ".jsx";
  const result = ts.transpileModule(text, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      ...(jsx ? { jsx: ts.JsxEmit.Preserve } : {}),
      allowJs: true,
    },
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      return { key: `${diagnostic.code}:${message}`, message };
    });
}

async function sourceAndCandidateForUnit(
  unit: ConversionUnit,
  code: string,
): Promise<{ baseline?: string; candidate: string }> {
  if (unit.kind === "file") {
    return { candidate: code.endsWith("\n") ? code : `${code}\n` };
  }
  const baseline = await readFile(unit.absoluteSource, "utf8");
  return {
    baseline,
    candidate: replaceInlineMarker(baseline, unit.range!, unit.expectedMarker, code),
  };
}

export async function candidateTextForUnit(unit: ConversionUnit, code: string): Promise<string> {
  return (await sourceAndCandidateForUnit(unit, code)).candidate;
}

/** Validate the complete candidate file before any direct-agent write occurs. */
export async function validateGeneratedUnit(unit: ConversionUnit, code: string): Promise<void> {
  if (code.trim().length === 0) throw new DirectCandidateValidationError(`${unit.sourcePath}: model returned no code.`);
  if (/```/u.test(code)) {
    throw new DirectCandidateValidationError(`${unit.sourcePath}: model formatting remained in generated source.`);
  }
  const sourcePath = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
  if (UNBALANCED_TEXT_EXTENSIONS.has(extname(sourcePath).toLowerCase())) return;
  const { baseline, candidate } = await sourceAndCandidateForUnit(unit, code);
  const typescript = TYPESCRIPT_EXTENSIONS.has(extname(sourcePath).toLowerCase());
  const baselineDiagnostics = baseline === undefined
    ? []
    : typescript
      ? typeScriptSyntaxDiagnostics(baseline, sourcePath)
      : balancedSyntaxDiagnostics(baseline, sourcePath);
  const candidateDiagnostics = typescript
    ? typeScriptSyntaxDiagnostics(candidate, sourcePath)
    : balancedSyntaxDiagnostics(candidate, sourcePath);
  const introduced = newlyIntroducedDiagnostic(baselineDiagnostics, candidateDiagnostics);
  if (introduced) {
    throw new DirectCandidateValidationError(
      `${sourcePath}: generated candidate failed syntax validation: ${introduced.message}.`,
    );
  }
}
