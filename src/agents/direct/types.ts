import type { StaticFileMemoryEntry } from "../../pipeline/file-memory.ts";

export interface LanguageProfile {
  /** Output file extension without a dot. */
  ext: string;
  /** Human label used in prompts. */
  label: string;
}

export interface ConversionUnit {
  kind: "file" | "inline";
  /** Project-relative source path. */
  sourcePath: string;
  /** Absolute source path. */
  absoluteSource: string;
  /** The extracted human-language instruction. */
  prompt: string;
  /** Resolved output language for this unit (config language name). */
  language?: string;
  /** For `file` units, the project-relative output path to write. */
  outputPath?: string;
  /** For `inline` units, the character range of the marker to replace. */
  range?: { start: number; end: number };
  /** Exact marker bytes captured during discovery; required for stale-edit detection. */
  expectedMarker?: string;
  /** 1-based source line of the marker, for progress display. */
  line?: number;
  /** Short human-readable description for the receipt. */
  describe: string;
}

export type FileMemoryEntry = StaticFileMemoryEntry;

export interface UnitGenerationContext {
  inline: boolean;
  /** Static declarations and earlier replacements in this unit's file. */
  fileMemory?: string;
}

export interface GeneratedConversionUnit {
  unit: ConversionUnit;
  code: string;
  /** Set when this unit could not be generated; the others are unaffected. */
  error?: string;
}

/** Live progress for one unit during a deterministic conversion run. */
export type ConversionProgress =
  | { kind: "start"; unit: ConversionUnit; attempt: number }
  | { kind: "done"; unit: ConversionUnit }
  | { kind: "skip"; unit: ConversionUnit; reason: string };

export interface GenerateUnitsOptions {
  /** Extra generation attempts when a unit trips the FileMemory guard or the provider errors. */
  retries?: number;
  onProgress?: (event: ConversionProgress) => void;
  /** Fail-closed candidate check run before a unit is remembered or applied. */
  validate?: (unit: ConversionUnit, code: string) => Promise<void>;
}

export interface DirectDiscoveryNotice {
  code: "TARGET_EXISTS" | "UNSUPPORTED_MARKER_FILE";
  sourcePath: string;
  message: string;
}

export interface DirectDiscoveryResult {
  units: ConversionUnit[];
  notices: DirectDiscoveryNotice[];
}

export interface GenerateOptions {
  language: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Whether this request replaces one inline @human marker. */
  inline?: boolean;
  /** Deterministic earlier replacements from the same file. */
  fileMemory?: string;
  signal?: AbortSignal;
}

export interface AppliedUnit {
  unit: ConversionUnit;
  writtenPath: string;
}
