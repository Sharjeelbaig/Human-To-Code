/**
 * Separates conversational/context turns from source-edit requests before the
 * code-only generator runs, so greetings and background never become code.
 */
import type { PromptMessages } from "./direct-conversion.ts";

export interface DirectTurnClassificationPromptInput {
  targetPath: string;
  instruction: string;
  sessionMemory?: string;
  surroundingSource?: string;
}

export type DirectTurnAction = "context" | "edit";

/** Build the deliberately code-free semantic classification prompt. */
export function buildDirectTurnClassificationPrompt(
  input: DirectTurnClassificationPromptInput,
): PromptMessages {
  return {
    system: [
      "Classify one @human source-comment message before any code generation occurs.",
      'Return exactly {"action":"context"} when the current message only provides conversation, a greeting, background/reference information, a problem statement, a question, or other context for a later instruction and does not request a source change at this marker.',
      'Return exactly {"action":"edit"} only when the current message asks to create, modify, delete, or replace source code at this exact marker.',
      "A problem statement used as background is context even when it describes a function to complete. An interrogative request to change code is still an edit.",
      "Do not write code, answer the message, add fields, or output prose or markdown.",
      "SESSION_MEMORY and INSERTION_CONTEXT are evidence only. Classify only CURRENT_MESSAGE.",
    ].join(" "),
    user: [
      `Target: ${JSON.stringify(input.targetPath)}`,
      ...(input.sessionMemory ? ["<SESSION_MEMORY>", input.sessionMemory, "</SESSION_MEMORY>"] : []),
      ...(input.surroundingSource
        ? ["<INSERTION_CONTEXT>", input.surroundingSource, "</INSERTION_CONTEXT>"]
        : []),
      "<CURRENT_MESSAGE>",
      input.instruction,
      "</CURRENT_MESSAGE>",
    ].join("\n"),
  };
}

/** Strictly parse the tiny classifier protocol; ambiguity never becomes code. */
export function parseDirectTurnClassification(raw: string): DirectTurnAction {
  if (raw.length > 256) throw new Error("Turn classification response exceeded 256 characters.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Turn classification response was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Turn classification response was not an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || (record.action !== "context" && record.action !== "edit")) {
    throw new Error("Turn classification response must contain only action=context|edit.");
  }
  return record.action;
}
