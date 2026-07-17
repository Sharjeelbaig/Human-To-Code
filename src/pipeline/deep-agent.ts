/**
 * Deep-agent orchestration for the direct `npx human-to-code .` flow.
 *
 * This path runs a LangChain/LangGraph "deep agent" (via the `deepagents`
 * harness) with the four batteries-included pillars:
 *
 *   1. Planning     — the built-in `write_todos` tool decomposes the run.
 *   2. File System  — a real-disk `FilesystemBackend` rooted at the project
 *                     gives the agent `ls`/`read_file`/`write_file`/`edit_file`/
 *                     `glob`/`grep` over the working tree.
 *   3. Sub Agents   — a `planner`, `implementer`, and `reviewer` subagent are
 *                     reachable through the built-in `task` tool.
 *   4. Prompts      — a task-specific system prompt for the main agent and one
 *                     per subagent role.
 *
 * Unlike the deterministic guided pipeline, the model drives scope, file
 * reads/writes, and delegation here. The blast radius is bounded to the project
 * root by the backend and by deny-write filesystem permissions on sensitive
 * paths, but this is an autonomous agent, not a hash-verified patch pipeline.
 */

import { createDeepAgent, type SubAgent } from "deepagents";
import { FilesystemBackend } from "deepagents/node";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { FilesystemPermission } from "deepagents";
import type { ConversionUnit } from "./simple.ts";
import { languageProfile } from "./simple.ts";

/** Provider identity and connection details for building a chat model. */
export interface DeepAgentModelOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface DeepAgentRunOptions extends DeepAgentModelOptions {
  /** Absolute project root; becomes the agent filesystem root. */
  root: string;
  /** Operator-declared output language. */
  language: string;
  /** Deterministically discovered worklist, seeded into the task prompt. */
  units: readonly ConversionUnit[];
  /** Test/embedding seam: skip provider construction and use this model. */
  model_override?: BaseChatModel;
  /** Hard cap on agent graph steps so a loop cannot run unbounded. */
  recursionLimit?: number;
  /** Live progress sink for interactive output (planning, tool calls, delegation). */
  onProgress?: (event: DeepAgentProgress) => void;
  signal?: AbortSignal;
}

export interface DeepAgentTodo {
  content: string;
  status: string;
}

/** A live event emitted while the agent runs, for interactive rendering. */
export type DeepAgentProgress =
  | { kind: "plan"; todos: DeepAgentTodo[] }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "assistant"; text: string };

export interface DeepAgentRunResult {
  /** Final plan the agent produced (the Planning pillar's output). */
  todos: DeepAgentTodo[];
  /** Number of messages exchanged in the run. */
  messageCount: number;
  /** The agent's final natural-language summary, if any. */
  summary: string;
}

/**
 * Writes are denied on version-control internals, dependencies, the tool's own
 * state, and credential-bearing files. Paths are backend-absolute globs (rooted
 * at the project). Reads stay permissive so the agent can ground itself.
 */
const DENY_WRITE_PATHS: readonly string[] = [
  "/.git/**",
  "/.hg/**",
  "/.svn/**",
  "/node_modules/**",
  "/.human-to-code/**",
  "/human-to-code.config.json",
  "/secrets.human",
  "/**/.env",
  "/**/.env.*",
  "/**/*.env",
  "/**/*.env.*",
  "/**/*.pem",
  "/**/*.key",
  "/**/id_rsa",
  "/**/id_ed25519",
];

function mainSystemPrompt(languageLabel: string): string {
  return [
    `You are human-to-code, an autonomous ${languageLabel} coding agent.`,
    "Your job is to fulfil natural-language change requests that a developer left in their codebase, in two forms:",
    "  1. Whole `.human` files (never `*.strict.human`): generate a sibling source file with the same base name and the language's extension, containing only real code.",
    "  2. Inline `@human` markers inside existing source files: replace the marker comment in place with the code it asks for, preserving all surrounding code.",
    "",
    "Working method — be efficient; every step is a slow model call, so avoid unnecessary ones:",
    "- First call write_todos once to record a short ordered plan covering every worklist item.",
    "- Read each target file once with read_file to ground yourself before editing. Every path is absolute and rooted at the project: it must start with `/` (e.g. `/src/a.ts`).",
    "- For simple items, write the code yourself directly with write_file (for `.human` file outputs) or edit_file (for inline markers). Only delegate to the `implementer` subagent for genuinely complex items, and only use the `reviewer` subagent when correctness is non-obvious. Do not delegate or review trivial one-liners.",
    "- Never remove or rewrite code that a marker did not ask you to change. Reuse declarations that already exist in the file instead of redeclaring them.",
    "- Keep todos updated: mark each in_progress when you start it and completed when its code is written.",
    "- When every item is done, stop and give a one-line summary. Do not re-read or re-verify files you have already written.",
    "",
    "Output only real, compilable code into files. Do not add comments describing what you changed. Do not touch dependency, VCS, secret, or configuration files.",
  ].join("\n");
}

