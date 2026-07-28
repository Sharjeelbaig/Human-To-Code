/**
 * Static, language-aware contract extraction for ProjectMemory. These compact
 * summaries expose relationships and public structure without executing source
 * or sending whole files. Credential-bearing content yields no contract.
 */
import { basename, extname } from "node:path";
import { scanSecrets } from "../memory/context.ts";
import { extractStaticFileMemory } from "../memory/file-memory-extraction.ts";

const MAX_CONTRACT_CHARS = 2_400;
const MAX_CONTRACT_ITEMS = 24;

export const PROJECT_CONTRACT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".html", ".htm", ".css", ".py", ".rs", ".go", ".java", ".rb",
  ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".json",
]);

export const PROJECT_MANIFEST_NAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt",
  "pyproject.toml", "CMakeLists.txt", "Makefile",
]);

function oneLine(value: string, limit: number): string {
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

function unique(values: Iterable<string>, limit = MAX_CONTRACT_ITEMS): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = oneLine(value, 180);
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function matches(content: string, expression: RegExp, group = 1): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(expression)) {
    const value = match[group];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function listLine(label: string, values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : `${label}: ${values.join(", ")}`;
}

/**
 * Raw extraction results. These are deliberately uncapped and unformatted: the
 * `*Contract` renderers below apply the compact `unique()` limits, while
 * cross-file reference checking needs the complete sets. One parser, two
 * consumers — never add a second scanner for the same syntax.
 */
export interface HtmlFacts {
  stylesheets: string[];
  scripts: string[];
  ids: string[];
  classes: string[];
  /** Static class tokens grouped by the element that owns them. */
  classSets: string[][];
  emptyClassSets: string[][];
  handlerCalls: string[];
  operationLabels: string[];
  numberLabels: string[];
  landmarks: string[];
  elements: string[];
}

export interface CssFacts {
  imports: string[];
  urls: string[];
  customProperties: string[];
  selectors: string[];
}

export interface JavaScriptFacts {
  modules: string[];
  selectors: string[];
  /** Class names passed as string literals to classList add/remove/toggle/contains. */
  toggledClasses: string[];
  /**
   * True when a class name reaches the DOM through something other than a plain
   * string literal — a template literal, a variable, a ternary branch. The real
   * class set is then beyond static reach, so no static pass may declare a rule
   * that mentions those classes dead.
   */
  dynamicClassNames: boolean;
  /** Element ids the script assigns, as string literals. */
  assignedIds: string[];
  /** True when an id reaches the DOM as something other than a string literal. */
  dynamicIds: boolean;
  /**
   * True when the script creates elements or writes markup — `createElement`,
   * `innerHTML`, `insertAdjacentHTML`, `append`. Elements this scanner never
   * sees can then carry any id or class.
   */
  buildsMarkup: boolean;
  /**
   * True when the script writes children or text into an existing element, so
   * an element that is empty in the markup need not be empty when painted.
   */
  injectsContent: boolean;
  /** Static class and className tokens rendered by JSX or DOM-like templates. */
  renderedClasses: string[];
  /** Static JSX className tokens grouped by the element that owns them. */
  renderedClassSets: string[][];
  /** Static class sets on self-closing or empty JSX elements. */
  emptyRenderedClassSets: string[][];
  /** True when the source assigns `.hidden` or sets the `hidden` attribute. */
  togglesHiddenAttribute: boolean;
}

export function htmlFacts(content: string): HtmlFacts {
  const handlerExpressions = [...content.matchAll(/\bon[a-z][a-z0-9_-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)]
    .map((match) => match[1] ?? match[2] ?? "");
  const classSets = [...content.matchAll(/<[^>]*\bclass\s*=\s*["']([^"']+)["'][^>]*>/giu)]
    .map((match) => (match[1] ?? "").split(/\s+/u).filter(Boolean));
  const emptyClassSets = [
    ...content.matchAll(/<[^>]*\bclass\s*=\s*["']([^"']+)["'][^>]*\/\s*>/giu),
    ...content.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bclass\s*=\s*["']([^"']+)["'][^>]*>\s*<\/\1\s*>/giu),
  ].map((match) => (match[2] ?? match[1] ?? "").split(/\s+/u).filter(Boolean));
  return {
    stylesheets: matches(
      content,
      /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/giu,
    ),
    scripts: matches(content, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu),
    ids: matches(content, /\bid\s*=\s*["']([^"']+)["']/giu).flatMap((value) => value.split(/\s+/u)),
    classes: matches(content, /\bclass\s*=\s*["']([^"']+)["']/giu).flatMap((value) => value.split(/\s+/u)),
    classSets,
    emptyClassSets,
    handlerCalls: handlerExpressions
      .flatMap((handler) => matches(handler, /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu)),
    operationLabels: matches(
      content,
      /<button\b(?=[^>]*\bdata-operation(?:\s|=|>))[^>]*>\s*([^<]*?)\s*<\/button>/giu,
    ),
    numberLabels: matches(
      content,
      /<button\b(?=[^>]*\bdata-number(?:\s|=|>))[^>]*>\s*([^<]*?)\s*<\/button>/giu,
    ),
    landmarks: matches(content, /<(header|nav|main|section|article|aside|footer|form)\b/giu),
    elements: matches(content, /<([a-z][a-z0-9-]*)\b/giu),
  };
}

export function cssFacts(content: string): CssFacts {
  return {
    imports: matches(content, /@import\s+(?:url\(\s*)?["']([^"']+)["']/giu),
    urls: matches(content, /url\(\s*["']?([^"')\s]+)["']?\s*\)/giu),
    customProperties: matches(content, /(^|[;{]\s*)(--[A-Za-z0-9_-]+)\s*:/gmu, 2),
    selectors: matches(content, /(?:^|\})\s*([^@{}][^{}]{0,240})\s*\{/gmu)
      .flatMap((value) => value.split(",")),
  };
}

/**
 * Text of every `classList.*` argument that names a class, bounded and
 * unparsed. `toggle`'s second argument is a boolean force flag, not a class,
 * so it is dropped. One scan feeds both the literal names and the
 * dynamic-composition signal.
 */
function classNameArguments(content: string): string[] {
  return [
    ...content.matchAll(
      /\bclassList\s*\.\s*(add|remove|toggle|contains|replace)\s*\(([^)]{0,400})/gu,
    ),
  ].map((match) => {
    const args = match[2] ?? "";
    return match[1] === "toggle" ? (args.split(",")[0] ?? "") : args;
  });
}

/**
 * An expression composes a class name at runtime when it carries no string
 * literal to read, or interpolates one. A ternary between two literals is not
 * dynamic: both outcomes are already known.
 */
function composesClassNameAtRuntime(expression: string): boolean {
  if (expression.trim().length === 0) return false;
  if (/`[^`]*\$\{/u.test(expression)) return true;
  return !/["'][^"'`]*["']/u.test(expression);
}

export function javaScriptFacts(content: string): JavaScriptFacts {
  const classNameArgs = classNameArguments(content);
  const classNameAssignments = [
    ...matches(content, /\bclassName\s*\+?=([^=;\n]{0,200})/gu),
    ...matches(content, /\bsetAttribute\s*\(\s*["']class["']\s*,([^)]{0,200})/gu),
  ];
  const idAssignments = [
    ...matches(content, /\.\s*id\s*=([^=;\n]{0,200})/gu),
    ...matches(content, /\bsetAttribute\s*\(\s*["']id["']\s*,([^)]{0,200})/gu),
  ];
  const jsxClassSets = [...content.matchAll(/<[^>]*\bclass(?:Name)?\s*=\s*["']([^"']+)["'][^>]*>/giu)]
    .map((match) => (match[1] ?? "").split(/\s+/u).filter(Boolean));
  // A whole-attribute assignment renders those classes together on one element,
  // exactly like a static `class` attribute does.
  const assignedClassSets = [
    ...matches(content, /\bclassName\s*=\s*["']([^"']+)["']/gu),
    ...matches(content, /\bsetAttribute\s*\(\s*["']class["']\s*,\s*["']([^"']+)["']/gu),
  ].map((value) => value.split(/\s+/u).filter(Boolean));
  const renderedClassSets = [...jsxClassSets, ...assignedClassSets];
  const emptyRenderedClassSets = [
    ...content.matchAll(/<[^>]*\bclass(?:Name)?\s*=\s*["']([^"']+)["'][^>]*\/\s*>/giu),
    ...content.matchAll(/<([A-Za-z][A-Za-z0-9.]*)\b[^>]*\bclass(?:Name)?\s*=\s*["']([^"']+)["'][^>]*>\s*<\/\1\s*>/gu),
  ].map((match) => (match[2] ?? match[1] ?? "").split(/\s+/u).filter(Boolean));
  return {
    modules: [
      ...matches(content, /\b(?:import|export)\b[\s\S]{0,240}?\bfrom\s*["']([^"']+)["']/gu),
      ...matches(content, /\bimport\s*["']([^"']+)["']/gu),
      ...matches(content, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ],
    selectors: [
      ...matches(content, /\bquerySelector(?:All)?\s*\(\s*["']([^"']+)["']/gu),
      ...matches(content, /\bgetElementById\s*\(\s*["']([^"']+)["']/gu).map((value) => `#${value}`),
    ],
    // Every string literal anywhere in the argument list, so a ternary, a
    // multi-argument call, and a literal sitting beside a variable all count.
    toggledClasses: classNameArgs
      .flatMap((args) => matches(args, /(["'])([^"'`]*)\1/gu, 2))
      .flatMap((value) => value.split(/\s+/u))
      .filter(Boolean),
    dynamicClassNames: [...classNameArgs, ...classNameAssignments].some(
      composesClassNameAtRuntime,
    ),
    assignedIds: idAssignments
      .flatMap((value) => matches(value, /(["'])([^"'`]*)\1/gu, 2))
      .flatMap((value) => value.split(/\s+/u))
      .filter(Boolean),
    dynamicIds: idAssignments.some(composesClassNameAtRuntime),
    buildsMarkup:
      /\b(?:createElement|createElementNS|insertAdjacentHTML|cloneNode)\s*\(/u.test(content)
      || /\b(?:innerHTML|outerHTML)\s*\+?=/u.test(content),
    injectsContent:
      /\b(?:innerHTML|outerHTML|textContent|innerText)\s*\+?=/u.test(content)
      || /\.\s*(?:append|appendChild|prepend|replaceChildren|insertAdjacentHTML|insertAdjacentElement|insertBefore)\s*\(/u.test(content),
    renderedClasses: matches(content, /\bclass(?:Name)?\s*=\s*["']([^"']+)["']/giu)
      .flatMap((value) => value.split(/\s+/u)),
    renderedClassSets,
    emptyRenderedClassSets,
    togglesHiddenAttribute: /\.hidden\s*=|\b(?:set|remove)Attribute\s*\(\s*["']hidden["']/u.test(content),
  };
}

function htmlContract(content: string): string[] {
  const facts = htmlFacts(content);
  return [
    listLine("stylesheets", unique(facts.stylesheets)),
    listLine("scripts", unique(facts.scripts)),
    listLine("ids", unique(facts.ids)),
    listLine("classes", unique(facts.classes)),
    listLine("inline handler calls", unique(facts.handlerCalls)),
    listLine("data-operation button labels", unique(facts.operationLabels)),
    listLine("data-number button labels", unique(facts.numberLabels)),
    listLine("landmarks", unique(facts.landmarks)),
    listLine("elements", unique(facts.elements)),
  ].filter((line): line is string => line !== undefined);
}

function cssContract(content: string): string[] {
  const facts = cssFacts(content);
  return [
    listLine("imports", unique(facts.imports)),
    listLine("asset URLs", unique(facts.urls)),
    listLine("custom properties", unique(facts.customProperties)),
    listLine("selectors", unique(facts.selectors)),
  ].filter((line): line is string => line !== undefined);
}

function javascriptContract(content: string): string[] {
  const facts = javaScriptFacts(content);
  // `toggledClasses` and `togglesHiddenAttribute` are reference-check facts
  // only; adding them here would change every existing contract snapshot.
  return [
    listLine("module references", unique(facts.modules)),
    listLine("DOM selectors", unique(facts.selectors)),
  ].filter((line): line is string => line !== undefined);
}

function genericReferences(path: string, content: string): string[] {
  const extension = extname(path).toLowerCase();
  if ([".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) {
    return [listLine("includes", unique(matches(content, /^\s*#\s*include\s*["<]([^">]+)[">]/gmu)))]
      .filter((line): line is string => line !== undefined);
  }
  if (extension === ".py") {
    const imports = [
      ...matches(content, /^\s*from\s+([A-Za-z0-9_.]+)\s+import/gmu),
      ...matches(content, /^\s*import\s+([A-Za-z0-9_.]+)/gmu),
    ];
    return [listLine("imports", unique(imports))]
      .filter((line): line is string => line !== undefined);
  }
  if (extension === ".rs") {
    const uses = matches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+)\s*;/gmu);
    const modules = matches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gmu);
    const crates = matches(content, /^\s*extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gmu);
    return [
      listLine("use paths", unique(uses)),
      listLine("modules", unique(modules)),
      listLine("external crates", unique(crates)),
    ].filter((line): line is string => line !== undefined);
  }
  if (extension === ".go") {
    const packageName = matches(content, /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/gmu);
    const singleImports = matches(
      content,
      /^\s*import\s+(?:[._A-Za-z][A-Za-z0-9_]*\s+)?["`]([^"`]+)["`]/gmu,
    );
    const blockImports = matches(content, /^\s*import\s*\(([\s\S]*?)^\s*\)/gmu)
      .flatMap((block) => matches(block, /^\s*(?:[._A-Za-z][A-Za-z0-9_]*\s+)?["`]([^"`]+)["`]/gmu));
    return [
      listLine("package", unique(packageName, 1)),
      listLine("imports", unique([...singleImports, ...blockImports])),
    ].filter((line): line is string => line !== undefined);
  }
  if (extension === ".java") {
    const packageName = matches(content, /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/gmu);
    const imports = matches(content, /^\s*import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.*]*)\s*;/gmu);
    return [
      listLine("package", unique(packageName, 1)),
      listLine("imports", unique(imports)),
    ].filter((line): line is string => line !== undefined);
  }
  if (extension === ".cs") {
    const namespaces = matches(content, /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)/gmu);
    const imports = matches(content, /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*;/gmu);
    return [
      listLine("namespaces", unique(namespaces)),
      listLine("using directives", unique(imports)),
    ].filter((line): line is string => line !== undefined);
  }
  if (extension === ".rb") {
    const requires = matches(content, /^\s*require\s+["']([^"']+)["']/gmu);
    const relativeRequires = matches(content, /^\s*require_relative\s+["']([^"']+)["']/gmu);
    return [
      listLine("requires", unique(requires)),
      listLine("relative requires", unique(relativeRequires)),
    ].filter((line): line is string => line !== undefined);
  }
  return [];
}

function jsonManifestContract(path: string, content: string): string[] {
  if (basename(path) !== "package.json") return [];
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const dependencies = ["dependencies", "devDependencies", "peerDependencies"]
      .flatMap((key) => {
        const value = parsed[key];
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.keys(value as Record<string, unknown>)
          : [];
      });
    const scripts = typeof parsed.scripts === "object" && parsed.scripts !== null && !Array.isArray(parsed.scripts)
      ? Object.keys(parsed.scripts as Record<string, unknown>)
      : [];
    return [
      typeof parsed.type === "string" ? `module type: ${oneLine(parsed.type, 40)}` : undefined,
      listLine("dependencies", unique(dependencies)),
      listLine("script names", unique(scripts)),
    ].filter((line): line is string => line !== undefined);
  } catch {
    return [];
  }
}

/** Extract a bounded interface/relationship summary without executing source. */
export function compactFileContract(path: string, content: string): string {
  if (scanSecrets(content).length > 0) return "";
  const extension = extname(path).toLowerCase();
  const details = extension === ".html" || extension === ".htm"
    ? htmlContract(content)
    : extension === ".css"
      ? cssContract(content)
      : [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)
        ? javascriptContract(content)
        : extension === ".json"
          ? jsonManifestContract(path, content)
          : genericReferences(path, content);
  const declarations = extractStaticFileMemory(path, content)
    .slice(0, MAX_CONTRACT_ITEMS)
    .map((entry) => oneLine(entry.code, 220));
  const lines = [
    ...details,
    ...(declarations.length > 0 ? [`declarations: ${declarations.join(" | ")}`] : []),
  ];
  const rendered = lines.join("\n");
  return rendered.length <= MAX_CONTRACT_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_CONTRACT_CHARS - 1)}…`;
}
