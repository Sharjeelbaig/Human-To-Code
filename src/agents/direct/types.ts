/**
 * The shared direct-mode vocabulary: the types that instruction discovery,
 * model generation, validation, presentation, and application all speak.
 */
import type { StaticFileMemoryEntry } from "../../pipeline/file-memory.ts";
import type { UnitTodoList } from "./unit-todos.ts";

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
  /** Target-specific current/projected repository evidence. */
  projectMemory?: string;
  /** Shared contract agreed for this run, when planning is enabled. */
  blueprint?: string;
  /** Rendered todo list for this target, when a todo pass ran. */
  todos?: string;
  /** Previous complete candidate; present only on a refinement pass. */
  currentDraft?: string;
  /** Todo items the deterministic coverage check did not find in the draft. */
  unaddressedTodos?: readonly string[];
}

export interface ProjectRelationship {
  path: string;
  state: "current" | "planned" | "generated";
  role: string;
  reference: string;
}

/** Minimal seam used by generation and staged repair without coupling to storage. */
export interface ProjectMemoryProvider {
  renderFor(unit: ConversionUnit, charBudget?: number): string;
  remember(unit: ConversionUnit, code: string): void;
  /** Structured target relationships used by optional generic integration auditing. */
  relationsFor?(unit: ConversionUnit): readonly ProjectRelationship[];
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
  | { kind: "plan"; unit: ConversionUnit }
  | { kind: "refine"; unit: ConversionUnit; pass: number; unaddressed: number }
  | { kind: "done"; unit: ConversionUnit }
  | { kind: "skip"; unit: ConversionUnit; reason: string };

/** What one unit's planning passes produced, for honest run disclosure. */
export interface UnitPlanningOutcome {
  unit: ConversionUnit;
  todoRequests: number;
  codingRequests: number;
  /** Set when a refinement was generated and then rejected by the ratchet. */
  refinementRejected?: string;
  addressed: number;
  unaddressed: number;
  unverifiable: number;
}

export interface GenerateUnitsOptions {
  /** Extra generation attempts when a unit trips the FileMemory guard or the provider errors. */
  retries?: number;
  onProgress?: (event: ConversionProgress) => void;
  /** Fail-closed candidate check run before a unit is remembered or applied. */
  validate?: (unit: ConversionUnit, code: string) => Promise<void>;
  /** Shared current/projected repository memory updated after accepted units. */
  projectMemory?: ProjectMemoryProvider;
  /** Total FileMemory + ProjectMemory character allowance for one request. */
  contextCharBudget?: number;
  /**
   * Per-unit todo planning. Returning undefined, or throwing, leaves the unit on
   * the single-pass path: planning enriches context and must never fail a unit.
   */
  plan?: (unit: ConversionUnit, context: UnitGenerationContext) => Promise<UnitTodoList | undefined>;
  /** Coding requests allowed per unit. 1 disables refinement entirely. */
  maxCodingPasses?: number;
  /** Collected per-unit planning outcomes, for run disclosure. */
  onPlanningOutcome?: (outcome: UnitPlanningOutcome) => void;
}

export interface DirectDiscoveryNotice {
  code:
    | "TARGET_EXISTS"
    | "UNSUPPORTED_MARKER_FILE"
    | "EXTENSION_CONFLICT"
    | "UNCONFIGURED_EXTENSION";
  sourcePath: string;
  message: string;
}

export interface DirectDiscoveryResult {
  units: ConversionUnit[];
  notices: DirectDiscoveryNotice[];
  /** Project-relative paths from the same deterministic discovery walk. */
  scannedPaths: string[];
}

export interface GenerateOptions {
  language: string;
  provider: string;
  model: string;
  /** Exact project-relative file receiving this output. */
  targetPath?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Whether this request replaces one inline @human marker. */
  inline?: boolean;
  /** Deterministic earlier replacements from the same file. */
  fileMemory?: string;
  /** Compact current/projected repository evidence for this exact target. */
  projectMemory?: string;
  /** Shared contract agreed for this run. */
  blueprint?: string;
  /** Rendered todo list for this target. */
  todos?: string;
  /** Previous complete candidate on a refinement pass. */
  currentDraft?: string;
  /** Todo items not found in the draft. */
  unaddressedTodos?: readonly string[];
  signal?: AbortSignal;
}

export interface AppliedUnit {
  unit: ConversionUnit;
  writtenPath: string;
}
