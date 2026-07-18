import { languageForCodeExtension } from "../../core/languages.ts";
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
export function languageForExtension(extension: string): string | undefined {
  return languageForCodeExtension(extension);
}

export interface LanguageDeclaration {
  language: string;
  extension: string;
}

/**
 * Resolve the first line of a `.human` file as either a code extension (`js`)
 * or a configured language name (`javascript`). Language names always select
 * their profile's canonical output extension, so a `javascript` declaration
 * creates `.js`, never `.javascript`.
 */
export function resolveLanguageDeclaration(value: string): LanguageDeclaration | undefined {
  const normalized = value.trim().replace(/^\./u, "").toLowerCase();
  const extensionLanguage = languageForExtension(normalized);
  if (extensionLanguage !== undefined) {
    return { language: extensionLanguage, extension: normalized };
  }

  if (!Object.hasOwn(LANGUAGE_PROFILES, normalized)) return undefined;
  return {
    language: normalized,
    extension: LANGUAGE_PROFILES[normalized]!.ext,
  };
}
