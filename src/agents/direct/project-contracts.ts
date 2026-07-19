/**
 * Static, language-aware contract extraction for ProjectMemory. These compact
 * summaries expose relationships and public structure without executing source
 * or sending whole files. Credential-bearing content yields no contract.
 */
import { basename, extname } from "node:path";
import { scanSecrets } from "../../context/context.ts";
import { extractStaticFileMemory } from "../../pipeline/file-memory.ts";

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
  /** Class names passed to classList add/remove/toggle/contains. */
  toggledClasses: string[];
  /** True when the source assigns `.hidden` or sets the `hidden` attribute. */
  togglesHiddenAttribute: boolean;
}

export function htmlFacts(content: string): HtmlFacts {
  const handlerExpressions = [...content.matchAll(/\bon[a-z][a-z0-9_-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)]
    .map((match) => match[1] ?? match[2] ?? "");
  return {
    stylesheets: matches(
      content,
      /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/giu,
    ),
    scripts: matches(content, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu),
    ids: matches(content, /\bid\s*=\s*["']([^"']+)["']/giu).flatMap((value) => value.split(/\s+/u)),
    classes: matches(content, /\bclass\s*=\s*["']([^"']+)["']/giu).flatMap((value) => value.split(/\s+/u)),
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

export function javaScriptFacts(content: string): JavaScriptFacts {
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
    toggledClasses: matches(
      content,
      /\bclassList\s*\.\s*(?:add|remove|toggle|contains)\s*\(\s*["']([^"']+)["']/gu,
    ).flatMap((value) => value.split(/\s+/u)),
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
