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
  type DirectTurnAction,
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
  attachModelSkills,
  loadSelectedModelSkills,
  type SkillSelectionInput,
} from "../skills/index.ts";
import { languageProfile } from "../tools/discovery/languages.ts";
import { stripCodeFence } from "./presentation.ts";
import type { GenerateOptions } from "./types.ts";

/** One plain chat completion through OpenAI-compatible chat or Ollama. */
async function requestChatCompletion(prompt: PromptMessages, options: GenerateOptions): Promise<string> {
  if (options.provider === "openai") {
    const base = options.baseUrl ?? "https://api.openai.com/v1";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0,
      }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return stripCodeFence(data.choices?.[0]?.message?.content ?? "");
  }

  const base = options.baseUrl ?? "http://localhost:11434";
  const response = await fetch(`${base.replace(/\/api\/?$/u, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return stripCodeFence(data.message?.content ?? "");
}

/**
 * Selects markdown immediately before the model call. For example,
 * `npx human-to-code .` loads `css-responsive` for a responsive stylesheet,
 * while a Python request receives no web/CSS skill block at all.
 */
async function withSkills(prompt: PromptMessages, input: SkillSelectionInput): Promise<PromptMessages> {
  return attachModelSkills(prompt, await loadSelectedModelSkills(input));
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
  const prompt = await withSkills(buildDirectConversionPrompt({
    languageLabel,
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    instruction,
    ...(options.sessionMemory ? { sessionMemory: options.sessionMemory } : {}),
    inline: options.inline ?? false,
    ...(options.insertionContext ? { insertionContext: options.insertionContext } : {}),
    ...(options.insertionOwner ? { insertionOwner: options.insertionOwner } : {}),
    ...(options.surroundingSource ? { surroundingSource: options.surroundingSource } : {}),
    ...(options.fileMemory ? { fileMemory: options.fileMemory } : {}),
    ...(options.projectMemory ? { projectMemory: options.projectMemory } : {}),
    ...(options.blueprint ? { blueprint: options.blueprint } : {}),
    ...(options.todos ? { todos: options.todos } : {}),
    ...(options.currentDraft ? { currentDraft: options.currentDraft } : {}),
    ...(options.unaddressedTodos ? { unaddressedTodos: options.unaddressedTodos } : {}),
    ...(options.rejectedDraft ? { rejectedDraft: options.rejectedDraft } : {}),
    ...(options.validationFailure ? { validationFailure: options.validationFailure } : {}),
  }), {
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
  return requestChatCompletion(prompt, options);
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

/** Decide whether one marker is conversation/context or an actual source edit. */
export async function classifyHumanTurn(
  request: DirectTurnClassificationPromptInput,
  options: GenerateOptions,
): Promise<DirectTurnAction> {
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
