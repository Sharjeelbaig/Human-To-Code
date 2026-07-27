/**
 * Bounded provider/tool orchestration.
 *
 * The provider may choose whether it needs more evidence, but the host owns
 * tool authorization, path confinement, context budgets, and final validation.
 */
import {
  ArtifactValidationError,
  canonicalJson,
  hashCanonical,
  type JsonValue,
  type ValidationIssue,
} from "../core/contracts.ts";
import {
  ProviderError,
  generateValidated,
  type ProviderAdapter,
  type ProviderBudgetTracker,
  type ProviderGenerationRequestV1,
  type ProviderGenerationResultV1,
  type ProviderMessageV1,
  type ProviderToolCallV1,
  type ProviderToolDefinitionV1,
} from "../llms/provider.ts";
import {
  selectContext,
  validateContextManifestV1,
  type ContextBudgetV1,
  type ContextCandidateV1,
  type ContextExclusionV1,
  type ContextManifestV1,
} from "../memory/context.ts";
import {
  CompilerToolError,
  CompilerToolExecutor,
} from "../memory/compiler-tools.ts";
import type { ProjectProfileV1 } from "../tools/analysis/analyzer-types.ts";

const HARD_MAX_TOOL_CALLS = 8;

interface ToolTurn {
  kind: "tools";
  calls: ProviderToolCallV1[];
}

interface FinalTurn<T> {
  kind: "final";
  value: T;
}

type AgentTurn<T> = ToolTurn | FinalTurn<T>;

export interface ProviderToolLoopOptions<T> {
  adapter: ProviderAdapter;
  budget?: ProviderBudgetTracker;
  request: ProviderGenerationRequestV1;
  validateFinal: (value: unknown) => T;
  tools?: readonly ProviderToolDefinitionV1[];
  /** Exact host validator, run for the whole batch before the first execution. */
  validateToolCall?: (call: ProviderToolCallV1) => void;
  executeTool?: (call: ProviderToolCallV1) => Promise<unknown>;
  /** A run may authorize fewer calls; the absolute implementation cap is 8. */
  maxToolCalls?: number;
}

export interface ProviderToolLoopResult<T> {
  value: T;
  turns: readonly ProviderGenerationResultV1[];
  toolCalls: number;
}

function validationError(
  path: string,
  message: string,
  code: ValidationIssue["code"] = "VALUE",
): ArtifactValidationError {
  return new ArtifactValidationError([{ path, code, message }]);
}

function jsonArguments(
  value: unknown,
  path: string,
): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(path, "must be an object.", "TYPE");
  }
  try {
    canonicalJson(value);
  } catch {
    throw validationError(path, "must contain canonical JSON values only.", "TYPE");
  }
  return structuredClone(value) as Readonly<Record<string, JsonValue>>;
}