function plannerSubagent(languageLabel: string): SubAgent {
  return {
    name: "planner",
    description: "Break a human-to-code conversion request into an ordered, file-by-file implementation plan. Use before writing any code when the worklist is non-trivial.",
    systemPrompt: [
      `You plan ${languageLabel} conversion work.`,
      "Given a worklist of `.human` files and inline `@human` markers, produce a concise, ordered list of concrete implementation steps.",
      "Account for dependencies between steps (e.g. a marker that uses a symbol another marker declares).",
      "Return only the plan as a numbered list. Write no code.",
    ].join("\n"),
  };
}

function implementerSubagent(languageLabel: string): SubAgent {
  return {
    name: "implementer",
    description: "Generate the exact code for one `.human` file or one inline `@human` marker. Delegate each concrete code-writing step to this subagent.",
    systemPrompt: [
      `You are a precise ${languageLabel} code generator.`,
      "You are given one instruction and the relevant file context.",
      "Return only the code that satisfies the instruction: for a whole-file request, the full file body; for an inline marker, only the replacement for that marker.",
      "Reuse declarations already present in the file; never redeclare or duplicate them unless explicitly asked to shadow.",
      "No explanations, no markdown fences, no comments describing your work.",
    ].join("\n"),
  };
}

function reviewerSubagent(languageLabel: string): SubAgent {
  return {
    name: "reviewer",
    description: "Check that generated code matches its instruction, is syntactically valid, and did not corrupt surrounding code. Use after each implementation step.",
    systemPrompt: [
      `You review generated ${languageLabel} code.`,
      "Given the original instruction and the code that was written, confirm it satisfies the instruction, is syntactically plausible, and preserves unrelated surrounding code.",
      "If it is correct, respond APPROVED with a one-line reason. If not, respond CHANGES with a concrete, minimal fix instruction.",
    ].join("\n"),
  };
}

/** Backend paths are absolute, rooted at the project (e.g. `src/a.ts` -> `/src/a.ts`). */
function backendPath(relativePath: string): string {
  return `/${relativePath.replace(/^\/+/u, "")}`;
}

function taskPrompt(units: readonly ConversionUnit[], languageLabel: string): string {
  const pathRule = "All filesystem tool paths are absolute and rooted at the project: they must start with `/` (for example the file `src/a.ts` is `/src/a.ts`). Never pass a relative path.";
  if (units.length === 0) {
    return [
      `Scan the project for any \`.human\` files or inline \`@human\` markers and convert them to ${languageLabel}.`,
      pathRule,
      "If there are none, report that nothing needs conversion.",
    ].join("\n");
  }
  const worklist = units
    .map((unit, index) => {
      if (unit.kind === "file") {
        return `${index + 1}. Whole file: read "${backendPath(unit.sourcePath)}" and write its generated ${languageLabel} into "${backendPath(unit.outputPath ?? unit.sourcePath)}". Instruction: ${unit.prompt}`;
      }
      return `${index + 1}. Inline marker in "${backendPath(unit.sourcePath)}": replace the @human marker in place, preserving surrounding code. Instruction: ${unit.prompt}`;
    })
    .join("\n");
  return [
    `Convert the following ${units.length} item(s) to ${languageLabel}.`,
    pathRule,
    "",
    worklist,
    "",
    "Plan once with write_todos, read each target file once, then write the code directly with write_file or edit_file (only delegating complex items to the implementer subagent). Report a short summary of what you wrote when done.",
  ].join("\n");
}

/**
 * Construct a LangChain chat model for the configured provider.
 *
 * Both providers use the OpenAI-compatible chat client. Ollama is reached
 * through its `/v1` endpoint rather than `@langchain/ollama`'s native
 * `/api/chat`: the deep-agent harness emits tool messages with structured
 * (array) content, which the native Ollama adapter rejects, whereas the
 * OpenAI-compatible surface serializes them correctly.
 */
