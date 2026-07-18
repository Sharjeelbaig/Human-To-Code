/**
 * Shared types for human-to-code.
 *
 * The pipeline is: static analysis -> reviewed JSON contract -> grounded model
 * patch -> isolated validation -> explicit application.
 */

export type TargetLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "html"
  | "css";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "ollama"
  | "grok"
  | "gemini";

export interface ProviderConfig {
  /** Provider selected explicitly for structured patch generation. */
  name: ProviderName;
  /** Exact requested model id. The resolved response identity is audited. */
  model: string;
  /** Optional trusted endpoint (for example Ollama Cloud); local Ollama may use loopback HTTP. */
  baseUrl?: string;
}

/** Explicit output extension for one project-relative `.human` source. */
export interface HumanFileExtensionConfig {
  path: string;
  /** Normalized output extension without a leading dot. */
  extension: string;
}

export interface Config {
  /** Legacy single-language hint; static workspace analysis is authoritative. */
  language: TargetLanguage;
  /**
   * Output languages enabled for direct conversion. The primary (`language`)
   * is the default; other entries are reachable through a `.human` file's
   * inner extension, e.g. `index.html.human` -> `index.html`.
   */
  languages: TargetLanguage[];
  /** Exact per-file routing rules that take precedence over language inference. */
  humanFileExtensions: HumanFileExtensionConfig[];
  /** Glob-free directory/file names to skip during discovery (a denylist). */
  filesToIgnore: string[];
  /**
   * If true, non-.human files carrying `@Human:` directives may also be
   * processed. Off by default — it widens the surface area (see plan §1.6).
   */
  allowNonHumanFiles: boolean;
  /** Provider used only for the human -> strict step. */
  provider: ProviderConfig;
}

/** Classification of a source file found during discovery. */
export type SourceKind =
  /** A hand-written or generated strict IR file: `foo.strict.human`. */
  | "strict"
  /** A natural-language source file: `foo.human` (not `.strict.human`). */
  | "human"
  /** Reserved special files, never compiled and never sent to a provider. */
  | "config"
  | "secrets";

export interface SourceFile {
  /** Absolute path. */
  absPath: string;
  /** Path relative to the discovery root, using forward slashes. */
  relPath: string;
  kind: SourceKind;
  /**
   * For a `.human` file, the sibling `.strict.human` path that would take
   * precedence if it exists. Undefined for non-human kinds.
   */
  strictSibling?: string;
}

export interface DiscoveryResult {
  root: string;
  /** Natural-language sources eligible for the human -> strict step. */
  human: SourceFile[];
  /** Strict IR sources (hand-written ones take precedence over generated). */
  strict: SourceFile[];
  /** The secrets file, if present. Never compiled, never sent to a provider. */
  secrets?: SourceFile;
  /** Every nested secrets.human, including ignored trees. */
  secretsFiles?: SourceFile[];
  /** Files skipped by ignore rules, for reporting under --dry-run. */
  ignoredCount: number;
}
