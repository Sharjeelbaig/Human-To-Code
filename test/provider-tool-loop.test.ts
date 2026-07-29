import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeProject } from "../src/tools/analysis/analyzer.ts";
import {
  CONTEXT_REQUEST_TOOL,
  DeterministicMockProvider,
  ProviderBudgetTracker,
  ProviderError,
  SELECTED_CODE_EDIT_TOOL,
  type ProviderAdapter,
  type ProviderGenerationRequestV1,
} from "../src/llms/provider.ts";
import { GENERATED_CODE_SCHEMA_V1 } from "../src/llms/schemas.ts";
import { CompilerToolExecutor } from "../src/memory/compiler-tools.ts";
import { validateContextRequestV1 } from "../src/memory/context.ts";
import {
  AgentContextCoordinator,
  runProviderToolLoop,
} from "../src/workflows/provider-tool-loop.ts";

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

function finalCode(value: unknown): string {
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  assert.deepEqual(Object.keys(value as object).sort(), ["code", "schemaVersion"]);
  const record = value as Record<string, unknown>;
  assert.equal(record.schemaVersion, 1);
  assert.equal(typeof record.code, "string");
  return record.code as string;
}

function request(): ProviderGenerationRequestV1 {
  return {
    operation: "patch",
    model: "mock-model",
    messages: [
      { role: "system", content: "Generate one grounded target." },
      { role: "user", content: "Use the existing SERVICE_NAME export." },
    ],
    responseSchema: GENERATED_CODE_SCHEMA_V1,
    timeoutMs: 2_000,
    maxOutputTokens: 2_000,
  };
}

function budget(maxRequests = 4): ProviderBudgetTracker {
  return new ProviderBudgetTracker({
    maxInputTokens: 1_000_000,
    maxOutputTokens: 20_000,
    maxRequests,
    maxRepairs: 0,
    maxCostUsd: 1,
    maxElapsedMs: 20_000,
  });
}

