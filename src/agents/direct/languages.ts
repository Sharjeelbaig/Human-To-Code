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
};

export function languageProfile(language: string): LanguageProfile {
  return LANGUAGE_PROFILES[language.trim().toLowerCase()] ?? { ext: "txt", label: language };
}
