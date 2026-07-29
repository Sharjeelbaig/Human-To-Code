/** Pre-write direct-candidate structural checks; this is not sandbox verification. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ts from "typescript";
import { replaceScopedInlineUnit } from "../file-ops/replacement.ts";
import { MARKER_SCANNED_EXTENSIONS } from "../discovery/discovery.ts";
import { extractInlineMarkers } from "../discovery/marker-parser.ts";
import { expectedCodeFromLanguageRules } from "../compiler/language-rules.ts";
import type { ConversionUnit, GeneratedConversionUnit } from "../../workflows/types.ts";

export class DirectCandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectCandidateValidationError";
  }
}

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PYTHON_SYNTAX_TIMEOUT_MS = 5_000;
const MAX_PYTHON_DIAGNOSTIC_BYTES = 64 * 1024;
const PYTHON_SYNTAX_SCRIPT = [
  "import ast, builtins, json, sys",
  "source = sys.stdin.read()",
  "try:",
  "    tree = ast.parse(source, filename='<candidate>', mode='exec', type_comments=True)",
  "except (SyntaxError, ValueError, TypeError) as error:",
  "    print(json.dumps({",
  "        'kind': type(error).__name__,",
  "        'message': getattr(error, 'msg', str(error)),",
  "        'line': getattr(error, 'lineno', None),",
  "        'column': getattr(error, 'offset', None),",
  "    }))",
  "else:",
  "    issues = []",
  "    module_bound = set(dir(builtins))",
  "    def bind_target(target):",
  "        if isinstance(target, ast.Name):",
  "            module_bound.add(target.id)",
  "        elif isinstance(target, (ast.Tuple, ast.List)):",
  "            for item in target.elts:",
  "                bind_target(item)",
  "    for statement in tree.body:",
  "        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):",
  "            module_bound.add(statement.name)",
  "        elif isinstance(statement, (ast.Assign, ast.AnnAssign)):",
  "            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]",
  "            for target in targets:",
  "                bind_target(target)",
  "        elif isinstance(statement, ast.Import):",
  "            for alias in statement.names:",
  "                module_bound.add(alias.asname or alias.name.split('.')[0])",
  "        elif isinstance(statement, ast.ImportFrom):",
  "            for alias in statement.names:",
  "                if alias.name != '*':",
  "                    module_bound.add(alias.asname or alias.name)",
  "    for statement in tree.body:",
  "        if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):",
  "            continue",
  "        annotations = [argument.annotation for argument in [*statement.args.posonlyargs, *statement.args.args, *statement.args.kwonlyargs] if argument.annotation is not None]",
  "        if statement.args.vararg is not None and statement.args.vararg.annotation is not None:",
  "            annotations.append(statement.args.vararg.annotation)",
  "        if statement.args.kwarg is not None and statement.args.kwarg.annotation is not None:",
  "            annotations.append(statement.args.kwarg.annotation)",
  "        if statement.returns is not None:",
  "            annotations.append(statement.returns)",
  "        for annotation in annotations:",
  "            for name in (node for node in ast.walk(annotation) if isinstance(node, ast.Name)):",
  "                if name.id not in module_bound:",
  "                    issues.append({",
  "                        'kind': 'UndefinedAnnotation',",
  "                        'message': f'annotation name {name.id} is not imported or declared at module scope',",
  "                        'line': getattr(name, 'lineno', None),",
  "                        'column': getattr(name, 'col_offset', 0) + 1,",
  "                    })",
  "                    break",
  "            if issues:",
  "                break",
  "        if issues:",
  "            break",
  "    def inspect_body(owner, body):",
  "        terminated = False",
  "        for statement in body:",
  "            if terminated:",
  "                issues.append({",
  "                    'kind': 'UnreachableCode',",
  "                    'message': 'statement follows an unconditional return, raise, break, or continue',",
  "                    'line': getattr(statement, 'lineno', None),",
  "                    'column': getattr(statement, 'col_offset', 0) + 1,",
  "                })",
  "                break",
  "            if isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue)):",
  "                terminated = True",
  "            if owner is not None and isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and statement.name == owner:",
  "                issues.append({",
  "                    'kind': 'DuplicateNestedDefinition',",
  "                    'message': f'{statement.name} is nested inside a definition with the same name',",
  "                    'line': getattr(statement, 'lineno', None),",
  "                    'column': getattr(statement, 'col_offset', 0) + 1,",
  "                })",
  "    for node in ast.walk(tree):",
  "        body = getattr(node, 'body', None)",
  "        if isinstance(body, list):",
  "            owner = node.name if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else None",
  "            inspect_body(owner, body)",
  "    if issues:",
  "        print(json.dumps(issues[0]))",
].join("\n");

// Delimiter balancing misreads prose-bearing markup: apostrophes in HTML text
// and unquoted `url(https://…)` in CSS are legal but read as unterminated
// strings/comments. These outputs keep only the fence and non-empty gates.
const UNBALANCED_TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".svg", ".md", ".markdown"]);

interface CandidateSyntaxDiagnostic {
  key: string;
  message: string;
}

interface PythonSyntaxPayload {
  kind?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
}

interface PythonCommand {
  executable: string;
  args: string[];
}

let resolvedPythonCommand: Promise<PythonCommand | undefined> | undefined;

function pythonCommandCandidates(): PythonCommand[] {
  return process.platform === "win32"
    ? [
        { executable: "py", args: ["-3"] },
        { executable: "python3", args: [] },
        { executable: "python", args: [] },
      ]
    : [
        { executable: "python3", args: [] },
        { executable: "python", args: [] },
      ];
}

function runPythonParser(
  command: PythonCommand,
  source: string,
): Promise<{ available: boolean; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command.executable, [...command.args, "-X", "utf8", "-c", PYTHON_SYNTAX_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: { available: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ available: false, output: "" });
    }, PYTHON_SYNTAX_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputBytes >= MAX_PYTHON_DIAGNOSTIC_BYTES) return;
      const remaining = MAX_PYTHON_DIAGNOSTIC_BYTES - outputBytes;
      const bounded = chunk.subarray(0, remaining);
      output.push(bounded);
      outputBytes += bounded.length;
    });
    child.on("error", () => finish({ available: false, output: "" }));
    child.on("close", (code) => {
      finish({
        available: code === 0,
        output: code === 0 ? Buffer.concat(output).toString("utf8").trim() : "",
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(source);
  });
}

async function pythonCommand(): Promise<PythonCommand | undefined> {
  resolvedPythonCommand ??= (async () => {
    for (const candidate of pythonCommandCandidates()) {
      const probe = await runPythonParser(candidate, "");
      if (probe.available) return candidate;
    }
    return undefined;
  })();
  return resolvedPythonCommand;
}

async function pythonSyntaxDiagnostics(text: string): Promise<CandidateSyntaxDiagnostic[]> {
  const command = await pythonCommand();
  if (command === undefined) {
    return [{
      key: "python:parser-unavailable",
      message: "no Python 3 parser is available on PATH",
    }];
  }
  const parsed = await runPythonParser(command, text);
  if (!parsed.available) {
    return [{
      key: "python:parser-failed",
      message: "the Python 3 parser did not complete successfully",
    }];
  }
  if (parsed.output.length === 0) return [];
  let payload: PythonSyntaxPayload;
  try {
    payload = JSON.parse(parsed.output) as PythonSyntaxPayload;
  } catch {
    return [{
      key: "python:parser-output",
      message: "the Python parser returned an unreadable syntax diagnostic",
    }];
  }
  const kind = typeof payload.kind === "string" ? payload.kind : "SyntaxError";
  const message = typeof payload.message === "string" ? payload.message : "invalid syntax";
  const line = typeof payload.line === "number" ? payload.line : undefined;
  const column = typeof payload.column === "number" ? payload.column : undefined;
  const location = line === undefined
    ? ""
    : ` at line ${line}${column === undefined ? "" : `, column ${column}`}`;
  return [{
    // Location is deliberately omitted from the comparison key. An accepted
    // multiline replacement can shift an unchanged baseline diagnostic.
    key: `python:${kind}:${message}`,
    message: `${kind}: ${message}${location}`,
  }];
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

interface PythonImportRequirement {
  module: string;
  name?: string;
  alias?: string;
}

function pythonImportRequirements(prompt: string): PythonImportRequirement[] {
  const requirements: PythonImportRequirement[] = [];
  const seen = new Set<string>();
  const add = (requirement: PythonImportRequirement): void => {
    const key = `${requirement.module}\0${requirement.name ?? ""}\0${requirement.alias ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      requirements.push(requirement);
    }
  };
  const fromPattern =
    /\bimport(?:ing)?\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s+from\s+([A-Za-z_][\w.]*)\b/giu;
  for (const match of prompt.matchAll(fromPattern)) {
    add({
      name: match[1]!,
      ...(match[2] ? { alias: match[2] } : {}),
      module: match[3]!,
    });
  }
  const modulePattern =
    /\bimport(?:ing)?\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?\s+at\s+the\s+top\b/giu;
  for (const match of prompt.matchAll(modulePattern)) {
    // A longer "X from module at the top" phrase was already captured above.
    if (prompt.slice(match.index, match.index + match[0].length).includes(" from ")) continue;
    add({
      module: match[1]!,
      ...(match[2] ? { alias: match[2] } : {}),
    });
  }
  return requirements;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasPythonImport(code: string, requirement: PythonImportRequirement): boolean {
  const module = escapeRegExp(requirement.module);
  const alias = requirement.alias === undefined
    ? ""
    : `\\s+as\\s+${escapeRegExp(requirement.alias)}`;
  if (requirement.name !== undefined) {
    return new RegExp(
      `^from\\s+${module}\\s+import\\s+${escapeRegExp(requirement.name)}${alias}(?:\\s*(?:#.*)?)?$`,
      "mu",
    ).test(code);
  }
  return new RegExp(
    `^import\\s+${module}${alias}(?:\\s*(?:#.*)?)?$`,
    "mu",
  ).test(code);
}

function validatePythonImportRequirements(
  unit: ConversionUnit,
  candidate: string,
  sourcePath: string,
): void {
  if (extname(sourcePath).toLowerCase() !== ".py") return;
  const missing = pythonImportRequirements(unit.prompt).filter(
    (requirement) => !hasPythonImport(candidate, requirement),
  );
  if (missing.length === 0) return;
  const expected = missing.map((requirement) =>
    requirement.name === undefined
      ? `import ${requirement.module}${requirement.alias ? ` as ${requirement.alias}` : ""}`
      : `from ${requirement.module} import ${requirement.name}${requirement.alias ? ` as ${requirement.alias}` : ""}`);
  throw new DirectCandidateValidationError(
    `${sourcePath}: candidate violates explicit requirements: `
    + expected.map((item) =>
      `The instruction explicitly requires the module-level Python import ${JSON.stringify(item)}, but the complete candidate does not contain it.`)
      .join(" "),
  );
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

/**
 * Compare only formatting-insensitive fragments. The rule layer is deliberately
 * narrow: when it has a complete expectation, extra statements or changed
 * operands are a contradiction rather than an alternative implementation.
 * Semicolons are optional in several supported languages, so one trailing
 * semicolon is not treated as a behavioral difference.
 */
