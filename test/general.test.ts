import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeProject } from "../src/analysis/analyzer.ts";
import { buildGeneralWorkspace, normalizeGeneralLanguage } from "../src/analysis/adapters/general.ts";
import { DEFAULT_CONFIG, type ConfigV1 } from "../src/config/config.ts";
import {
  hashCanonical,
  sha256Text,
  type ChangeContractV1,
  type PatchSetV1,
} from "../src/core/contracts.ts";
import type {
  ProviderAdapter,
  ProviderGenerationRequestV1,
  ProviderGenerationResultV1,
} from "../src/providers/provider.ts";
import { RunStore } from "../src/pipeline/run-store.ts";
import { generateRun } from "../src/pipeline/workflow.ts";

class GeneralMockProvider implements ProviderAdapter {
  readonly name = "general-mock";
  readonly capabilities = {
    nativeStructuredOutput: true,
    toolCalling: false,
    cancellation: true,
    tokenCounting: "exact" as const,
    usageReporting: true,
    remote: false,
  };
  readonly contract: ChangeContractV1;
  calls = 0;

  constructor(contract: ChangeContractV1) {
    this.contract = contract;
  }

  async generate(request: ProviderGenerationRequestV1): Promise<ProviderGenerationResultV1> {
    this.calls += 1;
    const prompt = request.messages.map((message) => message.content).join("\n");
    const snapshotHash = /IMMUTABLE WORKSPACE SNAPSHOT HASH:\n([a-f0-9]{64})/u.exec(prompt)?.[1];
    assert.ok(snapshotHash, "general prompt must still bind the provider to a snapshot hash");
    const output: PatchSetV1 = {
      schemaVersion: 1,
      contractHash: hashCanonical(this.contract),
      snapshotHash,
      operations: [{
        kind: "create",
        path: "health.ts",
        content: "export function health() {\n  return { status: 'ok' };\n}\n",
      }],
      requirementIds: ["REQ-1"],
      proposedTests: ["Manually review the generated health module."],
    };
    return {
      output,
      resolvedModelId: "general-mock-v1",
      requestId: `general-request-${this.calls}`,
      usage: { inputTokens: 80, outputTokens: 40 },
      finishReason: "stop",
    };
  }
}

test("normalizeGeneralLanguage produces a safe, bounded slug", () => {
  assert.equal(normalizeGeneralLanguage("TypeScript"), "typescript");
  assert.equal(normalizeGeneralLanguage("  C++  "), "c++");
  assert.equal(normalizeGeneralLanguage("!!!"), "code");
  assert.equal(normalizeGeneralLanguage("x".repeat(200)).length, 40);
});

test("buildGeneralWorkspace is preview-tier, ungrounded, and has no validation plan", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-general-ws-"));
  const profile = await analyzeProject(container, { generalLanguage: "typescript" });
  assert.equal(profile.status, "SUPPORTED");
  assert.equal(profile.workspaces.length, 1);
  const workspace = profile.workspaces[0]!;
  assert.equal(workspace.ecosystem, "general");
  assert.equal(workspace.support.tier, "preview");
  assert.equal(workspace.validationPlan.length, 0);
  assert.equal(workspace.runtime.grounded, false);
  assert.ok(workspace.diagnostics.some((d) => d.code === "GENERAL_UNGROUNDED_PREVIEW"));

  // Direct builder call is deterministic and never certified.
  const direct = buildGeneralWorkspace(
    { inventory: { root: container, files: [], directories: [], scan: profile.scan } } as never,
    "python",
  );
  assert.equal(direct.support.tier, "preview");
  assert.equal(direct.runtime.language, "python");
});

test("no language hint keeps an unrecognized project UNSUPPORTED", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-general-none-"));
  const profile = await analyzeProject(container);
  assert.equal(profile.status, "UNSUPPORTED");
  assert.equal(profile.workspaces.length, 0);
});

test("general generation yields a reviewable patch, stays INCONCLUSIVE, writes no validation plan, and leaves the tree unchanged", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-general-gen-"));
  const root = join(container, "project");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "notes.txt"), "a plain project with no framework\n");
  const requestText = "Add a health endpoint.\n";
  await writeFile(join(root, "feature.human"), requestText);

  const profile = await analyzeProject(root, { generalLanguage: "typescript" });
  assert.equal(profile.status, "SUPPORTED");
  const workspace = profile.workspaces[0]!;
  assert.equal(workspace.ecosystem, "general");

  const contract: ChangeContractV1 = {
    schemaVersion: 1,
    source: { path: "feature.human", sha256: sha256Text(requestText) },
    projectFingerprint: profile.fingerprint,
    targetWorkspaces: [workspace.id],
    targetSymbols: ["health"],
    requirements: [{ id: "REQ-1", description: "Add a health endpoint module." }],
    acceptanceCriteria: { automated: ["Manual review only."], manual: ["Review the generated code."] },
    scope: {
      allowedPaths: ["**"],
      allowedOperations: ["create", "edit"],
      prohibitedPaths: [],
    },
    prohibitedChanges: ["Do not touch credentials."],
    risks: [],
    authorizedRisks: [],
    unresolvedQuestions: [],
  };
  const config = structuredClone(DEFAULT_CONFIG) as ConfigV1;
  config.provider = { name: "ollama", model: "mock-model" };

  const provider = new GeneralMockProvider(contract);
  const store = new RunStore(join(container, "runs"));
  const generated = await generateRun({ root, profile, contract, config, provider, store });

  assert.equal(generated.status, "INCONCLUSIVE", JSON.stringify(generated));
  assert.equal(provider.calls, 1);
  assert.match(generated.diff ?? "", /health\.ts/u);

  // A patch exists but the ungrounded run never wrote a validation plan.
  const patch = await store.readArtifact<PatchSetV1>(generated.runId, "patch.json");
  assert.equal(patch.operations[0]?.kind, "create");
  await assert.rejects(store.readArtifact(generated.runId, "validation-plan.json"));

  // The working tree is untouched: generation happens against a disposable snapshot.
  const entries = (await readdir(root)).sort();
  assert.deepEqual(entries, ["feature.human", "notes.txt"]);
});
