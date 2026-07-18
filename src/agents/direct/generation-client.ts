import { buildDirectConversionPrompt, type PromptMessages } from "../../prompts/direct-conversion.ts";
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
    instruction,
    inline: options.inline ?? false,
    ...(options.fileMemory ? { fileMemory: options.fileMemory } : {}),
  });
  return requestChatCompletion(prompt, options);
}

export interface RepairGenerationRequest {
  targetPath: string;
  inline: boolean;
  instruction: string;
  currentCode: string;
  diagnostics: readonly DirectRepairDiagnostic[];
  relatedFiles: readonly DirectRepairRelatedFile[];
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
