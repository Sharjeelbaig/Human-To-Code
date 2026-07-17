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
  signal?: AbortSignal;
}

export interface DeepAgentTodo {
  content: string;
  status: string;
}

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
    "Working method:",
    "- First call write_todos to record an ordered plan covering every worklist item.",
    "- Use the filesystem tools (ls, glob, grep, read_file) to ground yourself in the actual file contents before editing. Every path is absolute and rooted at the project: it must start with `/` (e.g. `/src/a.ts`).",
    "- For each item, delegate the actual code writing to the `implementer` subagent via the task tool, then have the `reviewer` subagent check the result against the instruction.",
    "- Apply edits with write_file (for `.human` file outputs) or edit_file (for inline markers). Never remove or rewrite code that a marker did not ask you to change.",
    "- Reuse declarations that already exist in the file instead of redeclaring them.",
    "- Keep todos updated: mark each in_progress before you start it and completed when its code is written and reviewed.",
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
    "Plan first with write_todos, ground yourself by reading the files, delegate code to the implementer subagent, review with the reviewer subagent, then write the files with write_file or edit_file. Report a short summary of what you wrote when done.",
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

interface AgentInvokeState {
  messages?: unknown[];
  todos?: Array<{ content?: unknown; status?: unknown }>;
}

function summarizeMessages(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { content?: unknown; getType?: () => string } | undefined;
    const type = typeof message?.getType === "function" ? message.getType() : undefined;
    if (type === "ai" && typeof message?.content === "string" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }
  return "";
}

/**
 * Run the deep agent against the discovered worklist. The agent edits files on
 * disk through its filesystem backend; this returns the plan and summary it
 * produced for the receipt/report.
 */
export async function runDeepAgentConversion(options: DeepAgentRunOptions): Promise<DeepAgentRunResult> {
  const agent = await buildDeepAgent(options);
  const label = languageProfile(options.language).label;
  const result = (await agent.invoke(
    { messages: [{ role: "user", content: taskPrompt(options.units, label) }] },
    {
      recursionLimit: options.recursionLimit ?? 150,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )) as AgentInvokeState;
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const todos: DeepAgentTodo[] = (result.todos ?? []).map((todo) => ({
    content: typeof todo.content === "string" ? todo.content : String(todo.content ?? ""),
    status: typeof todo.status === "string" ? todo.status : String(todo.status ?? ""),
  }));
  return {
    todos,
    messageCount: messages.length,
    summary: summarizeMessages(messages),
  };
}