test("local provider autonomously requests real bounded context before final code", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-provider-tool-loop-"));
  try {
    await put(root, "src/constants.ts", 'export const SERVICE_NAME = "billing";\n');
    const profile = await analyzeProject(root, { generalLanguage: "typescript" });
    const executor = new CompilerToolExecutor(root, profile, {
      allowedWorkspaceIds: ["general:."],
    });
    const coordinator = new AgentContextCoordinator({
      root,
      profile,
      executor,
      budget: {
        maxItems: 4,
        maxBytes: 16_384,
        maxEstimatedTokens: 4_096,
        maxBytesPerItem: 8_192,
      },
    });
    const provider = new DeterministicMockProvider({
      steps: [
        (first) => {
          assert.deepEqual(first.tools?.map((tool) => tool.name), ["request_context"]);
          return {
            finishReason: "tool_call",
            output: {
              toolCalls: [{
                id: "call-1",
                name: "request_context",
                arguments: {
                  schemaVersion: 1,
                  requestId: "context-1",
                  kind: "file",
                  workspace: "general:.",
                  query: "src/constants.ts",
                  reason: "Need the proven existing export.",
                  maxItems: 1,
                  path: "src/constants.ts",
                },
              }],
            },
          };
        },
        (second) => {
          const assistant = second.messages.find((message) =>
            message.role === "assistant" && message.toolCalls !== undefined);
          assert.equal(assistant?.toolCalls?.[0]?.id, "call-1");
          const tool = second.messages.find((message) => message.role === "tool");
          assert.equal(tool?.toolCallId, "call-1");
          const result = JSON.parse(tool?.content ?? "") as {
            evidence: Array<{ path: string; content: string; untrusted: boolean }>;
          };
          assert.equal(result.evidence[0]?.path, "src/constants.ts");
          assert.match(result.evidence[0]?.content ?? "", /SERVICE_NAME/u);
          assert.equal(result.evidence[0]?.untrusted, true);
          return {
            output: {
              schemaVersion: 1,
              code: 'import { SERVICE_NAME } from "./constants.js";\nconsole.log(SERVICE_NAME);\n',
            },
          };
        },
      ],
    });

    const tracker = budget();
    const result = await runProviderToolLoop({
      adapter: provider,
      budget: tracker,
      request: request(),
      validateFinal: finalCode,
      tools: [CONTEXT_REQUEST_TOOL],
      executeTool: (call) => coordinator.execute(call),
      maxToolCalls: 8,
    });

    assert.match(result.value, /SERVICE_NAME/u);
    assert.equal(result.turns.length, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(tracker.usage.requests, 2);
    assert.equal(coordinator.contextRequests, 1);
    assert.equal(coordinator.manifest.evidence[0]?.content.includes("billing"), true);
    assert.match(coordinator.manifestHash, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a terminal edit tool returns its staged replacement without a second model turn", async () => {
  const replacement = "async def generate(request):\n    body = await request.json()";
  const provider = new DeterministicMockProvider({
    steps: [{
      finishReason: "tool_call",
      output: {
        toolCalls: [{
          id: "edit-1",
          name: "replace_selected_code",
          arguments: { path: "main.py", newText: replacement },
        }],
      },
    }],
  });
  const result = await runProviderToolLoop({
    adapter: provider,
    request: request(),
    validateFinal: (): string => {
      throw new Error("A terminal edit must not request a final model response.");
    },
    tools: [SELECTED_CODE_EDIT_TOOL],
    executeTool: async () => ({ schemaVersion: 1, ok: true, staged: true }),
    terminalAfterTools: (calls) =>
      calls[0]?.name === "replace_selected_code"
        ? { value: calls[0].arguments.newText as string }
        : undefined,
    maxToolCalls: 1,
  });
  assert.equal(result.value, replacement);
  assert.equal(result.turns.length, 1);
  assert.equal(result.toolCalls, 1);
});

test("tool batches are validated atomically before any host action", async () => {
  let executions = 0;
  const provider = new DeterministicMockProvider({
    steps: [{
      finishReason: "tool_call",
      output: {
        toolCalls: [
          { id: "valid", name: "request_context", arguments: {} },
          { id: "invalid", name: "shell", arguments: { command: "pwd" } },
        ],
      },
    }],
  });
  await assert.rejects(
    runProviderToolLoop({
      adapter: provider,
      request: request(),
      validateFinal: finalCode,
      tools: [CONTEXT_REQUEST_TOOL],
      executeTool: async () => {
        executions += 1;
        return {};
      },
      maxToolCalls: 8,
    }),
    (error: unknown) =>
      error instanceof ProviderError
      && error.code === "schema"
      && /undeclared tool/u.test(error.message),
  );
  assert.equal(executions, 0);
});

test("all context arguments are exact-validated before a tool batch executes", async () => {
  let executions = 0;
  const valid = {
    schemaVersion: 1,
    requestId: "valid-context",
    kind: "symbol",
    workspace: "general:.",
    query: "SERVICE_NAME",
    reason: "Need an existing symbol.",
    maxItems: 1,
    path: null,
  };
  const provider = new DeterministicMockProvider({
    steps: [{
      finishReason: "tool_call",
      output: {
        toolCalls: [
          { id: "first", name: "request_context", arguments: valid },
          {
            id: "second",
            name: "request_context",
            arguments: { ...valid, requestId: "invalid-context", path: "../outside.ts" },
          },
        ],
      },
    }],
  });
  await assert.rejects(
    runProviderToolLoop({
      adapter: provider,
      request: request(),
      validateFinal: finalCode,
      tools: [CONTEXT_REQUEST_TOOL],
      validateToolCall: (call) => {
        validateContextRequestV1(call.arguments);
      },
      executeTool: async () => {
        executions += 1;
        return {};
      },
      maxToolCalls: 8,
    }),
    /contextRequest\.path/u,
  );
  assert.equal(executions, 0);
});

test("provider request budget includes the mandatory post-tool turn", async () => {
  let transmissions = 0;
  const provider = new DeterministicMockProvider({
    steps: [
      () => {
        transmissions += 1;
        return {
          finishReason: "tool_call",
          output: {
            toolCalls: [{
              id: "call-1",
              name: "request_context",
              arguments: {},
            }],
          },
        };
      },
      () => {
        transmissions += 1;
        return { output: { schemaVersion: 1, code: "export {};\n" } };
      },
    ],
  });
  await assert.rejects(
    runProviderToolLoop({
      adapter: provider,
      budget: budget(1),
      request: request(),
      validateFinal: finalCode,
      tools: [CONTEXT_REQUEST_TOOL],
      executeTool: async () => ({ ok: true }),
      maxToolCalls: 1,
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "budget",
  );
  assert.equal(transmissions, 1);
});

test("remote providers cannot receive dynamic project-context tools", async () => {
  let transmitted = false;
  const remote: ProviderAdapter = {
    name: "remote-test",
    capabilities: {
      nativeStructuredOutput: true,
      toolCalling: true,
      cancellation: true,
      tokenCounting: "estimated",
      usageReporting: true,
      remote: true,
    },
    maximumRequestCostUsd: () => 0,
    async generate() {
      transmitted = true;
      throw new Error("must not transmit");
    },
  };
  await assert.rejects(
    runProviderToolLoop({
      adapter: remote,
      request: request(),
      validateFinal: finalCode,
      tools: [CONTEXT_REQUEST_TOOL],
      executeTool: async () => ({}),
      maxToolCalls: 1,
    }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "configuration",
  );
  assert.equal(transmitted, false);
});

test("operator-excluded paths cannot become agent evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-provider-tool-policy-"));
  try {
    await put(root, "private/internal.ts", "export const SENTINEL = 'never-send';\n");
    const profile = await analyzeProject(root, { generalLanguage: "typescript" });
    const executor = new CompilerToolExecutor(root, profile, {
      excludedPaths: ["private"],
      allowedWorkspaceIds: ["general:."],
    });
    const coordinator = new AgentContextCoordinator({
      root,
      profile,
      executor,
      budget: {
        maxItems: 2,
        maxBytes: 4_096,
        maxEstimatedTokens: 1_024,
        maxBytesPerItem: 4_096,
      },
    });
    const result = await coordinator.execute({
      id: "excluded-call",
      name: "request_context",
      arguments: {
        schemaVersion: 1,
        requestId: "excluded-request",
        kind: "file",
        workspace: "general:.",
        query: "private/internal.ts",
        reason: "Try to inspect an excluded file.",
        maxItems: 1,
        path: "private/internal.ts",
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "UNAVAILABLE");
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(coordinator.manifest.evidence, []);
    assert.equal(coordinator.contextRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
