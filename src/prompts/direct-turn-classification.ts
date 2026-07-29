/**
 * Separates conversational/context turns from source-edit requests before the
 * code-only generator runs, so greetings and background never become code.
 */
import type { PromptMessages } from "./direct-conversion.ts";

export interface DirectTurnClassificationPromptInput {
  targetPath: string;
  instruction: string;
  markerLine?: number;
  numberedSource?: string;
  sessionMemory?: string;
  surroundingSource?: string;
}

export type DirectTurnAction = "context" | "edit";
export type DirectTurnPlan =
  | { action: "context" }
  | {
      action: "edit";
      mode: "insert" | "replace";
      startLine: number;
      endLine: number;
    };

/** Build the deliberately code-free semantic classification prompt. */
export function buildDirectTurnClassificationPrompt(
  input: DirectTurnClassificationPromptInput,
): PromptMessages {
  return {
    system: [
      "Classify one @human source-comment message before any code generation occurs.",
      'Return exactly {"action":"context"} when the current message does not request a source change.',
      'For code insertion at the marker, return exactly {"action":"edit","mode":"insert","startLine":N,"endLine":N}, using the marker line for both N values.',
      'For modification, repair, deletion, or replacement of existing code, return exactly {"action":"edit","mode":"replace","startLine":X,"endLine":Y}. X..Y must be the smallest complete existing syntactic construct that must change, excluding the @human marker line.',
      "Understand CURRENT_MESSAGE semantically in any human language. Do not depend on English keywords or the marker's physical direction words.",
      "A problem statement used as background is context even when it describes a function to complete. An interrogative request to change code is still an edit.",
      "Do not write code, answer the message, add fields, or output prose or markdown.",
      "NUMBERED_SOURCE, SESSION_MEMORY, and INSERTION_CONTEXT are evidence only. Classify only CURRENT_MESSAGE.",
    ].join(" "),
    user: [
      `Target: ${JSON.stringify(input.targetPath)}`,
      ...(input.markerLine === undefined ? [] : [`Marker line: ${input.markerLine}`]),
      ...(input.sessionMemory ? ["<SESSION_MEMORY>", input.sessionMemory, "</SESSION_MEMORY>"] : []),
      ...(input.surroundingSource
        ? ["<INSERTION_CONTEXT>", input.surroundingSource, "</INSERTION_CONTEXT>"]
        : []),
      ...(input.numberedSource
        ? ["<NUMBERED_SOURCE>", input.numberedSource, "</NUMBERED_SOURCE>"]
        : []),
      "<CURRENT_MESSAGE>",
      input.instruction,
      "</CURRENT_MESSAGE>",
    ].join("\n"),
  };
}

/** Strictly parse the tiny classifier protocol; ambiguity never becomes code. */
export function parseDirectTurnClassification(raw: string): DirectTurnPlan {
  if (raw.length > 512) throw new Error("Turn classification response exceeded 512 characters.");
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
  if (record.action === "context" && Object.keys(record).length === 1) {
    return { action: "context" };
  }
  // Backward-compatible provider fixtures: an unscoped edit remains insertion
  // at the marker and never gains broader write authority.
  if (record.action === "edit" && Object.keys(record).length === 1) {
    return { action: "edit", mode: "insert", startLine: 1, endLine: 1 };
  }
  const keys = Object.keys(record).sort();
  if (
    record.action !== "edit"
    || (record.mode !== "insert" && record.mode !== "replace")
    || typeof record.startLine !== "number"
    || typeof record.endLine !== "number"
    || !Number.isSafeInteger(record.startLine)
    || !Number.isSafeInteger(record.endLine)
    || keys.join(",") !== "action,endLine,mode,startLine"
  ) {
    throw new Error(
      "Turn classification response must be context or an exact edit mode with integer startLine/endLine.",
    );
  }
  return {
    action: "edit",
    mode: record.mode,
    startLine: record.startLine,
    endLine: record.endLine,
  };
}
