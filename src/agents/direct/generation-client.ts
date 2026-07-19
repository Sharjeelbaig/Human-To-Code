/**
 * Human-to-code role: send typed direct-conversion prompts through the chosen
 * provider while keeping provider mechanics out of discovery and application.
 */
import {
  buildDirectBlueprintPrompt,
  type DirectBlueprintPromptInput,
} from "../../prompts/direct-blueprint.ts";
import { buildDirectConversionPrompt, type PromptMessages } from "../../prompts/direct-conversion.ts";
import { buildDirectTodoPrompt, type DirectTodoPromptInput } from "../../prompts/direct-todos.ts";
import {
  buildDirectIntegrationAuditPrompt,
  buildDirectIntegrationRepairPrompt,
  type DirectIntegrationAuditFile,
  type DirectIntegrationIssue,
  type DirectIntegrationRelationship,
} from "../../prompts/direct-integration.ts";
import {
  buildDirectRepairPrompt,
  type DirectRepairDiagnostic,
  type DirectRepairRelatedFile,
} from "../../prompts/direct-repair.ts";
import { languageProfile } from "./languages.ts";
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

/** Send one direct-conversion request to OpenAI-compatible chat or Ollama. */
export async function generateCode(instruction: string, options: GenerateOptions): Promise<string> {
  const profile = languageProfile(options.language);
  const prompt = buildDirectConversionPrompt({
    languageLabel: profile.label,
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    instruction,
    inline: options.inline ?? false,
    ...(options.fileMemory ? { fileMemory: options.fileMemory } : {}),
    ...(options.projectMemory ? { projectMemory: options.projectMemory } : {}),
    ...(options.blueprint ? { blueprint: options.blueprint } : {}),
    ...(options.todos ? { todos: options.todos } : {}),
    ...(options.currentDraft ? { currentDraft: options.currentDraft } : {}),
    ...(options.unaddressedTodos ? { unaddressedTodos: options.unaddressedTodos } : {}),
  });
  return requestChatCompletion(prompt, options);
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
  return requestChatCompletion(buildDirectBlueprintPrompt(request), options);
}

/** One todo-list planning request for exactly one target. */
export async function generateUnitTodos(
  request: Omit<DirectTodoPromptInput, "languageLabel">,
  options: GenerateOptions,
): Promise<string> {
  const profile = languageProfile(options.language);
  return requestChatCompletion(buildDirectTodoPrompt({ languageLabel: profile.label, ...request }), options);
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
  const prompt = buildDirectIntegrationAuditPrompt(request);
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
  const prompt = buildDirectIntegrationRepairPrompt({ languageLabel: profile.label, ...request });
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
  const prompt = buildDirectRepairPrompt({ languageLabel: profile.label, ...request });
  return requestChatCompletion(prompt, options);
}