function comparableRuleFragment(value: string): string {
  return value
    .trim()
    .replace(/;\s*$/u, "")
    .replace(/\s+/gu, "");
}

function validateLanguageRuleExpectation(
  unit: ConversionUnit,
  code: string,
  sourcePath: string,
): void {
  const expected = expectedCodeFromLanguageRules(unit);
  if (
    expected === undefined
    || comparableRuleFragment(code) === comparableRuleFragment(expected)
  ) {
    return;
  }
  throw new DirectCandidateValidationError(
    `${sourcePath}: model output contradicts a deterministic structural check`
    + ` for this instruction; expected a fragment equivalent to ${JSON.stringify(expected)}.`,
  );
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

/**
 * Validate a complete source candidate without importing or executing it.
 * Python uses its real AST so indentation, grammar, same-name nested
 * definitions, and trivially unreachable statements are covered; other
 * supported text languages retain the conservative delimiter parser.
 */
export async function validateCandidateFileSyntax(
  sourcePath: string,
  candidate: string,
  baseline?: string,
): Promise<void> {
  const extension = extname(sourcePath).toLowerCase();
  if (UNBALANCED_TEXT_EXTENSIONS.has(extension)) return;
  const syntaxDiagnostics = async (text: string): Promise<CandidateSyntaxDiagnostic[]> => {
    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
      return typeScriptSyntaxDiagnostics(text, sourcePath);
    }
    if (extension === ".py") return pythonSyntaxDiagnostics(text);
    return balancedSyntaxDiagnostics(text, sourcePath);
  };
  const baselineDiagnostics = baseline === undefined
    ? []
    : await syntaxDiagnostics(baseline);
  const candidateDiagnostics = await syntaxDiagnostics(candidate);
  const parserFailure = candidateDiagnostics.find((diagnostic) =>
    diagnostic.key.startsWith("python:parser-"));
  if (parserFailure) {
    throw new DirectCandidateValidationError(
      `${sourcePath}: generated candidate could not be syntax-validated: ${parserFailure.message}.`,
    );
  }
  const introduced = newlyIntroducedDiagnostic(baselineDiagnostics, candidateDiagnostics);
  if (introduced) {
    throw new DirectCandidateValidationError(
      `${sourcePath}: generated candidate failed syntax validation: ${introduced.message}.`,
    );
  }
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
  if (
    unit.kind !== "inline"
    || unit.ownsWholeFile
    || unit.selectedSource
    || !unit.surroundingSource
  ) return code;
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
    candidate: replaceScopedInlineUnit(
      baseline,
      unit as ConversionUnit & { range: { start: number; end: number } },
      code,
    ),
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
      content = replaceScopedInlineUnit(
        content,
        item.unit as ConversionUnit & { range: { start: number; end: number } },
        item.code,
      );
    }
    candidates.set(path, content);
  }
  return candidates;
}

