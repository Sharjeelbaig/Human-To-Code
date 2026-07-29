/**
 * Sends typed direct-conversion prompts through whichever provider is
 * configured, keeping provider mechanics out of discovery and application.
 */
import {
  buildDirectBlueprintPrompt,
  type DirectBlueprintPromptInput,
} from "../prompts/direct-blueprint.ts";
import { buildDirectConversionPrompt, type PromptMessages } from "../prompts/direct-conversion.ts";
import {
  buildDirectTurnClassificationPrompt,
  parseDirectTurnClassification,
  type DirectTurnClassificationPromptInput,
  type DirectTurnPlan,
} from "../prompts/direct-turn-classification.ts";
import {
  buildDirectPlanClassificationPrompt,
  parseDirectPlanClassification,
  type DirectPlanClassificationItem,
} from "../prompts/direct-plan-classification.ts";
import { buildDirectTodoPrompt, type DirectTodoPromptInput } from "../prompts/direct-todos.ts";
import {
  buildDirectIntegrationAuditPrompt,
  buildDirectIntegrationRepairPrompt,
  type DirectIntegrationAuditFile,
  type DirectIntegrationIssue,
  type DirectIntegrationRelationship,
} from "../prompts/direct-integration.ts";
import {
  buildDirectRepairPrompt,
  type DirectRepairDiagnostic,
  type DirectRepairRelatedFile,
} from "../prompts/direct-repair.ts";
import {
  buildCompilerDiagnosticsPrompt,
  parseCompilerDiagnostics,
  type CompilerDiagnosticPromptItem,
  type SemanticDiagnostic,
} from "../prompts/compiler-diagnostics.ts";
import {
  attachModelSkills,
  loadSelectedModelSkills,
  type ModelSkill,
  type SkillSelectionInput,
} from "../skills/index.ts";
import { GENERATED_CODE_SCHEMA_V1 } from "../llms/schemas.ts";
import {
  SELECTED_CODE_EDIT_TOOL,
  type ProviderToolCallV1,
} from "../llms/provider.ts";
import { languageProfile } from "../tools/discovery/languages.ts";
import { ModelOutputError, stripCodeFence } from "./presentation.ts";
import { runProviderToolLoop } from "./provider-tool-loop.ts";
import type { GenerateOptions } from "./types.ts";

/**
 * Hard ceiling on one provider response, independent of configuration. A
 * cooperating endpoint never approaches this; a broken or hostile one would
 * otherwise be free to stream until the process runs out of memory.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Bytes of an error body quoted back in a diagnostic. */
const MAX_ERROR_DETAIL_BYTES = 2048;

/**
 * Applied when no run budget reaches this layer. Every request must be bounded:
 * an endpoint that accepts a connection and then stalls used to hang the CLI
 * with no way out but Ctrl-C.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;

function requestTimeoutMs(options: GenerateOptions): number {
  const configured = options.timeoutMs;
  if (configured === undefined || !Number.isFinite(configured)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.floor(configured));
}

/**
 * Read a response body with a byte ceiling, refusing the declared length before
 * transferring anything when the endpoint is honest about an oversized body.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Provider response declared ${declared} bytes, above the ${maxBytes}-byte ceiling.`,
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error(`Provider response exceeded the ${maxBytes}-byte ceiling.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

interface ChatRequest {
  url: string;
  label: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * POST one chat request under a timeout and a response-size ceiling, and return
 * the decoded JSON body. Cancellation from the caller and expiry of the budget
 * both abort the in-flight request, including its body stream.
 */