function parseToolTurn(value: unknown): ToolTurn | undefined {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || !Object.hasOwn(value, "toolCalls")
  ) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) {
    throw validationError("$agentTurn", "tool-call envelopes may contain only toolCalls.", "UNKNOWN_KEY");
  }
  if (!Array.isArray(record.toolCalls) || record.toolCalls.length === 0) {
    throw validationError("$agentTurn.toolCalls", "must be a non-empty array.", "TYPE");
  }
  const calls = record.toolCalls.map((raw, index): ProviderToolCallV1 => {
    const path = `$agentTurn.toolCalls[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw validationError(path, "must be an object.", "TYPE");
    }
    const call = raw as Record<string, unknown>;
    const allowed = new Set(["id", "name", "arguments"]);
    for (const key of Object.keys(call)) {
      if (!allowed.has(key)) {
        throw validationError(`${path}.${key}`, "is not allowed.", "UNKNOWN_KEY");
      }
    }
    if (!Object.hasOwn(call, "name") || !Object.hasOwn(call, "arguments")) {
      throw validationError(path, "must contain name and arguments.", "MISSING");
    }
    if (call.id !== undefined && typeof call.id !== "string") {
      throw validationError(`${path}.id`, "must be a string.", "TYPE");
    }
    if (
      typeof call.name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(call.name)
    ) {
      throw validationError(`${path}.name`, "must be a declared bounded tool name.");
    }
    return {
      id: call.id ?? "",
      name: call.name,
      arguments: jsonArguments(call.arguments, `${path}.arguments`),
    };
  });
  return { kind: "tools", calls };
}

/**
 * Run provider turns until a locally validated final value is produced.
 * Intermediate tool envelopes pass through the same provider boundary,
 * cumulative budget accounting, secret scan, and clone checks as final output.
 */
export async function runProviderToolLoop<T>(
  options: ProviderToolLoopOptions<T>,
): Promise<ProviderToolLoopResult<T>> {
  const maximum = options.maxToolCalls ?? (options.executeTool ? HARD_MAX_TOOL_CALLS : 0);
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 0
    || maximum > HARD_MAX_TOOL_CALLS
  ) {
    throw new RangeError(`maxToolCalls must be an integer from 0 to ${HARD_MAX_TOOL_CALLS}.`);
  }
  const declaredTools = [...(options.tools ?? [])];
  if (declaredTools.length > 0 && options.adapter.capabilities.remote) {
    throw new ProviderError(
      "configuration",
      "Dynamic project-context tools are restricted to local providers.",
    );
  }
  if (declaredTools.length > 0 && !options.adapter.capabilities.toolCalling) {
    throw new ProviderError("configuration", "The configured provider cannot call tools.");
  }
  if (declaredTools.length > 0 && options.executeTool === undefined) {
    throw new ProviderError("configuration", "Declared provider tools require a host executor.");
  }

  const toolByName = new Map(declaredTools.map((tool) => [tool.name, tool]));
  const seenCallIds = new Set<string>();
  const messages: ProviderMessageV1[] = structuredClone(options.request.messages);
  const turns: ProviderGenerationResultV1[] = [];
  let usedToolCalls = 0;
  let turnNumber = 0;

  for (;;) {
    turnNumber += 1;
    const available = Math.max(0, maximum - usedToolCalls);
    const requestTools =
      available > 0 && declaredTools.length > 0 ? declaredTools : undefined;
    const generated = await generateValidated(
      options.adapter,
      {
        ...options.request,
        messages,
        ...(requestTools === undefined ? { tools: undefined } : { tools: requestTools }),
      },
      (value): AgentTurn<T> => {
        const toolTurn = parseToolTurn(value);
        return toolTurn ?? { kind: "final", value: options.validateFinal(value) };
      },
      { ...(options.budget === undefined ? {} : { budget: options.budget }) },
    );
    turns.push(generated.result);

    if (generated.value.kind === "final") {
      if (generated.result.finishReason !== "stop") {
        throw new ProviderError(
          "schema",
          "A final agent result must finish with stop.",
          { requestId: generated.result.requestId },
        );
      }
      return {
        value: generated.value.value,
        turns,
        toolCalls: usedToolCalls,
      };
    }

    if (generated.result.finishReason !== "tool_call") {
      throw new ProviderError(
        "schema",
        "A tool-call envelope must use the tool_call finish reason.",
        { requestId: generated.result.requestId },
      );
    }
    if (
      requestTools === undefined
      || options.executeTool === undefined
      || generated.value.calls.length > available
    ) {
      throw new ProviderError(
        "schema",
        "The provider requested an unavailable or exhausted host tool.",
        { requestId: generated.result.requestId },
      );
    }

    // Validate the complete batch before executing any call.
    const calls = generated.value.calls.map((call, index): ProviderToolCallV1 => {
      if (!toolByName.has(call.name)) {
        throw new ProviderError(
          "schema",
          `The provider requested undeclared tool ${JSON.stringify(call.name)}.`,
          { requestId: generated.result.requestId },
        );
      }
      const id = call.id.trim() || `host-tool-${turnNumber}-${index + 1}`;
      if (seenCallIds.has(id)) {
        throw new ProviderError(
          "schema",
          "The provider reused a tool-call identifier.",
          { requestId: generated.result.requestId },
        );
      }
      return { ...call, id };
    });
    for (const call of calls) options.validateToolCall?.(call);
    for (const call of calls) seenCallIds.add(call.id);

    const outputs: unknown[] = [];
    for (const call of calls) outputs.push(await options.executeTool(call));
    usedToolCalls += calls.length;
    messages.push({ role: "assistant", content: "", toolCalls: calls });
    calls.forEach((call, index) => {
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: canonicalJson(outputs[index]),
      });
    });
  }
}

export interface AgentContextCoordinatorOptions {
  root: string;
  profile: ProjectProfileV1;
  executor: CompilerToolExecutor;
  offline?: boolean;
  secretPolicy?: "block" | "redact";
  budget: ContextBudgetV1;
  officialDocumentationHosts?: readonly string[];
}

export interface ContextToolResultV1 {
  schemaVersion: 1;
  requestId: string;
  ok: boolean;
  evidence: ContextManifestV1["evidence"];
  exclusions: ContextManifestV1["exclusions"];
  remaining: {
    requests: number;
    items: number;
    bytes: number;
    estimatedTokens: number;
  };
  error?: { code: string; message: string };
}

function candidateKey(candidate: ContextCandidateV1): string {
  const location =
    candidate.origin === "official_documentation" ? candidate.url : candidate.path;
  return canonicalJson({
    origin: candidate.origin,
    location,
    version: candidate.version ?? null,
    startLine: candidate.range?.startLine ?? 1,
    endLine: candidate.range?.endLine ?? null,
  });
}

function evidenceBytes(manifest: ContextManifestV1): number {
  return manifest.evidence.reduce(
    (total, item) => total + Buffer.byteLength(item.content, "utf8"),
    0,
  );
}

function evidenceTokens(manifest: ContextManifestV1): number {
  return manifest.evidence.reduce(
    (total, item) =>
      total + Math.ceil(Buffer.byteLength(item.content, "utf8") / 4),
    0,
  );
}

/** Append-only context materializer shared by every target and retry in a run. */
export class AgentContextCoordinator {
  readonly #options: AgentContextCoordinatorOptions;
  readonly #seenCandidates = new Set<string>();
  readonly #evidence: ContextManifestV1["evidence"] = [];
  readonly #exclusions: ContextManifestV1["exclusions"] = [];
  #usedBytes = 0;
  #usedTokens = 0;
  #redactionCount = 0;

  constructor(options: AgentContextCoordinatorOptions) {
    for (const [key, value] of Object.entries(options.budget)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`Agent context budget ${key} must be a positive integer.`);
      }
    }
    if (options.budget.maxBytesPerItem > options.budget.maxBytes) {
      throw new RangeError("Agent maxBytesPerItem cannot exceed maxBytes.");
    }
    this.#options = {
      ...options,
      budget: { ...options.budget },
      officialDocumentationHosts: options.officialDocumentationHosts === undefined
        ? undefined
        : [...options.officialDocumentationHosts],
    };
  }

  #remaining(): ContextToolResultV1["remaining"] {
    const budget = this.#options.budget;
    return {
      requests: this.#options.executor.session.remaining,
      items: Math.max(0, budget.maxItems - this.#evidence.length),
      bytes: Math.max(0, budget.maxBytes - this.#usedBytes),
      estimatedTokens: Math.max(0, budget.maxEstimatedTokens - this.#usedTokens),
    };
  }

  async execute(call: ProviderToolCallV1): Promise<ContextToolResultV1> {
    if (call.name !== "request_context") {
      throw new ProviderError("schema", "Only request_context is authorized.");
    }
    let candidates: ContextCandidateV1[];
    try {
      candidates = await this.#options.executor.execute(call.arguments);
    } catch (error) {
      if (
        error instanceof CompilerToolError
        && ["UNAVAILABLE", "UNKNOWN_DEPENDENCY"].includes(error.code)
      ) {
        const requestId =
          typeof call.arguments.requestId === "string"
            ? call.arguments.requestId
            : call.id;
        return {
          schemaVersion: 1,
          requestId,
          ok: false,
          evidence: [],
          exclusions: [],
          remaining: this.#remaining(),
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }

    const duplicates: ContextExclusionV1[] = [];
    const unseen = candidates.filter((candidate) => {
      const key = candidateKey(candidate);
      if (this.#seenCandidates.has(key)) {
        duplicates.push({
          location:
            candidate.origin === "official_documentation"
              ? candidate.url
              : candidate.path,
          code: "DUPLICATE",
          reason: "Evidence already supplied earlier in this agent run.",
        });
        return false;
      }
      this.#seenCandidates.add(key);
      return true;
    });
    const remaining = this.#remaining();
    let selected: ContextManifestV1 | undefined;
    if (
      unseen.length > 0
      && remaining.items > 0
      && remaining.bytes > 0
      && remaining.estimatedTokens > 0
    ) {
      selected = await selectContext({
        root: this.#options.root,
        projectFingerprint: this.#options.profile.fingerprint,
        candidates: unseen,
        offline: this.#options.offline ?? false,
        secretPolicy: this.#options.secretPolicy ?? "block",
        budget: {
          maxItems: remaining.items,
          maxBytes: remaining.bytes,
          maxEstimatedTokens: remaining.estimatedTokens,
          maxBytesPerItem: Math.min(
            this.#options.budget.maxBytesPerItem,
            remaining.bytes,
          ),
        },
        ...(this.#options.officialDocumentationHosts === undefined
          ? {}
          : {
              officialDocumentationHosts: [
                ...this.#options.officialDocumentationHosts,
              ],
            }),
      });
    }
    const newEvidence = selected?.evidence ?? [];
    const newExclusions = [
      ...duplicates,
      ...(selected?.exclusions ?? []),
      ...(selected === undefined && unseen.length > 0
        ? unseen.map((candidate): ContextExclusionV1 => ({
            location:
              candidate.origin === "official_documentation"
                ? candidate.url
                : candidate.path,
            code: "BUDGET",
            reason: "The cumulative agent context budget is exhausted.",
          }))
        : []),
    ];
    this.#evidence.push(...newEvidence);
    this.#exclusions.push(...newExclusions);
    if (selected !== undefined) {
      this.#usedBytes += evidenceBytes(selected);
      this.#usedTokens += evidenceTokens(selected);
      this.#redactionCount += selected.redactionCount;
    }
    const requestId =
      typeof call.arguments.requestId === "string"
        ? call.arguments.requestId
        : call.id;
    return {
      schemaVersion: 1,
      requestId,
      ok: true,
      evidence: structuredClone(newEvidence),
      exclusions: structuredClone(newExclusions),
      remaining: this.#remaining(),
    };
  }

  get manifest(): ContextManifestV1 {
    return validateContextManifestV1({
      schemaVersion: 1,
      projectFingerprint: this.#options.profile.fingerprint,
      offline: this.#options.offline ?? false,
      evidence: structuredClone(this.#evidence),
      exclusions: structuredClone(this.#exclusions),
      budget: {
        ...this.#options.budget,
        usedItems: this.#evidence.length,
        usedBytes: this.#usedBytes,
        usedEstimatedTokens: this.#usedTokens,
      },
      redactionCount: this.#redactionCount,
    });
  }

  get manifestHash(): string {
    return hashCanonical(this.manifest);
  }

  get contextRequests(): number {
    return this.#options.executor.session.count;
  }
}