/**
 * Refuse generated code that carries a live `@human` marker.
 *
 * Discovery would read such a marker as a fresh instruction on the next run, so
 * writing one lets model output enqueue work for the following invocation and
 * makes repeated runs non-idempotent. The same lexical extractor discovery uses
 * decides this, so marker-shaped text inside a string or a nested comment — the
 * only kind discovery ignores — is still allowed through.
 */
function comparableWords(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_$]+/gu) ?? [];
}

/**
 * Whether the emitted marker is essentially the unit's own instruction handed
 * back. Small models frequently restate the request as a comment instead of
 * writing code, and that deserves a different diagnosis from a model inventing a
 * genuinely new instruction — the first means "this model cannot do the task",
 * the second means "the output would queue work for a later run".
 */
function restatesInstruction(markerPrompt: string, instruction: string): boolean {
  const emitted = comparableWords(markerPrompt);
  const asked = new Set(comparableWords(instruction));
  if (emitted.length === 0 || asked.size === 0) return false;
  const shared = emitted.filter((word) => asked.has(word)).length;
  return shared / emitted.length >= 0.6;
}

function validateNoLiveMarker(
  unit: ConversionUnit,
  code: string,
  sourcePath: string,
): void {
  if (!MARKER_SCANNED_EXTENSIONS.has(extname(sourcePath).toLowerCase())) return;
  const markers = extractInlineMarkers(code, sourcePath);
  if (markers.length === 0) return;
  const emitted = markers[0]!.prompt;
  if (restatesInstruction(emitted, unit.prompt)) {
    throw new DirectCandidateValidationError(
      `${sourcePath}: the model restated the instruction as an @human comment instead of writing code`
      + ` (returned ${JSON.stringify(emitted.slice(0, 80))}).`
      + " This is what a model too small for code generation typically does; try a larger coding model.",
    );
  }
  throw new DirectCandidateValidationError(
    `${sourcePath}: generated code contains a live @human marker (${JSON.stringify(
      emitted.slice(0, 80),
    )}), which a later run would execute as a new instruction.`,
  );
}

