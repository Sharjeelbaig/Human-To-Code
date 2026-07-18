/**
 * Extensible language relationship profiles used by ProjectMemory. The
 * orchestration layer consumes only paths/roles/references; ecosystem-specific
 * knowledge stays in this registry rather than in integration control flow.
 */
import { extname } from "node:path";

const SCRIPT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const BROWSER_SCRIPT = new Set([".js", ".jsx", ".mjs"]);
const WEB_ASSET = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);
const C_IMPLEMENTATION = new Set([".c", ".cc", ".cpp"]);
const C_HEADER = new Set([".h", ".hpp"]);

export interface LanguageRelationshipRule {
  id: string;
  matches(targetExtension: string, relatedExtension: string): boolean;
  role: string;
}

/** Ordered: specific cross-language relationships precede same-language fallbacks. */
export const LANGUAGE_RELATIONSHIP_RULES: readonly LanguageRelationshipRule[] = Object.freeze([
  { id: "html-stylesheet", matches: (target, related) => [".html", ".htm"].includes(target) && related === ".css", role: "stylesheet companion; reference it with a <link rel=\"stylesheet\"> href" },
  { id: "html-browser-script", matches: (target, related) => [".html", ".htm"].includes(target) && BROWSER_SCRIPT.has(related), role: "browser-script companion; reference it with a <script src>" },
  { id: "html-web-asset", matches: (target, related) => [".html", ".htm"].includes(target) && WEB_ASSET.has(related), role: "web asset candidate; reference its real relative URL when the markup uses it" },
  { id: "css-markup", matches: (target, related) => target === ".css" && [".html", ".htm"].includes(related), role: "markup contract; style its real classes and ids" },
  { id: "css-asset", matches: (target, related) => target === ".css" && WEB_ASSET.has(related), role: "style asset candidate; use its real relative URL with url() when needed" },
  { id: "script-markup", matches: (target, related) => SCRIPT.has(target) && [".html", ".htm"].includes(related), role: "markup/browser contract; use its real classes and ids and implement its referenced inline handler calls" },
  { id: "script-styles", matches: (target, related) => SCRIPT.has(target) && related === ".css", role: "style contract; toggle or query its real class/custom-property names; do not import it unless the project pattern does" },
  { id: "script-module", matches: (target, related) => SCRIPT.has(target) && SCRIPT.has(related), role: "module candidate; import only the symbols this target actually uses" },
  { id: "c-header", matches: (target, related) => C_IMPLEMENTATION.has(target) && C_HEADER.has(related), role: "header candidate; include it when this implementation uses its declarations" },
  { id: "c-implementation", matches: (target, related) => C_HEADER.has(target) && C_IMPLEMENTATION.has(related), role: "implementation companion for this header contract" },
  { id: "java-type", matches: (target, related) => target === ".java" && related === ".java", role: "same-project Java type; use its declared package/type contract when needed" },
  { id: "python-module", matches: (target, related) => target === ".py" && related === ".py", role: "Python module candidate; import its public contract with the project's package convention" },
  { id: "rust-module", matches: (target, related) => target === ".rs" && related === ".rs", role: "Rust module candidate; use the crate's mod/use layout rather than a filesystem-style import" },
  { id: "go-package", matches: (target, related) => target === ".go" && related === ".go", role: "Go package companion; same-package files share declarations and must not import each other" },
  { id: "ruby-source", matches: (target, related) => target === ".rb" && related === ".rb", role: "Ruby source companion; use require_relative or the project's loader convention when needed" },
  { id: "csharp-type", matches: (target, related) => target === ".cs" && related === ".cs", role: "same-project C# type; use its namespace/type contract rather than importing a filename" },
]);

export function languageRelationshipRole(targetPath: string, relatedPath: string): string | undefined {
  const target = extname(targetPath).toLowerCase();
  const related = extname(relatedPath).toLowerCase();
  const matched = LANGUAGE_RELATIONSHIP_RULES.find((rule) => rule.matches(target, related));
  if (matched) return matched.role;
  if (target === related && target.length > 0) return "same-language project file; reuse its public contract when needed";
  return undefined;
}

export function usesModuleStyleReference(targetPath: string): boolean {
  return SCRIPT.has(extname(targetPath).toLowerCase());
}

export function relationshipReferenceDescription(
  targetPath: string,
  relatedPath: string,
  reference: string,
): string {
  const target = extname(targetPath).toLowerCase();
  const related = extname(relatedPath).toLowerCase();
  if (SCRIPT.has(target) && SCRIPT.has(related)) {
    return `relative project path: ${reference}; preserve the project's module-specifier extension convention`;
  }
  if (new Set([".py", ".rs", ".go", ".java", ".rb", ".cs"]).has(target) && target === related) {
    return `relative project path: ${reference}; translate it through the project's package/module convention`;
  }
  return `exact relative reference: ${reference}`;
}
