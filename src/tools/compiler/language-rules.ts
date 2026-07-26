/**
 * Deterministic structural expectations for a small, high-confidence instruction
 * subset. Rules render the fragment a model answer must be equivalent to; they
 * are validation-only and never provide candidate code to the runtime.
 */
import { extname } from "node:path";
import { languageForExtension } from "../discovery/languages.ts";
import type { ConversionUnit } from "../../workflows/types.ts";

type ScalarKind = "number" | "integer" | "string" | "boolean";

export interface CompilerLanguageRuleProfile {
  language: string;
  parameter(name: string, scalar: ScalarKind): string;
  returnExpression(expression: string): string;
  outputExpression(expression: string): string | undefined;
}

function typedProfile(
  language: string,
  types: Readonly<Record<ScalarKind, string>>,
  outputExpression: CompilerLanguageRuleProfile["outputExpression"],
  options: {
    parameterOrder?: "colon" | "name-first-space" | "type-first";
    semicolon?: boolean;
  } = {},
): CompilerLanguageRuleProfile {
  return Object.freeze({
    language,
    parameter: (name: string, scalar: ScalarKind) =>
      options.parameterOrder === "type-first"
        ? `${types[scalar]} ${name}`
        : options.parameterOrder === "name-first-space"
          ? `${name} ${types[scalar]}`
          : `${name}: ${types[scalar]}`,
    returnExpression: (expression: string) =>
      `return ${expression}${options.semicolon === false ? "" : ";"}`,
    outputExpression,
  });
}

function untypedProfile(
  language: string,
  outputExpression: CompilerLanguageRuleProfile["outputExpression"],
  semicolon: boolean,
): CompilerLanguageRuleProfile {
  return Object.freeze({
    language,
    parameter: (name: string) => name,
    returnExpression: (expression: string) => `return ${expression}${semicolon ? ";" : ""}`,
    outputExpression,
  });
}

/** One explicit syntax profile for every language accepted by discovery. */
export const COMPILER_LANGUAGE_RULE_PROFILES: Readonly<Record<string, CompilerLanguageRuleProfile>> =
  Object.freeze({
    typescript: typedProfile(
      "typescript",
      { number: "number", integer: "number", string: "string", boolean: "boolean" },
      (expression) => `console.log(${expression});`,
    ),
    javascript: untypedProfile(
      "javascript",
      (expression) => `console.log(${expression});`,
      true,
    ),
    python: typedProfile(
      "python",
      { number: "float", integer: "int", string: "str", boolean: "bool" },
      (expression) => `print(${expression})`,
      { semicolon: false },
    ),
    rust: typedProfile(
      "rust",
      { number: "f64", integer: "i64", string: "&str", boolean: "bool" },
      (expression) => `println!("{}", ${expression});`,
    ),
    go: typedProfile(
      "go",
      { number: "float64", integer: "int", string: "string", boolean: "bool" },
      (expression) => `println(${expression})`,
      { parameterOrder: "name-first-space", semicolon: false },
    ),
    java: typedProfile(
      "java",
      { number: "double", integer: "int", string: "String", boolean: "boolean" },
      (expression) => `System.out.println(${expression});`,
      { parameterOrder: "type-first" },
    ),
    ruby: untypedProfile(
      "ruby",
      (expression) => `puts ${expression}`,
      false,
    ),
    csharp: typedProfile(
      "csharp",
      { number: "double", integer: "int", string: "string", boolean: "bool" },
      (expression) => `System.Console.WriteLine(${expression});`,
      { parameterOrder: "type-first" },
    ),
    cpp: typedProfile(
      "cpp",
      { number: "double", integer: "int", string: "std::string", boolean: "bool" },
      () => undefined,
      { parameterOrder: "type-first" },
    ),
    c: typedProfile(
      "c",
      { number: "double", integer: "int", string: "const char *", boolean: "bool" },
      () => undefined,
      { parameterOrder: "type-first" },
    ),
    // HTML and CSS participate in compiler prompting and validation, but do
    // not have function parameters, return statements, or callable output.
    html: untypedProfile("html", () => undefined, false),
    css: untypedProfile("css", () => undefined, false),
  });

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/**
 * Closed-class filler removed before any structural rule reads an instruction.
 *
 * These rules used to be a code-generation fast path. They now derive narrow
 * expectations for validating model output, so `parameters x and y` and the
 * equally unambiguous `parameters that are x and y` receive the same optional
 * structural check after both have been reasoned through by the model.
 *
 * Removal can only ever *delete* words, so a phrasing this mangles fails to match
 * and defers to the model. It cannot invent an identifier, which is the only
 * direction that would produce wrong code.
 */
const FILLER_PHRASES: readonly string[] = [
  "that are", "which are", "that is", "which is",
  "consisting of", "comprised of", "comprising", "made up of",
  "defined as", "declared as", "as follows", "namely",
  "named", "called", "labelled", "labeled",
  "both", "each", "respectively", "please",
];

