/** Shared source/output extension routing used by config and direct discovery. */
export const CODE_EXTENSION_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  c: "c",
  h: "c",
  html: "html",
  htm: "html",
  css: "css",
});

/** Resolve an extension with or without a leading dot. */
export function languageForCodeExtension(extension: string): string | undefined {
  return CODE_EXTENSION_LANGUAGES[extension.replace(/^\./u, "").toLowerCase()];
}
