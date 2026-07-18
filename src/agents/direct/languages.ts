import type { LanguageProfile } from "./types.ts";

/** Operator-declared config language -> output extension and prompt label. */
export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  typescript: { ext: "ts", label: "TypeScript" },
  javascript: { ext: "js", label: "JavaScript" },
  python: { ext: "py", label: "Python" },
  rust: { ext: "rs", label: "Rust" },
  go: { ext: "go", label: "Go" },
  java: { ext: "java", label: "Java" },
  ruby: { ext: "rb", label: "Ruby" },
  csharp: { ext: "cs", label: "C#" },
  cpp: { ext: "cpp", label: "C++" },
  c: { ext: "c", label: "C" },
  html: { ext: "html", label: "HTML" },
  css: { ext: "css", label: "CSS" },
};

export function languageProfile(language: string): LanguageProfile {
  return LANGUAGE_PROFILES[language.trim().toLowerCase()] ?? { ext: "txt", label: language };
}

/** File extension (with or without a leading dot) -> owning config language. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", rb: "ruby", cs: "csharp",
  cpp: "cpp", cc: "cpp", hpp: "cpp", c: "c", h: "c",
  html: "html", htm: "html", css: "css",
};

export function languageForExtension(extension: string): string | undefined {
  return EXTENSION_LANGUAGES[extension.replace(/^\./u, "").toLowerCase()];
}