/**
 * Words that are never an identifier in these instructions. Without this, a
 * relaxed list pattern would happily read the connective in
 * `the parameters and totals` as a variable called `and`.
 */
const NON_IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "of", "on", "or", "the", "then", "to", "with", "without",
  "argument", "arguments", "parameter", "parameters", "type", "types",
  "value", "values", "variable", "variables",
  "number", "numbers", "integer", "integers", "float", "floats", "double",
  "doubles", "string", "strings", "text", "texts", "boolean", "booleans",
  "bool", "bools", "logic", "function", "result", "sum", "difference",
  "product", "quotient", "return", "returns", "returning",
  // Counts, so `two number parameters x and y` cannot read `two` as a name.
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

const FILLER_PATTERN = new RegExp(
  String.raw`\b(?:${FILLER_PHRASES.map((phrase) => phrase.replace(/ /gu, String.raw`\s+`)).join("|")})\b`,
  "giu",
);

/**
 * Deterministically reduce an instruction to the wording the structural rules
 * read. Punctuation that only separates a role from its operands becomes a
 * space, filler disappears, and whitespace collapses. The result is never shown
 * to a user or a model; it exists only so matching is phrasing-insensitive.
 */
export function normalizeRuleInstruction(instruction: string): string {
  return instruction
    .replace(/[:;]/gu, " ")
    .replace(FILLER_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const SCALAR_WORD = String.raw`(?:number|integer|float|double|string|text|boolean|bool)s?`;

/** `the parameters x and y`, `parameters x, y`, `parameter total`. */
const PARAMETERS_FORWARD = new RegExp(
  String.raw`\bparameters?\s+(${IDENTIFIER}(?:\s*(?:,\s*|\s+and\s+)${IDENTIFIER})*)\b`,
  "iu",
);
/** The reversed phrasing: `x and y as number parameters`. */
const PARAMETERS_REVERSED = new RegExp(
  String.raw`\b(${IDENTIFIER}(?:\s*(?:,\s*|\s+and\s+)${IDENTIFIER})*)\s+as\s+(?:${SCALAR_WORD}\s+)?parameters?\b`,
  "iu",
);
/** Explicit annotations, the least ambiguous form: `x number, y number`. */
const TYPED_PAIR = new RegExp(
  String.raw`\b(${IDENTIFIER})\s+(${SCALAR_WORD})\b`,
  "giu",
);

const VERB_OPERATION = new RegExp(
  String.raw`\b(?:logic\s+(?:for|of)\s+)?(add(?:ing)?|subtract(?:ing)?|multip(?:ly|lying)|divid(?:e|ing))\s+(${IDENTIFIER})\s+(and|from|by)\s+(${IDENTIFIER})\b`,
  "iu",
);
/** `the sum of x and y`, `the quotient of x by y`. */
const NOUN_OPERATION = new RegExp(
  String.raw`\b(sum|total|difference|product|quotient)\s+of\s+(${IDENTIFIER})\s+(and|from|by|over)\s+(${IDENTIFIER})\b`,
  "iu",
);
/** Spelled-out operators: `x plus y`, `x divided by y`. */
const WORD_OPERATION = new RegExp(
  String.raw`\b(${IDENTIFIER})\s+(plus|minus|times|multiplied\s+by|divided\s+by|over)\s+(${IDENTIFIER})\b`,
  "iu",
);
/** Literal operators the author already wrote: `return x + y`. */
const SYMBOL_OPERATION = new RegExp(
  String.raw`\b(${IDENTIFIER})\s*([+\-*/])\s*(${IDENTIFIER})\b`,
  "u",
);

/** `calling the add function with 1, 2 arguments`. */
const CALL_PHRASE = new RegExp(
  String.raw`\bcall(?:ing)?\s+(?:the\s+)?(${IDENTIFIER})(?:\s+function)?\s+with\s+(.+?)\s+(?:arguments?|parameters?)\b`,
  "iu",
);
/** Call syntax the author already wrote: `add(1, 2)`. */
const CALL_SYNTAX = new RegExp(
  String.raw`\b(${IDENTIFIER})\s*\(\s*([^()]*?)\s*\)`,
  "u",
);

function targetLanguage(unit: ConversionUnit): string | undefined {
  if (unit.language) return unit.language.toLowerCase();
  const path = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
  return languageForExtension(extname(path));
}

function scalarKind(instruction: string): ScalarKind | undefined {
  if (/\b(?:nonnegative\s+)?integers?\b/iu.test(instruction)) return "integer";
  if (/\bnumbers?\b|\b(?:floats?|doubles?)\b/iu.test(instruction)) return "number";
  if (/\bstrings?\b|\btexts?\b/iu.test(instruction)) return "string";
  if (/\bbooleans?\b|\bbools?\b/iu.test(instruction)) return "boolean";
  return undefined;
}

/**
 * Whether a captured word is grammar rather than a name.
 *
 * Single characters are always treated as names. `a`, `b`, `c` are ordinary
 * variables in exactly the arithmetic instructions these rules serve, and
 * rejecting `a` as the English article silently dropped it from
 * `parameters a, b and c`, emitting two parameters where three were asked for.
 * No one-letter word can be captured as a whole operand list by these patterns,
 * so nothing is lost by trusting them.
 */
function isGrammarWord(item: string): boolean {
  return item.length > 1 && NON_IDENTIFIER_WORDS.has(item.toLowerCase());
}

/**
 * Split a captured list into identifiers, dropping any word that is grammar
 * rather than a name. A list that loses a member this way simply fails the
 * caller's checks and defers to the model.
 */
function identifiersFromList(value: string): string[] {
  return value
    .split(/\s*(?:,|\band\b)\s*/iu)
    .map((item) => item.trim())
    .filter((item) => new RegExp(`^${IDENTIFIER}$`, "u").test(item))
    .filter((item) => !isGrammarWord(item));
}

/** Per-name annotations, used only when every name carries its own type. */
function annotatedParameters(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const pairs = [...instruction.matchAll(TYPED_PAIR)]
    .map((match) => ({ name: match[1]!, word: match[2]! }))
    .filter((pair) => !isGrammarWord(pair.name));
  if (pairs.length < 2) return undefined;
  if (new Set(pairs.map((pair) => pair.name)).size !== pairs.length) return undefined;
  const rendered: string[] = [];
  for (const pair of pairs) {
    const scalar = scalarKind(pair.word);
    if (!scalar) return undefined;
    rendered.push(profile.parameter(pair.name, scalar));
  }
  return rendered.join(", ");
}

function compileParameters(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const normalized = normalizeRuleInstruction(instruction);
  // Per-name annotations are the most explicit form and must win: the list
  // patterns below would otherwise capture only the first name of
  // `x number, y number` and silently drop the rest.
  const annotated = annotatedParameters(normalized, profile);
  if (annotated !== undefined) return annotated;
  const scalar = scalarKind(normalized);
  if (!scalar) return undefined;
  // Every shape is tried until one yields a usable list. Stopping at the first
  // pattern that merely *matched* would lose `x and y as parameters with number
  // types`, where the forward shape captures the connective `with` and nothing
  // else.
  for (const pattern of [PARAMETERS_FORWARD, PARAMETERS_REVERSED]) {
    const list = pattern.exec(normalized)?.[1];
    if (list === undefined) continue;
    const names = identifiersFromList(list);
    if (names.length === 0 || new Set(names).size !== names.length) continue;
    return names.map((name) => profile.parameter(name, scalar)).join(", ");
  }
  return undefined;
}

function operationSymbol(value: string): string | undefined {
  if (/^(?:add|sum|total|plus)/iu.test(value)) return "+";
  if (/^(?:subtract|difference|minus)/iu.test(value)) return "-";
  if (/^(?:multip|product|times)/iu.test(value)) return "*";
  if (/^(?:divid|quotient|over)/iu.test(value)) return "/";
  return undefined;
}

/**
 * Whether a connective is coherent with the operator it joins. `x from y` only
 * makes sense for subtraction and reverses the operands; `x by y` only for
 * division. A mismatch means the instruction was not the shape it looked like,
 * so it defers rather than guessing an order.
 */
function operandsFor(
  operator: string,
  connector: string,
  first: string,
  second: string,
): { left: string; right: string } | undefined {
  const joint = connector.toLowerCase();
  if (operator === "+" || operator === "*") {
    return joint === "and" ? { left: first, right: second } : undefined;
  }
  if (operator === "/") {
    return joint === "by" || joint === "over" ? { left: first, right: second } : undefined;
  }
  if (joint === "from") return { left: second, right: first };
  return joint === "and" ? { left: first, right: second } : undefined;
}

function compileReturn(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const normalized = normalizeRuleInstruction(instruction);

  // A literal operator the author already wrote needs no interpretation.
  const symbolic = SYMBOL_OPERATION.exec(normalized);
  if (symbolic) {
    const [, left, operator, right] = symbolic;
    if (!isGrammarWord(left!) && !isGrammarWord(right!)) {
      return profile.returnExpression(`${left} ${operator} ${right}`);
    }
  }

  const worded = WORD_OPERATION.exec(normalized);
  if (worded) {
    const [, first, word, second] = worded;
    const operator = operationSymbol(word!.replace(/\s+.*$/u, ""));
    if (operator && !isGrammarWord(first!) && !isGrammarWord(second!)) {
      // `divided by` and `over` already imply their operand order.
      return profile.returnExpression(`${first} ${operator} ${second}`);
    }
  }

  const match = VERB_OPERATION.exec(normalized) ?? NOUN_OPERATION.exec(normalized);
  if (!match) return undefined;
  const operator = operationSymbol(match[1]!);
  if (!operator) return undefined;
  const operands = operandsFor(operator, match[3]!, match[2]!, match[4]!);
  if (!operands) return undefined;
  if (isGrammarWord(operands.left) || isGrammarWord(operands.right)) return undefined;
  return profile.returnExpression(`${operands.left} ${operator} ${operands.right}`);
}

function literalArguments(value: string): string[] | undefined {
  const parts = value.split(/\s*,\s*|\s+and\s+/iu).map((item) => item.trim());
  if (parts.length === 0 || parts.length > 12) return undefined;
  return parts.every((item) =>
    /^-?\d+(?:\.\d+)?$/u.test(item)
    || /^(?:true|false|null|none)$/iu.test(item)
    || /^["'][^"'\\\r\n]{0,200}["']$/u.test(item))
    ? parts
    : undefined;
}

function targetLiteral(language: string, value: string): string {
  if (/^-?\d+(?:\.\d+)?$/u.test(value) || /^["']/u.test(value)) return value;
  const normalized = value.toLowerCase();
  if (language === "python") {
    if (normalized === "true") return "True";
    if (normalized === "false") return "False";
    return "None";
  }
  if (language === "ruby") {
    return normalized === "none" || normalized === "null" ? "nil" : normalized;
  }
  if (language === "rust") {
    return normalized === "none" || normalized === "null" ? "None" : normalized;
  }
  if (language === "go") {
    return normalized === "none" || normalized === "null" ? "nil" : normalized;
  }
  if (language === "cpp") {
    return normalized === "none" || normalized === "null" ? "nullptr" : normalized;
  }
  if (language === "c") {
    return normalized === "none" || normalized === "null" ? "NULL" : normalized;
  }
  return normalized === "none" ? "null" : normalized;
}

function compileOutputCall(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const normalized = normalizeRuleInstruction(instruction);
  if (!/\b(?:console\s+log|log|print|output|display|write(?:line)?)\b/iu.test(normalized))
    return undefined;
  const call = CALL_PHRASE.exec(normalized) ?? CALL_SYNTAX.exec(normalized);
  if (!call) return undefined;
  const callee = call[1]!;
  if (isGrammarWord(callee)) return undefined;
  const args = literalArguments(call[2]!);
  if (!args) return undefined;
  const renderedArgs = args.map((item) => targetLiteral(profile.language, item));
  return profile.outputExpression(`${callee}(${renderedArgs.join(", ")})`);
}

/**
 * Derive an expected replacement only when the marker grammar and instruction
 * match a complete, unambiguous rule. The runtime never uses this value as
 * generated code: every unreplayed instruction is sent to the model first, and
 * this expectation can only reject output that contradicts a narrow structural
 * requirement. Undefined means the general validators decide on their own.
 */
export function expectedCodeFromLanguageRules(
  unit: ConversionUnit,
): string | undefined {
  const language = targetLanguage(unit);
  const profile = language === undefined
    ? undefined
    : COMPILER_LANGUAGE_RULE_PROFILES[language];
  if (!profile) return undefined;
  if (unit.insertionContext === "parameter-list") {
    return compileParameters(unit.prompt, profile);
  }
  if (unit.insertionContext === "function-body") {
    return compileReturn(unit.prompt, profile);
  }
  if (unit.insertionContext === "statement") {
    return compileOutputCall(unit.prompt, profile);
  }
  return undefined;
}

/**
 * Model names from local runtimes commonly include a parameter-size suffix
 * (`270m`, `0.5b`, `1.5b`). The smallest explicit sizes are unlikely to generate
 * usable code. This classification is advisory only and never changes routing.
 */
export function isModelLikelyTooSmallForCode(model: string): boolean {
  const matches = [...model.toLowerCase().matchAll(/(?:^|[:_-])(\d+(?:\.\d+)?)([mb])(?:$|[-_])/gu)];
  const match = matches.at(-1);
  if (!match) return false;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return false;
  const millions = match[2] === "b" ? value * 1_000 : value;
  return millions <= 500;
}

/**
 * Compatibility alias for the 1.0 API. It returns a validation expectation;
 * Human-to-Code itself never uses the result to bypass model generation.
 *
 * @deprecated Use `expectedCodeFromLanguageRules`.
 */
export const compileInstructionWithLanguageRules = expectedCodeFromLanguageRules;

/**
 * Compatibility alias for the 1.0 API. Model size is now warning-only.
 *
 * @deprecated Use `isModelLikelyTooSmallForCode`.
 */
export const prefersDeterministicLanguageRules = isModelLikelyTooSmallForCode;
