/**
 * Shared types for human-to-code.
 *
 * The pipeline is:  .human --(LLM)--> .strict.human --(deterministic)--> code
 * These types describe the deterministic core (config + discovery) only; the
 * strict DSL and code generators are added in later build steps.
 */

export type TargetLanguage = "typescript" | "javascript" | "python";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "ollama"
  | "grok"
  | "gemini";

export interface ProviderConfig {
  /** Which LLM provider drives the human -> strict step. */
  name: ProviderName;
  /** Model id. Configurable; defaults are current, not dated snapshots. */
  model: string;
  /** Optional override endpoint (e.g. Ollama Cloud). Must be https. */
  baseUrl?: string;
}

export interface Config {
  /** Target language for the deterministic code generator. */
  language: TargetLanguage;
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
  /** Files skipped by ignore rules, for reporting under --dry-run. */
  ignoredCount: number;
}
