import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactValidationError,
  sha256Text,
  validateChangeContractV1,
} from "../src/core/contracts.ts";
import {
  DeterministicMockProvider,
  ProviderBudgetTracker,
  ProviderError,
  CONTEXT_REQUEST_TOOL,
  generateValidated,
  withProviderRetries,
  type JsonSchemaV1,
  type ProviderAdapter,
  type ProviderGenerationRequestV1,
} from "../src/providers/provider.ts";
import { COMPILER_SKILLS } from "../src/context/compiler-skills.ts";

const schema: JsonSchemaV1 = {
  type: "object",
  additionalProperties: false,
};

function request(): ProviderGenerationRequestV1 {
  return {
    operation: "contract",
    model: "mock-alias",
    messages: [{ role: "system", content: "Return the reviewed contract." }],
    responseSchema: schema,
    timeoutMs: 1_000,
    maxOutputTokens: 2_000,
  };
}

function rawContract(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: { path: "feature.human", sha256: sha256Text("feature") },
    projectFingerprint: sha256Text("project"),
    targetWorkspaces: ["apps/web"],
    targetSymbols: [],
    requirements: [{ id: "REQ-1", description: "Do the work." }],
    acceptanceCriteria: { automated: ["Tests pass."], manual: [] },
    scope: { allowedPaths: ["src/**"], allowedOperations: ["edit"], prohibitedPaths: [] },
    prohibitedChanges: [],
    risks: [],
    authorizedRisks: [],
    unresolvedQuestions: [],
  };
}

test("generateValidated enforces local schema even without native structured output", async () => {
  const provider = new DeterministicMockProvider({
    nativeStructuredOutput: false,
    resolvedModelId: "mock-exact-2026-07-15",
    steps: [{ output: rawContract() }],
  });
  const generated = await generateValidated(provider, request(), validateChangeContractV1);
  assert.equal(generated.value.schemaVersion, 1);
  assert.equal(generated.result.resolvedModelId, "mock-exact-2026-07-15");
  assert.equal(provider.capabilities.nativeStructuredOutput, false);
});

test("generateValidated rejects malformed provider output and truncation", async () => {
  const malformed = new DeterministicMockProvider({ steps: [{ output: { schemaVersion: 1, injected: true } }] });
  await assert.rejects(
    () => generateValidated(malformed, request(), validateChangeContractV1),
    (error: unknown) => error instanceof ProviderError && error.code === "schema" && error.cause instanceof ArtifactValidationError,
  );
  const truncated = new DeterministicMockProvider({ steps: [{ output: rawContract(), finishReason: "length" }] });
  await assert.rejects(
    () => generateValidated(truncated, request(), validateChangeContractV1),
    (error: unknown) => error instanceof ProviderError && error.code === "budget",
  );
});

test("provider failures and rejected outputs still consume the request/usage budget", async () => {
  const limits = {
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxRequests: 2,
    maxRepairs: 0,
    maxCostUsd: 1,
    maxElapsedMs: 10_000,
  } as const;
  const tracker = new ProviderBudgetTracker(limits);
  const failed = new DeterministicMockProvider({ steps: [new ProviderError("server", "down")] });
  await assert.rejects(() => generateValidated(failed, request(), validateChangeContractV1, { budget: tracker }), ProviderError);
  assert.equal(tracker.usage.requests, 1);

  const truncated = new DeterministicMockProvider({
    steps: [{ output: rawContract(), finishReason: "length", usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.1 } }],
  });
  await assert.rejects(() => generateValidated(truncated, request(), validateChangeContractV1, { budget: tracker }), ProviderError);
  assert.equal(tracker.usage.requests, 2);
  assert.equal(tracker.usage.outputTokens, 2_020);
  assert.throws(() => tracker.assertCanRequest(1, 1), ProviderError);
});

test("compiler context tool schema is deeply immutable", () => {
  assert.equal(Object.isFrozen(CONTEXT_REQUEST_TOOL), true);
  assert.equal(Object.isFrozen(CONTEXT_REQUEST_TOOL.inputSchema), true);
  assert.equal(Object.isFrozen(CONTEXT_REQUEST_TOOL.inputSchema.properties), true);
});

test("compiler skill policies are deeply immutable", () => {
  assert.equal(Object.isFrozen(COMPILER_SKILLS), true);
  assert.ok(COMPILER_SKILLS.every((skill) => Object.isFrozen(skill)));
  assert.ok(COMPILER_SKILLS.every((skill) => Object.isFrozen(skill.instructions)));
  assert.throws(() => {
    (COMPILER_SKILLS[0]!.instructions as string[]).push("weaken policy");
  }, TypeError);
});

test("provider boundary blocks credential-bearing input and output", async () => {
  const inputProvider = new DeterministicMockProvider({ steps: [{ output: rawContract() }] });
  await assert.rejects(() => generateValidated(inputProvider, {
    ...request(),
    messages: [{ role: "user", content: "api_key = hardcoded-secret-value-123" }],
  }, validateChangeContractV1), (error: unknown) => error instanceof ProviderError && error.code === "safety");

  const output = rawContract();
  output.requirements = [{ id: "REQ-1", description: "Use sk-abcdefghijklmnopqrstuvwx directly" }];
  const outputProvider = new DeterministicMockProvider({ steps: [{ output }] });
  await assert.rejects(() => generateValidated(outputProvider, request(), validateChangeContractV1),
    (error: unknown) => error instanceof ProviderError && error.code === "safety");
});

