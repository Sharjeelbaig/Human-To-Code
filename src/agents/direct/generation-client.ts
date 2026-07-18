import { buildDirectConversionPrompt } from "../../prompts/direct-conversion.ts";
import { languageProfile } from "./languages.ts";
import { stripCodeFence } from "./presentation.ts";
import type { GenerateOptions } from "./types.ts";

/** Send one direct-conversion request to OpenAI-compatible chat or Ollama. */
export async function generateCode(instruction: string, options: GenerateOptions): Promise<string> {
  const profile = languageProfile(options.language);
  const prompt = buildDirectConversionPrompt({
    languageLabel: profile.label,
    instruction,
    inline: options.inline ?? false,
    ...(options.fileMemory ? { fileMemory: options.fileMemory } : {}),
  });

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