export async function buildDeepAgentModel(options: DeepAgentModelOptions): Promise<BaseChatModel> {
  const { ChatOpenAI } = await import("@langchain/openai");
  if (options.provider === "openai") {
    return new ChatOpenAI({
      model: options.model,
      temperature: 0,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { configuration: { baseURL: options.baseUrl } } : {}),
    });
  }
  if (options.provider === "ollama") {
    const root = (options.baseUrl ?? "http://localhost:11434").replace(/\/+$/u, "").replace(/\/v1$/u, "");
    return new ChatOpenAI({
      model: options.model,
      temperature: 0,
      // Ollama ignores the key but the OpenAI client requires a non-empty value.
      apiKey: options.apiKey ?? "ollama",
      configuration: { baseURL: `${root}/v1` },
    });
  }
  throw new Error(`Provider '${options.provider}' has no deep-agent chat-model binding. Use openai or ollama.`);
}

/**
 * Build (but do not run) the deep agent. Exposed so callers and tests can
 * inspect wiring without a live provider.
 */
export async function buildDeepAgent(options: DeepAgentRunOptions) {
  const label = languageProfile(options.language).label;
  const model = options.model_override ?? await buildDeepAgentModel(options);
  const backend = new FilesystemBackend({ rootDir: options.root });
  const permissions: FilesystemPermission[] = [
    { operations: ["write"], paths: [...DENY_WRITE_PATHS], mode: "deny" },
  ];
  return createDeepAgent({
    model,
    backend,
    systemPrompt: mainSystemPrompt(label),
    subagents: [plannerSubagent(label), implementerSubagent(label), reviewerSubagent(label)],
    permissions,
  });
}

interface StreamedMessage {
  id?: string;
  content?: unknown;
  name?: unknown;
  getType?: () => string;
  tool_calls?: Array<{ name?: unknown; args?: Record<string, unknown> }>;
}

interface StreamedTodo {
  content?: unknown;
  status?: unknown;
}

function normalizeTodos(raw: readonly StreamedTodo[]): DeepAgentTodo[] {
  return raw.map((todo) => ({
    content: typeof todo.content === "string" ? todo.content : String(todo.content ?? ""),
    status: typeof todo.status === "string" ? todo.status : String(todo.status ?? ""),
  }));
}

/** Short human detail for a tool call (the path it touches or subagent it invokes). */
function toolDetail(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (name === "task") {
    const sub = args.subagent_type ?? args.subagentType ?? args.name ?? args.description;
    return typeof sub === "string" ? sub.split(/\s+/u).slice(0, 6).join(" ") : undefined;
  }
  for (const key of ["file_path", "filePath", "path", "file"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Run the deep agent against the discovered worklist, streaming live progress
 * (planning, tool calls, delegation) through `onProgress`. The agent edits
 * files on disk through its filesystem backend; this returns the final plan and
 * summary it produced for the report.
 */
export async function runDeepAgentConversion(options: DeepAgentRunOptions): Promise<DeepAgentRunResult> {
  const agent = await buildDeepAgent(options);
  const label = languageProfile(options.language).label;
  const input = { messages: [{ role: "user", content: taskPrompt(options.units, label) }] };
  const config = {
    recursionLimit: options.recursionLimit ?? 150,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const seenMessages = new Set<string>();
  let todos: DeepAgentTodo[] = [];
  let lastTodosKey = "";
  let summary = "";
  let messageCount = 0;

  const stream = await agent.stream(input, { ...config, streamMode: "updates" as const });
  for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
    for (const update of Object.values(chunk)) {
      if (!update || typeof update !== "object") continue;
      const node = update as { messages?: unknown; todos?: unknown };

      if (Array.isArray(node.todos)) {
        const next = normalizeTodos(node.todos as StreamedTodo[]);
        const key = JSON.stringify(next);
        if (key !== lastTodosKey) {
          lastTodosKey = key;
          todos = next;
          options.onProgress?.({ kind: "plan", todos: next });
        }
      }

      if (Array.isArray(node.messages)) {
        for (const raw of node.messages) {
          const message = raw as StreamedMessage;
          const id = typeof message.id === "string" ? message.id : undefined;
          if (id) {
            if (seenMessages.has(id)) continue;
            seenMessages.add(id);
          }
          messageCount += 1;
          const type = typeof message.getType === "function" ? message.getType() : undefined;
          if (type === "ai") {
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
              for (const call of message.tool_calls) {
                const name = typeof call.name === "string" ? call.name : "tool";
                const detail = toolDetail(name, call.args);
                options.onProgress?.({ kind: "tool", name, ...(detail ? { detail } : {}) });
              }
            } else if (typeof message.content === "string" && message.content.trim().length > 0) {
              summary = message.content.trim();
              options.onProgress?.({ kind: "assistant", text: summary });
            }
          }
        }
      }
    }
  }

  return { todos, messageCount, summary };
}