test("withProviderRetries retries only transient errors and at most twice", async () => {
  let attempts = 0;
  const result = await withProviderRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw new ProviderError("server", "temporary");
    return "ok";
  }, { maxElapsedMs: 10_000, backoffMs: () => 0 });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(() => withProviderRetries(async () => {
    attempts += 1;
    throw new ProviderError("authentication", "bad key");
  }, { maxElapsedMs: 10_000, backoffMs: () => 0 }), (error: unknown) => error instanceof ProviderError && !error.retryable);
  assert.equal(attempts, 1);
});

test("ProviderBudgetTracker enforces cumulative usage and two-repair ceiling", () => {
  const tracker = new ProviderBudgetTracker({
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxRequests: 2,
    maxRepairs: 2,
    maxCostUsd: 1,
    maxElapsedMs: 10_000,
  });
  tracker.assertCanRequest(20, 20);
  tracker.recordUsage({ inputTokens: 20, outputTokens: 10, costUsd: 0.2 });
  tracker.recordRepair();
  tracker.recordRepair();
  assert.throws(() => tracker.recordRepair(), (error: unknown) => error instanceof ProviderError && error.code === "budget");
  tracker.recordUsage({ inputTokens: 20, outputTokens: 10, costUsd: 0.2 });
  assert.throws(() => tracker.assertCanRequest(1, 1), (error: unknown) => error instanceof ProviderError && error.code === "budget");
  assert.deepEqual(tracker.usage.requests, 2);
});

test("multi-request generation caps later output to the remaining cumulative budget", async () => {
  const tracker = new ProviderBudgetTracker({
    maxInputTokens: 10_000,
    maxOutputTokens: 50,
    maxRequests: 3,
    maxRepairs: 0,
    maxCostUsd: 1,
    maxElapsedMs: 10_000,
  });
  const provider = new DeterministicMockProvider({
    steps: [
      { output: rawContract(), usage: { inputTokens: 5, outputTokens: 10 } },
      (next) => {
        assert.equal(next.maxOutputTokens, 40);
        return { output: rawContract(), usage: { inputTokens: 5, outputTokens: 10 } };
      },
    ],
  });
  const highLimit = { ...request(), maxOutputTokens: 50 };
  await generateValidated(provider, highLimit, validateChangeContractV1, { budget: tracker });
  await generateValidated(provider, highLimit, validateChangeContractV1, { budget: tracker });
  assert.equal(tracker.usage.outputTokens, 20);
  assert.equal(tracker.remainingOutputTokens, 30);
});

test("remote generation is blocked before transmission without conservative cost accounting", async () => {
  let called = false;
  const provider: ProviderAdapter = {
    name: "remote-without-cost-policy",
    capabilities: {
      nativeStructuredOutput: false,
      toolCalling: false,
      cancellation: true,
      tokenCounting: "estimated",
      usageReporting: true,
      remote: true,
    },
    async generate() {
      called = true;
      throw new Error("must not be reached");
    },
  };
  const tracker = new ProviderBudgetTracker({
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxRequests: 2,
    maxRepairs: 0,
    maxCostUsd: 1,
    maxElapsedMs: 10_000,
  });
  await assert.rejects(
    generateValidated(provider, request(), validateChangeContractV1, { budget: tracker }),
    (error: unknown) => error instanceof ProviderError && error.code === "configuration",
  );
  assert.equal(called, false);
  assert.equal(tracker.usage.requests, 0);
});

test("failed remote requests consume their full preflight cost reservation", async () => {
  let calls = 0;
  const provider: ProviderAdapter = {
    name: "bounded-remote",
    capabilities: {
      nativeStructuredOutput: false,
      toolCalling: false,
      cancellation: true,
      tokenCounting: "estimated",
      usageReporting: true,
      remote: true,
    },
    maximumRequestCostUsd: () => 0.75,
    async generate() {
      calls += 1;
      throw new ProviderError("server", "uncertain remote failure");
    },
  };
  const tracker = new ProviderBudgetTracker({
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxRequests: 3,
    maxRepairs: 0,
    maxCostUsd: 1,
    maxElapsedMs: 10_000,
  });
  await assert.rejects(
    generateValidated(provider, request(), validateChangeContractV1, { budget: tracker }),
    ProviderError,
  );
  assert.equal(tracker.usage.costUsd, 0.75);
  assert.equal(tracker.usage.requests, 1);
  await assert.rejects(
    generateValidated(provider, request(), validateChangeContractV1, { budget: tracker }),
    (error: unknown) => error instanceof ProviderError && error.code === "budget",
  );
  assert.equal(calls, 1);
  assert.equal(tracker.usage.requests, 1);
});
