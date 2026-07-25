/** Pre-write direct-candidate syntax checks; this is not semantic or sandbox verification. */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ts from "typescript";
import { replaceInlineMarker } from "../file-ops/replacement.ts";
import type { ConversionUnit, GeneratedConversionUnit } from "../../workflows/types.ts";

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

function requestsExport(prompt: string): boolean {
  return !/\b(?:do\s+not|don't|without)\s+(?:an?\s+)?export\b/iu.test(prompt)
    && /\b(?:export|exported|exporting)\b/iu.test(prompt);
}

function requestedHtmlId(prompt: string): string | undefined {
  return prompt.match(
    /\bid\s*=\s*["'`]([^"'`\n]{1,100})["'`]/iu,
  )?.[1] ?? prompt.match(
    /\bwith\s+(?:an?\s+)?id\s+(?:named\s+)?([A-Za-z][\w:.-]{0,99})\b/iu,
  )?.[1];
}

function validateExplicitRequirements(
  unit: ConversionUnit,
  code: string,
  sourcePath: string,
): void {
  const extension = extname(sourcePath).toLowerCase();
  const violations: string[] = [];
  if (
    TYPESCRIPT_EXTENSIONS.has(extension)
    && requestsExport(unit.prompt)
    && !/\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|const|enum|function|interface|let|type|var|\{)|\bmodule\.exports\b|\bexports\.[A-Za-z_$]/u
      .test(code)
  ) {
    violations.push(
      "The instruction explicitly requires an export, but the candidate exposes none; add a real language-level export.",
    );
  }
  if (
    TYPESCRIPT_EXTENSIONS.has(extension)
    && /\b(?:import\s*\{[^}]*\b(?:Map|Promise|Set)\b[^}]*\}\s*from|const\s*\{[^}]*\b(?:Map|Promise|Set)\b[^}]*\}\s*=\s*require\s*\()/u
      .test(code)
  ) {
    violations.push(
      "The candidate imports a built-in JavaScript global; remove that import and use the global directly.",
    );
  }
  if (extension === ".rs") {
    const requestsPublicFunction =
      /\b(?:function|fn)\b/iu.test(unit.prompt)
      && /\b(?:pub|public|publish|export)\b/iu.test(unit.prompt);
    if (
      requestsPublicFunction
      && !/\bpub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\b/u.test(code)
    ) {
      violations.push(
        "The instruction requires a public Rust function; prefix the requested function declaration with `pub` so the candidate contains `pub fn`.",
      );
    }
    if (
      /\.len\(\)\s*-\s*1\b/u.test(code)
      && !/\.is_empty\(\)/u.test(code)
      && !/\bnon[- ]empty\b/iu.test(unit.prompt)
    ) {
      violations.push(
        "Subtracting 1 from `.len()` can underflow for empty input; guard the empty case before subtraction or use half-open bounds.",
      );
    }
  }
  if (extension === ".html" || extension === ".htm") {
    if (
      /\bmain\s+landmark\b/iu.test(unit.prompt)
      && !/<main\b/iu.test(code)
    ) {
      violations.push(
        "The instruction requires a main landmark; add an actual `<main>` element because `<body>` is not a main landmark.",
      );
    }
    const requestedId = requestedHtmlId(unit.prompt);
    if (requestedId !== undefined) {
      const candidateIds = new Set(
        [...code.matchAll(/\bid\s*=\s*["']([^"'\n]{1,100})["']/giu)]
          .map((match) => match[1]),
      );
      if (!candidateIds.has(requestedId)) {
        violations.push(
          `The instruction requires id=${JSON.stringify(requestedId)}, but the candidate does not contain it.`,
        );
      }
    }
  }
  if (violations.length > 0) {
    throw new DirectCandidateValidationError(
      `${sourcePath}: candidate violates explicit requirements: ${violations.join(" ")}`,
    );
  }
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

function validateCssReplacement(unit: ConversionUnit, code: string): void {
  if (unit.insertionContext === "css-declarations") {
    if (/[{}]/u.test(code) && !/(?:^|[;}])\s*&[^{}]*\{/u.test(code)) {
      throw new DirectCandidateValidationError(
        `${unit.sourcePath}: this marker is inside a CSS rule; the replacement repeated or introduced a non-relative selector instead of adding declarations.`,
      );
    }
    const hasRelativeRule = /(?:^|[;}])\s*&[^{}]*\{/u.test(code);
    const requestsNestedRule = /\b(?:hover|focus|active|visited|disabled|checked|state|pseudo|nested|responsive|media|container query)\b/iu.test(unit.prompt);
    if (hasRelativeRule && !requestsNestedRule) {
      throw new DirectCandidateValidationError(
        `${unit.sourcePath}: the replacement introduced a nested CSS rule that the current marker did not request.`,
      );
    }
    if (!hasRelativeRule && !/(?:^|;)\s*--?[A-Za-z_][\w-]*\s*:/u.test(`;${code}`) && !/(?:^|;)\s*[A-Za-z-]+\s*:/u.test(`;${code}`)) {
      throw new DirectCandidateValidationError(
        `${unit.sourcePath}: this marker is inside a CSS rule but the replacement contains no CSS declaration.`,
      );
    }
  }
  if (unit.insertionContext === "css-rule-list") {
    let depth = 0;
    for (const char of code.replace(/\/\*[\s\S]*?\*\//gu, "")) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth < 0) break;
    }
    if (depth !== 0 || !code.includes("{")) {
      throw new DirectCandidateValidationError(
        `${unit.sourcePath}: this marker is between CSS rules and requires complete balanced rules.`,
      );
    }
  }
}

function normalizedCssHeader(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizedCodeLines(value: string): string {
  return value
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Models sometimes finish an inline replacement by copying a statement that
 * already follows the marker. Remove only an exact, non-empty trailing line
 * sequence evidenced after the marker, while always retaining real generated
 * code before it.
 */
function stripRepeatedTrailingSource(
  unit: ConversionUnit,
  code: string,
): string {
  if (unit.kind !== "inline" || !unit.surroundingSource) return code;
  const marker = "<CURRENT_MARKER>";
  const markerIndex = unit.surroundingSource.indexOf(marker);
  if (markerIndex < 0) return code;
  const trailing = normalizedCodeLines(
    unit.surroundingSource.slice(markerIndex + marker.length),
  );
  const lines = code.trim().split(/\r?\n/gu);
  for (let start = 1; start < lines.length; start += 1) {
    const suffix = normalizedCodeLines(lines.slice(start).join("\n"));
    if (
      /[A-Za-z0-9_$]/u.test(suffix)
      && trailing.includes(suffix)
    ) {
      return lines.slice(0, start).join("\n").trimEnd();
    }
  }
  return code;
}

/** Remove exact surrounding-code repetition without guessing at new behavior. */
export function normalizeGeneratedUnitCode(unit: ConversionUnit, code: string): string {
  let normalized = stripRepeatedTrailingSource(unit, code);
  if (unit.insertionContext !== "css-declarations" || !unit.insertionOwner)
    return normalized;
  const match = normalized.trim().match(/^([^{}]+)\{([\s\S]*)\}\s*$/u);
  if (
    !match
    || normalizedCssHeader(match[1]!)
      !== normalizedCssHeader(unit.insertionOwner)
  )
    return normalized;
  normalized = match[2]!.trim();
  return normalized;
}

interface FunctionWrapper {
  name: string;
  parameters: string;
  body: string;
  suffix: string;
}

function matchingGeneratedDelimiter(
  code: string,
  openOffset: number,
  open: "(" | "{",
  close: ")" | "}",
): number | undefined {
  let depth = 1;
  let offset = openOffset + 1;
  while (offset < code.length) {
    const char = code[offset]!;
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      offset += 1;
      while (offset < code.length) {
        if (code[offset] === "\\") offset += 2;
        else if (code[offset] === quote) {
          offset += 1;
          break;
        } else offset += 1;
      }
      continue;
    }
    if (code.startsWith("//", offset)) {
      const newline = code.indexOf("\n", offset + 2);
      offset = newline === -1 ? code.length : newline + 1;
      continue;
    }
    if (code.startsWith("/*", offset)) {
      const blockEnd = code.indexOf("*/", offset + 2);
      offset = blockEnd === -1 ? code.length : blockEnd + 2;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return offset;
    }
    offset += 1;
  }
  return undefined;
}

function generatedFunctionWrapper(code: string): FunctionWrapper | undefined {
  const trimmed = code.trim();
  const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u.exec(trimmed);
  if (!declaration) return undefined;
  const openParen = trimmed.indexOf("(", declaration.index + declaration[0].length - 1);
  const closeParen = matchingGeneratedDelimiter(trimmed, openParen, "(", ")");
  if (closeParen === undefined) return undefined;
  const openBrace = trimmed.indexOf("{", closeParen + 1);
  if (openBrace < 0) return undefined;
  const closeBrace = matchingGeneratedDelimiter(trimmed, openBrace, "{", "}");
  if (closeBrace === undefined) return undefined;
  return {
    name: declaration[1]!,
    parameters: trimmed.slice(openParen + 1, closeParen).trim(),
    body: trimmed.slice(openBrace + 1, closeBrace).trim(),
    suffix: trimmed.slice(closeBrace + 1).trim(),
  };
}

function precedingFunctionNames(unit: ConversionUnit): Set<string> {
  if (!unit.surroundingSource) return new Set();
  const before = unit.surroundingSource.split("<CURRENT_MARKER>", 1)[0] ?? "";
  return new Set(
    [...before.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu)]
      .map((match) => match[1]!),
  );
}

/**
 * Compiler mode may safely peel a full function wrapper from a fragment-only
 * answer because discovery has already proven the exact grammar slot. This is
 * not used by agent mode and never invents behavior: it only removes syntax
 * that belongs to the surrounding source.
 */
export function normalizeCompilerGeneratedUnitCode(
  unit: ConversionUnit,
  code: string,
): string {
  const normalized = normalizeGeneratedUnitCode(unit, code);
  const wrapper = generatedFunctionWrapper(normalized);
  if (!wrapper) return normalized;
  if (unit.insertionContext === "parameter-list") return wrapper.parameters;
  if (unit.insertionContext === "function-body") return wrapper.body;
  if (
    unit.insertionContext === "statement"
    && wrapper.suffix.length > 0
    && precedingFunctionNames(unit).has(wrapper.name)
  ) {
    return wrapper.suffix;
  }
  return normalized;
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

/** Build complete candidate text per target, combining every marker in a file. */
export async function candidateTextsForGenerated(
  generated: readonly GeneratedConversionUnit[],
): Promise<Map<string, string>> {
  const byPath = new Map<string, GeneratedConversionUnit[]>();
  for (const item of generated.filter((entry) => entry.contextOnly !== true)) {
    const path = item.unit.kind === "file" ? item.unit.outputPath! : item.unit.sourcePath;
    byPath.set(path, [...(byPath.get(path) ?? []), item]);
  }
  const candidates = new Map<string, string>();
  for (const [path, items] of byPath) {
    if (items.some((item) => item.error !== undefined || item.code.trim().length === 0)) continue;
    if (items[0]!.unit.kind === "file") {
      candidates.set(path, items[0]!.code);
      continue;
    }
    let content = await readFile(items[0]!.unit.absoluteSource, "utf8");
    for (const item of [...items].sort((left, right) => right.unit.range!.start - left.unit.range!.start)) {
      content = replaceInlineMarker(content, item.unit.range!, item.unit.expectedMarker, item.code);
    }
    candidates.set(path, content);
  }
  return candidates;
}

/** Validate the complete candidate file before any direct-agent write occurs. */
export async function validateGeneratedUnit(unit: ConversionUnit, code: string): Promise<void> {
  if (code.trim().length === 0) throw new DirectCandidateValidationError(`${unit.sourcePath}: model returned no code.`);
  if (/^```/mu.test(code)) {
    throw new DirectCandidateValidationError(`${unit.sourcePath}: model formatting remained in generated source.`);
  }
  const sourcePath = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
  validateExplicitRequirements(unit, code, sourcePath);
  if (extname(sourcePath).toLowerCase() === ".css" && unit.kind === "inline") validateCssReplacement(unit, code);
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
