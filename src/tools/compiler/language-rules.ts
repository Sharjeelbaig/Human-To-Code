/**
 * Deterministic compiler-mode lowering for small, high-confidence source
 * instructions. Rules translate a bounded natural-language subset into exact
 * target syntax; anything ambiguous returns undefined and stays on model codegen.
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
const IDENTIFIER_LIST = new RegExp(
  String.raw`\bparameters?\s+(?:named\s+)?(${IDENTIFIER}(?:\s*(?:,\s*|\s+and\s+)${IDENTIFIER})+)\b`,
  "iu",
);
const OPERATION = new RegExp(
  String.raw`\b(?:logic\s+(?:for|of)\s+)?(add(?:ing)?|subtract(?:ing)?|multip(?:ly|lying)|divid(?:e|ing))\s+(${IDENTIFIER})\s+(and|from|by)\s+(${IDENTIFIER})\b`,
  "iu",
);
const CALL = new RegExp(
  String.raw`\bcall(?:ing)?\s+(?:the\s+)?(${IDENTIFIER})(?:\s+function)?\s+with\s+(.+?)\s+(?:arguments?|parameters?)\b`,
  "iu",
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

function identifiersFromList(value: string): string[] {
  return value
    .split(/\s*(?:,|\band\b)\s*/iu)
    .map((item) => item.trim())
    .filter((item) => new RegExp(`^${IDENTIFIER}$`, "u").test(item));
}

function compileParameters(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const list = IDENTIFIER_LIST.exec(instruction)?.[1];
  const scalar = scalarKind(instruction);
  if (!list || !scalar) return undefined;
  const names = identifiersFromList(list);
  if (names.length < 2 || new Set(names).size !== names.length) return undefined;
  return names.map((name) => profile.parameter(name, scalar)).join(", ");
}

function operationSymbol(value: string): string | undefined {
  if (/^add/iu.test(value)) return "+";
  if (/^subtract/iu.test(value)) return "-";
  if (/^multip/iu.test(value)) return "*";
  if (/^divid/iu.test(value)) return "/";
  return undefined;
}

function compileReturn(
  instruction: string,
  profile: CompilerLanguageRuleProfile,
): string | undefined {
  const match = OPERATION.exec(instruction);
  if (!match) return undefined;
  const operator = operationSymbol(match[1]!);
  if (!operator) return undefined;
  const connector = match[3]!.toLowerCase();
  if (
    (operator === "+" || operator === "*") && connector !== "and"
    || operator === "/" && connector !== "by"
    || operator === "-" && connector !== "from" && connector !== "and"
  ) return undefined;
  const left = operator === "-" && connector === "from" ? match[4]! : match[2]!;
  const right = operator === "-" && connector === "from" ? match[2]! : match[4]!;
  return profile.returnExpression(`${left} ${operator} ${right}`);
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
  if (!/\b(?:console\s+log|print|output|display|write(?:line)?)\b/iu.test(instruction))
    return undefined;
  const call = CALL.exec(instruction);
  if (!call) return undefined;
  const args = literalArguments(call[2]!);
  if (!args) return undefined;
  const renderedArgs = args.map((item) => targetLiteral(profile.language, item));
  return profile.outputExpression(`${call[1]}(${renderedArgs.join(", ")})`);
}

/**
 * Compile only when the marker grammar and instruction match a complete,
 * unambiguous rule. Undefined deliberately means "ask the model".
 */
export function compileInstructionWithLanguageRules(
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