async function postChat(request: ChatRequest, options: GenerateOptions): Promise<unknown> {
  const timeoutMs = requestTimeoutMs(options);
  const controller = new AbortController();
  const expiry = new Error(
    `${request.label} request exceeded the ${timeoutMs}ms budget (budgets.timeoutMs).`,
  );
  const timer = setTimeout(() => controller.abort(expiry), timeoutMs);
  const forwardAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...request.headers },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      // An aborted fetch reports the abort reason, which carries the useful
      // message; a genuine network failure does not.
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw new Error(
        `${request.label} request could not reach the provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await readBoundedText(response, MAX_ERROR_DETAIL_BYTES).catch(() => "");
      throw new Error(
        `${request.label} request failed: ${response.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${request.label} returned a response body that is not JSON.`);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract assistant text from a decoded chat response.
 *
 * Absent content becomes the empty string so the caller's own "model returned
 * no code" gate reports it, but content of the wrong *type* is refused here:
 * letting a number or object through produced an internal `TypeError` instead of
 * a diagnosis.
 */
function assistantText(value: unknown, label: string): string {
  const root = record(value);
  if (root === undefined) {
    throw new ModelOutputError(`${label} returned a response that is not an object.`);
  }
  if (typeof root.error === "string" && root.error.length > 0) {
    throw new Error(`${label} reported an error: ${root.error.slice(0, 500)}`);
  }
  const choice = Array.isArray(root.choices) ? record(root.choices[0]) : undefined;
  const message = record(root.message) ?? record(choice?.message);
  const content = message?.content;
  if (content === undefined || content === null) return "";
  if (typeof content !== "string") {
    throw new ModelOutputError(
      `${label} returned assistant content of type ${typeof content} instead of text.`,
    );
  }
  return content;
}

/** One plain chat completion through OpenAI-compatible chat or Ollama. */
async function requestChatCompletion(prompt: PromptMessages, options: GenerateOptions): Promise<string> {
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];

  if (options.provider === "openai") {
    const base = options.baseUrl ?? "https://api.openai.com/v1";
    const data = await postChat(
      {
        url: `${base}/chat/completions`,
        label: "OpenAI",
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        body: { model: options.model, messages, temperature: 0 },
      },
      options,
    );
    return stripCodeFence(assistantText(data, "OpenAI"));
  }

  // Everything below speaks Ollama's wire format. Reaching it with a provider
  // that only exists in the config schema would send the request to the Ollama
  // endpoint under a foreign model id, so refuse instead of falling through.
  if (options.provider !== "ollama") {
    throw new Error(
      `Provider ${JSON.stringify(options.provider)} has no adapter in this release.`,
    );
  }

  const base = options.baseUrl ?? "http://localhost:11434";
  const data = await postChat(
    {
      url: `${base.replace(/\/api\/?$/u, "")}/api/chat`,
      label: "Ollama",
      headers: {},
      body: {
        model: options.model,
        stream: false,
        options: options.compilerMode
          ? {
              temperature: 0,
              seed: 0,
              top_k: 1,
              top_p: 1,
              repeat_penalty: 1,
            }
          : { temperature: 0 },
        messages,
      },
    },
    options,
  );
  return stripCodeFence(assistantText(data, "Ollama"));
}

/**
 * Selects markdown immediately before the model call. For example,
 * `npx human-to-code .` loads `css-responsive` for a responsive stylesheet,
 * while a Python request receives no web/CSS skill block at all.
 */
async function withSkills(prompt: PromptMessages, input: SkillSelectionInput): Promise<PromptMessages> {
  return attachModelSkills(prompt, await loadSelectedModelSkills(input));
}

function validateGeneratedCodeEnvelope(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelOutputError("Provider generated-code output was not an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== "code"
    || keys[1] !== "schemaVersion"
    || record.schemaVersion !== 1
    || typeof record.code !== "string"
    || record.code.trim().length === 0
    || Buffer.byteLength(record.code, "utf8") > MAX_RESPONSE_BYTES
  ) {
    throw new ModelOutputError(
      "Provider generated-code output failed the exact {schemaVersion, code} contract.",
    );
  }
  return record.code;
}

async function requestAgentCode(
  prompt: PromptMessages,
  options: GenerateOptions,
): Promise<string> {
  const runtime = options.agentRuntime;
  if (runtime === undefined) {
    throw new Error("The agent runtime was not configured.");
  }
  const remainingContextCalls = runtime.remainingToolCalls();
  const selectedEdit = options.selectedSource !== undefined;
  const tools = runtime.adapter.capabilities.remote
    ? []
    : [
        ...(remainingContextCalls > 0 ? runtime.tools : []),
        ...(selectedEdit ? [SELECTED_CODE_EDIT_TOOL] : []),
      ];
  const maximumToolCalls = Math.min(
    8,
    remainingContextCalls + (selectedEdit ? 1 : 0),
  );
  let submittedReplacement: string | undefined;
  const validateSelectedEditCall = (call: ProviderToolCallV1): string => {
    const keys = Object.keys(call.arguments).sort();
    if (
      keys.length !== 2
      || keys[0] !== "newText"
      || keys[1] !== "path"
      || call.arguments.path !== options.targetPath
      || typeof call.arguments.newText !== "string"
      || call.arguments.newText.trim().length === 0
      || Buffer.byteLength(call.arguments.newText, "utf8") > MAX_RESPONSE_BYTES
    ) {
      throw new ModelOutputError(
        "replace_selected_code requires exactly the reviewed target path and non-empty newText.",
      );
    }
    return call.arguments.newText;
  };
  const result = await runProviderToolLoop({
    adapter: runtime.adapter,
    budget: runtime.budget,
    request: {
      operation: "patch",
      model: options.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "system", content: runtime.contextSystemPrompt },
        { role: "user", content: prompt.user },
      ],
      responseSchema: GENERATED_CODE_SCHEMA_V1,
      timeoutMs: Math.min(requestTimeoutMs(options), 60 * 60_000),
      maxOutputTokens: runtime.maxOutputTokens,
      temperature: 0,
      signal: options.signal,
    },
    validateFinal: selectedEdit
      ? () => {
          throw new ModelOutputError(
            "A selected-code edit must be submitted through replace_selected_code.",
          );
        }
      : validateGeneratedCodeEnvelope,
    tools,
    validateToolCall: (call) => {
      if (call.name === SELECTED_CODE_EDIT_TOOL.name) {
        validateSelectedEditCall(call);
      } else {
        runtime.validateToolCall(call);
      }
    },
    executeTool: async (call) => {
      if (call.name === SELECTED_CODE_EDIT_TOOL.name) {
        submittedReplacement = validateSelectedEditCall(call);
        return {
          schemaVersion: 1,
          ok: true,
          path: options.targetPath!,
          staged: true,
        };
      }
      return runtime.executeTool(call);
    },
    terminalAfterTools: (calls) => {
      const edits = calls.filter((call) => call.name === SELECTED_CODE_EDIT_TOOL.name);
      if (edits.length === 0) return undefined;
      if (edits.length !== 1 || submittedReplacement === undefined) {
        throw new ModelOutputError(
          "The agent must submit exactly one replace_selected_code call.",
        );
      }
      return { value: submittedReplacement };
    },
    maxToolCalls: maximumToolCalls,
  });
  return stripCodeFence(result.value);
}

/**
 * Resolve the exact package-owned guidance used for one coding request. Compiler
 * replay keys call the same helper, so changing a selected skill invalidates
 * cached bytes instead of replaying output generated under older guidance.
 */
export async function loadCodingModelSkills(
  instruction: string,
  options: GenerateOptions,
): Promise<ModelSkill[]> {
  const profile = languageProfile(options.language);
  const extension = options.targetPath?.match(/\.[^.]+$/u)?.[0]?.toLowerCase();
  const languageLabel = extension === ".tsx"
    ? "TypeScript with JSX (TSX)"
    : extension === ".jsx"
      ? "JavaScript with JSX"
      : profile.label;
  return loadSelectedModelSkills({
    phase: "coding",
    languages: [options.language, languageLabel],
    mode: options.inline ? "inline" : "file",
    insertionContexts: options.insertionContext ? [options.insertionContext] : [],
    targetPaths: options.targetPath ? [options.targetPath] : [],
    instructions: [instruction],
    evidence: [
      options.projectMemory ?? "",
      options.blueprint ?? "",
      options.todos ?? "",
      options.validationFailure ?? "",
    ],
  });
}

/** Send one direct-conversion request to OpenAI-compatible chat or Ollama. */
export async function generateCode(instruction: string, options: GenerateOptions): Promise<string> {
  const profile = languageProfile(options.language);
  const extension = options.targetPath?.match(/\.[^.]+$/u)?.[0]?.toLowerCase();
  const languageLabel = extension === ".tsx"
    ? "TypeScript with JSX (TSX)"
    : extension === ".jsx"
      ? "JavaScript with JSX"
      : profile.label;
  const basePrompt = buildDirectConversionPrompt({
    languageLabel,
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    instruction,
    ...(options.sessionMemory ? { sessionMemory: options.sessionMemory } : {}),
    inline: options.inline ?? false,
    ...(options.insertionContext ? { insertionContext: options.insertionContext } : {}),
    ...(options.insertionOwner ? { insertionOwner: options.insertionOwner } : {}),
    ...(options.surroundingSource ? { surroundingSource: options.surroundingSource } : {}),
    ...(options.existingSource ? { existingSource: options.existingSource } : {}),
    ...(options.selectedSource ? { selectedSource: options.selectedSource } : {}),
    ...(options.selectedSource && options.agentRuntime
      ? { selectedEditTool: true }
      : {}),
    ...(options.fileMemory ? { fileMemory: options.fileMemory } : {}),
    ...(options.projectMemory ? { projectMemory: options.projectMemory } : {}),
    ...(options.blueprint ? { blueprint: options.blueprint } : {}),
    ...(options.todos ? { todos: options.todos } : {}),
    ...(options.currentDraft ? { currentDraft: options.currentDraft } : {}),
    ...(options.unaddressedTodos ? { unaddressedTodos: options.unaddressedTodos } : {}),
    ...(options.rejectedDraft ? { rejectedDraft: options.rejectedDraft } : {}),
    ...(options.validationFailure ? { validationFailure: options.validationFailure } : {}),
    ...(options.compilerMode ? { compilerMode: true } : {}),
    ...(options.agentRuntime ? { structuredOutput: true } : {}),
  });
  // Every request reasons through the model, so the src/skills guidance is
  // attached in compiler mode too — that is exactly when a small model most
  // needs it. Compiler determinism comes from the lockfile/replay cache and the
  // fixed sampling options above, not from withholding guidance.
  const prompt = attachModelSkills(
    basePrompt,
    await loadCodingModelSkills(instruction, options),
  );
  return options.agentRuntime
    ? requestAgentCode(prompt, options)
    : requestChatCompletion(prompt, options);
}

/**
 * Decide, in one request, which units in a batch need a todo-planning pass.
 * Returns the set of the batch's 1-based indices that warrant planning. The
 * output is a bounded integer list, so a mis-classification only shifts cost —
 * it can never inject content into generated code.
 */
export async function classifyPlanningNeed(
  items: readonly DirectPlanClassificationItem[],
  options: GenerateOptions,
): Promise<Set<number>> {
  const raw = await requestChatCompletion(
    buildDirectPlanClassificationPrompt({ items }),
    options,
  );
  return parseDirectPlanClassification(raw, items.length);
}

/** Ask the opt-in semantic layer only for additional unresolved decisions. */
export async function generateSpecDiagnostics(
  items: readonly CompilerDiagnosticPromptItem[],
  options: GenerateOptions,
): Promise<SemanticDiagnostic[]> {
  const raw = await requestChatCompletion(
    buildCompilerDiagnosticsPrompt(items),
    options,
  );
  return parseCompilerDiagnostics(raw, items.length);
}

/** Decide whether one marker is conversation/context or an actual source edit. */
export async function classifyHumanTurn(
  request: DirectTurnClassificationPromptInput,
  options: GenerateOptions,
): Promise<DirectTurnPlan> {
  const raw = await requestChatCompletion(buildDirectTurnClassificationPrompt(request), options);
  return parseDirectTurnClassification(raw);
}

/**
 * One shared planning request per run. Its output is strict JSON, so it is not
 * passed through the code-fence stripper's expectations beyond the shared
 * transport; the caller parses and bounds it.
 */
export async function generateBlueprint(
  request: DirectBlueprintPromptInput,
  options: GenerateOptions,
): Promise<string> {
  const prompt = await withSkills(buildDirectBlueprintPrompt(request), {
    phase: "blueprint",
    languages: request.targets.map((target) => target.language),
    targetPaths: request.targets.map((target) => target.path),
    instructions: request.targets.map((target) => target.instruction),
    evidence: request.currentTree,
  });
  return requestChatCompletion(prompt, options);
}

/** One todo-list planning request for exactly one target. */
export async function generateUnitTodos(
  request: Omit<DirectTodoPromptInput, "languageLabel">,
  options: GenerateOptions,
): Promise<string> {
  const profile = languageProfile(options.language);
  const prompt = await withSkills(buildDirectTodoPrompt({ languageLabel: profile.label, ...request }), {
    phase: "todo",
    languages: [options.language, profile.label],
    mode: request.inline ? "inline" : "file",
    targetPaths: [request.targetPath],
    instructions: [request.instruction],
    evidence: [request.projectMemory ?? "", request.blueprint ?? ""],
  });
  return requestChatCompletion(prompt, options);
}

export interface IntegrationAuditGenerationRequest {
  files: readonly DirectIntegrationAuditFile[];
  relationships: readonly DirectIntegrationRelationship[];
  projectMemory?: string;
}

/** Send one opt-in, read-only, cross-language integration audit request. */
export async function generateIntegrationAudit(
  request: IntegrationAuditGenerationRequest,
  options: GenerateOptions,
): Promise<string> {
  const prompt = await withSkills(buildDirectIntegrationAuditPrompt(request), {
    phase: "audit",
    languages: request.files.map((file) => file.language),
    targetPaths: request.files.map((file) => file.path),
    instructions: request.files.map((file) => file.instruction),
    evidence: [
      request.projectMemory ?? "",
      ...request.files.flatMap((file) => [file.contract, file.content ?? ""]),
      ...request.relationships.map((relationship) => `${relationship.role} ${relationship.reference}`),
    ],
  });
  return requestChatCompletion(prompt, options);
}

export interface IntegrationRepairGenerationRequest {
  targetPath: string;
  instruction: string;
  currentCode: string;
  issues: readonly DirectIntegrationIssue[];
  relatedFiles: ReadonlyArray<{ path: string; content: string }>;
  projectMemory?: string;
}

/** Send one bounded target repair after a generic integration audit. */
export async function generateIntegrationRepairCode(
  request: IntegrationRepairGenerationRequest,
  options: GenerateOptions,
): Promise<string> {
  const profile = languageProfile(options.language);
  const prompt = await withSkills(
    buildDirectIntegrationRepairPrompt({ languageLabel: profile.label, ...request }),
    {
      phase: "repair",
      languages: [options.language, profile.label],
      mode: "file",
      targetPaths: [request.targetPath, ...request.relatedFiles.map((file) => file.path)],
      instructions: [request.instruction],
      evidence: [
        request.projectMemory ?? "",
        ...request.issues.map((issue) => `${issue.code} ${issue.message}`),
        ...request.relatedFiles.map((file) => file.content),
      ],
    },
  );
  return requestChatCompletion(prompt, options);
}

export interface RepairGenerationRequest {
  targetPath: string;
  inline: boolean;
  instruction: string;
  currentCode: string;
  diagnostics: readonly DirectRepairDiagnostic[];
  hints?: readonly string[];
  relatedFiles: readonly DirectRepairRelatedFile[];
  projectMemory?: string;
}

/** Send one bounded cross-file repair request with the same provider and model. */
export async function generateRepairCode(
  request: RepairGenerationRequest,
  options: GenerateOptions,
): Promise<string> {
  const profile = languageProfile(options.language);
  const prompt = await withSkills(buildDirectRepairPrompt({ languageLabel: profile.label, ...request }), {
    phase: "repair",
    languages: [options.language, profile.label],
    mode: request.inline ? "inline" : "file",
    targetPaths: [request.targetPath, ...request.relatedFiles.map((file) => file.path)],
    instructions: [request.instruction],
    evidence: [
      request.projectMemory ?? "",
      ...(request.hints ?? []),
      ...request.diagnostics.map((diagnostic) => diagnostic.message),
      ...request.relatedFiles.map((file) => file.content),
    ],
  });
  return requestChatCompletion(prompt, options);
}
