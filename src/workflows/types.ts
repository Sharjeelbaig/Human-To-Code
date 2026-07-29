/**
 * The shared direct-mode vocabulary: the types that instruction discovery,
 * model generation, validation, presentation, and application all speak.
 */
import type { StaticFileMemoryEntry } from "../memory/file-memory-extraction.ts";
import type {
  ProviderAdapter,
  ProviderBudgetTracker,
  ProviderToolCallV1,
  ProviderToolDefinitionV1,
} from "../llms/provider.ts";
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
  /** True when a single inline marker is the file's only meaningful content. */
  ownsWholeFile?: boolean;
  /** Complete target contents with only a selected-edit marker removed. */
  existingSource?: string;
  /** Existing host-selected construct this unit is authorized to replace. */
  selectedSource?: string;
  /** Exact independently stale-checked bytes selected for replacement. */
  selectedRange?: { start: number; end: number };
  expectedSelectedSource?: string;
  /** 1-based source line of the marker, for progress display. */
  line?: number;
  /** Grammar position receiving an inline replacement. */
  insertionContext?:
    | "statement"
    | "parameter-list"
    | "function-body"
    | "jsx-child"
    | "css-declarations"
    | "css-rule-list"
    | "html-content";
  /** Existing CSS rule header when the marker sits inside a declaration body. */
  insertionOwner?: string;
  /** Bounded source around the marker, with the marker replaced by a placeholder. */
  surroundingSource?: string;
  /** Short human-readable description for the receipt. */
  describe: string;
}

/** Whether generated code represents the complete target file. */
export function unitOwnsCompleteFile(unit: ConversionUnit): boolean {
  return unit.kind === "file" || unit.ownsWholeFile === true;
}

export type FileMemoryEntry = StaticFileMemoryEntry;

export interface UnitGenerationContext {
  inline: boolean;
  /** Earlier `@human` messages in this run, ordered and bounded. */
  sessionMemory?: string;
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
  /** Candidate rejected by the deterministic gate on a previous attempt. */
  rejectedDraft?: string;
  /** Exact deterministic reason the previous candidate was rejected. */
  validationFailure?: string;
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
  /** The message was retained in session memory but requested no source edit. */
  contextOnly?: boolean;
  /** Set when this unit could not be generated; the others are unaffected. */
  error?: string;
}

/** Live progress for one unit during a deterministic conversion run. */
export type ConversionProgress =
  | { kind: "start"; unit: ConversionUnit; attempt: number }
  | { kind: "classify"; unit: ConversionUnit }
  | { kind: "plan"; unit: ConversionUnit }
  | { kind: "refine"; unit: ConversionUnit; pass: number; unaddressed: number }
  | { kind: "done"; unit: ConversionUnit }
  | { kind: "context"; unit: ConversionUnit }
  | { kind: "skip"; unit: ConversionUnit; reason: string };

/** What one unit's planning passes produced, for honest run disclosure. */
export interface UnitPlanningOutcome {
  unit: ConversionUnit;
  classificationRequests: number;
  todoRequests: number;
  codingRequests: number;
  /** Set when a refinement was generated and then rejected by the ratchet. */
  refinementRejected?: string;
  /** Set when the per-target todo request was made but its answer was unusable. */
  planningFailure?: string;
  addressed: number;
  unaddressed: number;
  unverifiable: number;
}

export interface GenerateUnitsOptions {
  /** Extra generation attempts when a unit trips the FileMemory guard or the provider errors. */
  retries?: number;
  onProgress?: (event: ConversionProgress) => void;
  /**
   * Embedding-only compatibility hook. The bundled CLI never supplies it:
   * built-in language rules validate model output and cannot bypass reasoning.
   */
  lower?: (
    unit: ConversionUnit,
    context: UnitGenerationContext,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Embedding-only compatibility hook after provider/validation failure. The
   * bundled CLI retries the model and never recovers with built-in generated
   * fragments.
   */
  recover?: (
    unit: ConversionUnit,
    failure: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Fail-closed candidate check run before a unit is remembered or applied. */
  validate?: (unit: ConversionUnit, code: string) => Promise<void>;
  /** Model-backed semantic boundary between context-only and source-edit turns. */
  classify?: (unit: ConversionUnit, context: UnitGenerationContext) => Promise<"context" | "edit">;
  /** Fast deterministic gate limiting classification to inline @human markers. */
  shouldClassify?: (unit: ConversionUnit) => boolean;
  /** Shared current/projected repository memory updated after accepted units. */
  projectMemory?: ProjectMemoryProvider;
  /** Total FileMemory + ProjectMemory character allowance for one request. */
  contextCharBudget?: number;
  /** Omit conversational history so each accepted instruction is an isolated compilation unit. */
  sessionMemory?: boolean;
  /**
   * Per-unit todo planning. Returning undefined, or throwing, leaves the unit on
   * the single-pass path: planning enriches context and must never fail a unit.
   */
  plan?: (unit: ConversionUnit, context: UnitGenerationContext) => Promise<UnitTodoList | undefined>;
  /** Fast deterministic check that avoids calling the planner for disabled unit kinds. */
  shouldPlan?: (unit: ConversionUnit) => boolean;
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

export interface CodeAgentRuntime {
  adapter: ProviderAdapter;
  budget: ProviderBudgetTracker;
  tools: readonly ProviderToolDefinitionV1[];
  remainingToolCalls: () => number;
  validateToolCall: (call: ProviderToolCallV1) => void;
  executeTool: (call: ProviderToolCallV1) => Promise<unknown>;
  maxOutputTokens: number;
  contextSystemPrompt: string;
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
  /** Use the isolated compiler prompt while retaining selected model skills. */
  compilerMode?: boolean;
  /** Earlier `@human` messages in this run, ordered and bounded. */
  sessionMemory?: string;
  /** Grammar position receiving an inline replacement. */
  insertionContext?: ConversionUnit["insertionContext"];
  insertionOwner?: string;
  /** Bounded source around the marker. */
  surroundingSource?: string;
  /** Existing complete target source for a selected-code edit. */
  existingSource?: string;
  /** Existing host-selected construct an edit tool may replace. */
  selectedSource?: string;
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
  /** Candidate rejected by the deterministic gate on a previous attempt. */
  rejectedDraft?: string;
  /** Exact deterministic reason the previous candidate was rejected. */
  validationFailure?: string;
  /**
   * Ceiling for one provider request, from `budgets.timeoutMs`. Omitting it
   * falls back to the package default; a request is never unbounded.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Adapter-backed autonomous context loop used by the production CLI. */
  agentRuntime?: CodeAgentRuntime;
}

export interface AppliedUnit {
  unit: ConversionUnit;
  writtenPath: string;
}