function validateSelectedCodeEdit(unit: ConversionUnit, code: string): void {
  if (unit.selectedSource === undefined) return;
  if (code.trim() === unit.selectedSource.trim()) {
    throw new DirectCandidateValidationError(
      `${unit.sourcePath}: the model removed the @human marker but did not change the selected code requested by the instruction.`,
    );
  }
  const permitsLargeRemoval =
    /\b(?:delete|remove)\b/iu.test(unit.prompt)
    || /\b(?:replace|rewrite)\s+(?:the\s+)?(?:entire|whole)\s+(?:file|module)\b/iu.test(unit.prompt);
  if (
    !permitsLargeRemoval
    && Buffer.byteLength(code, "utf8")
      < Math.floor(Buffer.byteLength(unit.selectedSource, "utf8") / 2)
  ) {
    throw new DirectCandidateValidationError(
      `${unit.sourcePath}: selected-code edit discarded more than half of the selected source even though the instruction did not authorize a broad removal.`,
    );
  }
  if (!/\b(?:comment|documentation|document|docstring)\b/iu.test(unit.prompt)) {
    const existingComments = new Set(
      unit.selectedSource
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^(?:#|\/\/|\/\*|\*|<!--)/u.test(line)),
    );
    const addedComment = code
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) =>
        /^(?:#|\/\/|\/\*|\*|<!--)/u.test(line)
        && !existingComments.has(line));
    if (addedComment !== undefined) {
      throw new DirectCandidateValidationError(
        `${unit.sourcePath}: selected-code edit added a comment that the instruction did not request.`,
      );
    }
  }
}

/** Validate the complete candidate file before any direct-agent write occurs. */
export async function validateGeneratedUnit(unit: ConversionUnit, code: string): Promise<void> {
  if (code.trim().length === 0) throw new DirectCandidateValidationError(`${unit.sourcePath}: model returned no code.`);
  if (/^```/mu.test(code)) {
    throw new DirectCandidateValidationError(`${unit.sourcePath}: model formatting remained in generated source.`);
  }
  const sourcePath = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
  validateNoLiveMarker(unit, code, sourcePath);
  validateSelectedCodeEdit(unit, code);
  validateLanguageRuleExpectation(unit, code, sourcePath);
  validateExplicitRequirements(unit, code, sourcePath);
  if (extname(sourcePath).toLowerCase() === ".css" && unit.kind === "inline") validateCssReplacement(unit, code);
  const { baseline, candidate } = await sourceAndCandidateForUnit(unit, code);
  validatePythonImportRequirements(unit, candidate, sourcePath);
  await validateCandidateFileSyntax(sourcePath, candidate, baseline);
}
