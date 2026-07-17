import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  buildDeepAgent,
  buildDeepAgentModel,
  runDeepAgentConversion,
} from "../src/pipeline/deep-agent.ts";
import { discoverUnits } from "../src/pipeline/simple.ts";

test("buildDeepAgentModel binds providers via the OpenAI-compatible client without a network call", async () => {
  // Ollama is reached through its /v1 OpenAI-compatible endpoint so the deep
  // agent's structured tool messages serialize correctly.
  const ollama = await buildDeepAgentModel({ provider: "ollama", model: "qwen2.5-coder:32b" });
  assert.equal(ollama.constructor.name, "ChatOpenAI");
  assert.match((ollama as unknown as { clientConfig: { baseURL?: string } }).clientConfig.baseURL ?? "", /\/v1$/u);

  const openai = await buildDeepAgentModel({ provider: "openai", model: "gpt-5", apiKey: "test-key" });
  assert.equal(openai.constructor.name, "ChatOpenAI");

  await assert.rejects(
    () => buildDeepAgentModel({ provider: "anthropic", model: "claude" }),
    /no deep-agent chat-model binding/u,
  );
});

test("buildDeepAgent wires a runnable agent over the project filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-agent-build-"));
  try {
    const model = new FakeListChatModel({ responses: ["done"] });
    const agent = await buildDeepAgent({
      root,
      language: "typescript",
      provider: "ollama",
      model: "unused",
      units: [],
      model_override: model,
    });
    assert.equal(typeof agent.invoke, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDeepAgentConversion drives the agent to completion and returns its plan and summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-agent-run-"));
  try {
    await writeFile(join(root, "add.human"), "Write a function that adds two numbers.\n");
    await writeFile(join(root, "math.ts"), "// @human write a multiply function\n\nmultiply(2, 3);\n");
    const units = await discoverUnits(root, "typescript");
    assert.equal(units.length, 2);

    const model = new FakeListChatModel({ responses: ["All requested conversions are complete."] });
    const outcome = await runDeepAgentConversion({
      root,
      language: "typescript",
      provider: "ollama",
      model: "unused",
      units,
      model_override: model,
      recursionLimit: 20,
    });

    assert.ok(Array.isArray(outcome.todos));
    assert.ok(outcome.messageCount >= 1);
    assert.equal(outcome.summary, "All requested conversions are complete.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
