import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeProject, type ProjectProfileV1 } from "../src/analyzer.ts";
import { DEFAULT_CONFIG, type ConfigV1 } from "../src/config.ts";
import { CompilerToolExecutor } from "../src/compiler-tools.ts";
import {
  hashCanonical,
  sha256Text,
  type ChangeContractV1,
  type PatchSetV1,
  type RunRecordV1,
  type ValidationReportV1,
} from "../src/contracts.ts";
import { hashContextManifest, selectContext } from "../src/context.ts";
import type {
  ProviderAdapter,
  ProviderGenerationRequestV1,
  ProviderGenerationResultV1,
} from "../src/provider.ts";
import { RunStore } from "../src/run-store.ts";
import {
  applyVerifiedRun,
  buildContextPreview,
  generateRun,
  rollbackAppliedRun,
  validateStoredRun,
} from "../src/workflow.ts";

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

interface Fixture {
  container: string;
  root: string;
  profile: ProjectProfileV1;
  contract: ChangeContractV1;
  config: ConfigV1;
  store: RunStore;
}

async function fixture(remoteProviderConsent: boolean): Promise<Fixture> {
  const container = await mkdtemp(join(tmpdir(), "h2c-workflow-"));
  const root = join(container, "project");
  await mkdir(root);
  await put(root, "package.json", JSON.stringify({
    name: "workflow-fixture",
    dependencies: { react: "18.3.1", vite: "6.1.0" },
    devDependencies: { typescript: "5.7.3", vitest: "2.1.8" },
    scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
  }));
  await put(root, "src/main.tsx", "export function App() { return null; }\n");
  await put(root, "src/value.ts", "export const value = 1;\n");
  const requestText = "Create a small generated status module.\n";
  await put(root, "change.human", requestText);

  const profile = await analyzeProject(root);
  assert.equal(profile.status, "SUPPORTED", JSON.stringify(profile.diagnostics));
  assert.equal(profile.workspaces.length, 1);
  const contract: ChangeContractV1 = {
    schemaVersion: 1,
    source: { path: "change.human", sha256: sha256Text(requestText) },
    projectFingerprint: profile.fingerprint,
    targetWorkspaces: [profile.workspaces[0]!.id],
    targetSymbols: ["status"],
    requirements: [{ id: "REQ-1", description: "Create a generated status module." }],
    acceptanceCriteria: { automated: ["The configured project checks pass."], manual: [] },
    scope: {
      allowedPaths: ["src/**"],
      allowedOperations: ["create", "edit"],
      prohibitedPaths: ["src/generated/**"],
    },
    prohibitedChanges: ["Do not change validation configuration."],
    risks: [],
    authorizedRisks: [],
    unresolvedQuestions: [],
  };
  const config = structuredClone(DEFAULT_CONFIG) as ConfigV1;
  config.provider = { name: remoteProviderConsent ? "openai" : "ollama", model: "mock-model" };
  config.privacy.remoteProviderConsent = remoteProviderConsent;
  return {
    container,
    root,
    profile,
    contract,
    config,
    store: new RunStore(join(container, "runs")),
  };
}

class DeterministicPatchProvider implements ProviderAdapter {
  readonly name = "deterministic-mock";
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
    assert.ok(snapshotHash, "workflow prompt must bind the provider to a snapshot hash");
    const output: PatchSetV1 = {
      schemaVersion: 1,
      contractHash: hashCanonical(this.contract),
      snapshotHash,
      operations: [{
        kind: "create",
        path: "src/status.ts",
        content: "export const status = 'ok';\n",
      }],
      requirementIds: ["REQ-1"],
      proposedTests: ["Run the configured focused tests."],
    };
    return {
      output,
      resolvedModelId: "deterministic-mock-v1",
      requestId: `mock-request-${this.calls}`,
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "stop",
    };
  }
}

class DeterministicRepairProvider implements ProviderAdapter {
  readonly name = "deterministic-repair";
  readonly capabilities = {
    nativeStructuredOutput: true,
    toolCalling: false,
    cancellation: true,
    tokenCounting: "exact" as const,
    usageReporting: true,
    remote: false,
  };
  readonly contract: ChangeContractV1;
  readonly expandOnRepair: boolean;
  readonly operations: string[] = [];
  calls = 0;

  constructor(contract: ChangeContractV1, expandOnRepair = false) {
    this.contract = contract;
    this.expandOnRepair = expandOnRepair;
  }

  async generate(request: ProviderGenerationRequestV1): Promise<ProviderGenerationResultV1> {
    this.calls += 1;
    this.operations.push(request.operation);
    const prompt = request.messages.map((message) => message.content).join("\n");
    const snapshotHash = /(?:IMMUTABLE WORKSPACE SNAPSHOT HASH:\n|IMMUTABLE SNAPSHOT HASH: )([a-f0-9]{64})/u.exec(prompt)?.[1];
    assert.ok(snapshotHash, "every generation/repair request must bind the same snapshot hash");
    if (request.operation === "repair") {
      assert.match(prompt, /IMMUTABLE CONTRACT HASH: [a-f0-9]{64}/u);
      assert.match(prompt, /IMMUTABLE VALIDATION PLAN HASH: [a-f0-9]{64}/u);
      assert.match(prompt, /candidate introduced or retained|required command|generated status/iu);
    }
    const content = this.calls === 1
      ? "export const status: number = 'broken-zero';\n"
      : this.calls === 2
        ? "export const status: number = 'broken-one';\n"
        : "export const status: string = 'fixed';\n";
    const operations: PatchSetV1["operations"] = [
      { kind: "create", path: "src/status.ts", content },
    ];
    if (this.expandOnRepair && request.operation === "repair") {
      operations.push({ kind: "create", path: "src/extra.ts", content: "export const extra = true;\n" });
    }
    const output: PatchSetV1 = {
      schemaVersion: 1,
      contractHash: hashCanonical(this.contract),
      snapshotHash,
      operations,
      requirementIds: ["REQ-1"],
      proposedTests: ["Run the configured focused tests."],
    };
    return {
      output,
      resolvedModelId: "deterministic-repair-v1",
      requestId: `repair-request-${this.calls}`,
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "stop",
    };
  }
}

interface AppliedFixture extends Fixture {
  runId: string;
  patch: PatchSetV1;
}

async function appliedFixture(): Promise<AppliedFixture> {
  const item = await fixture(true);
  execFileSync("git", ["init", "--quiet"], { cwd: item.root, stdio: "ignore" });
  await put(item.root, "src/delete.ts", "export const removeMe = true;\n");
  await put(item.root, "src/from.ts", "export const renamed = true;\n");
  await chmod(join(item.root, "src/value.ts"), 0o640);
  await chmod(join(item.root, "src/delete.ts"), 0o600);
  await chmod(join(item.root, "src/from.ts"), 0o700);

  const contract: ChangeContractV1 = {
    ...item.contract,
    scope: {
      allowedPaths: ["src/**"],
      allowedOperations: ["create", "edit", "delete", "rename"],
      prohibitedPaths: [],
    },
    risks: [{ category: "public_api_break", reason: "The reviewed fixture covers delete and rename rollback." }],
    authorizedRisks: ["public_api_break"],
  };
  const valueBefore = "export const value = 1;\n";
  const deletedBefore = "export const removeMe = true;\n";
  const renamedBefore = "export const renamed = true;\n";
  const patch: PatchSetV1 = {
    schemaVersion: 1,
    contractHash: hashCanonical(contract),
    snapshotHash: sha256Text("apply-snapshot"),
    operations: [
      {
        kind: "edit",
        path: "src/value.ts",
        baseHash: sha256Text(valueBefore),
        oldText: "value = 1",
        newText: "value = 2",
      },
      { kind: "create", path: "src/status.ts", content: "export const status = 'applied';\n" },
      { kind: "delete", path: "src/delete.ts", baseHash: sha256Text(deletedBefore) },
      { kind: "rename", from: "src/from.ts", path: "src/to.ts", baseHash: sha256Text(renamedBefore) },
    ],
    requirementIds: ["REQ-1"],
    proposedTests: ["Verify apply and rollback."],
  };
  const context = await selectContext({
    root: item.root,
    projectFingerprint: item.profile.fingerprint,
    candidates: [{ origin: "project", path: "change.human", reason: "Reviewed change source.", required: true }],
  });
  const timestamp = "2026-07-15T00:00:00.000Z";
  const validationReport: ValidationReportV1 = {
    schemaVersion: 1,
    status: "validated",
    sandbox: "strong",
    baseline: [{
      id: "fixture-check", status: "passed", exitCode: 0, signal: null, durationMs: 1,
      stdout: "", stderr: "", timedOut: false, flaky: false, outputTruncated: false,
      startedAt: timestamp, finishedAt: timestamp,
    }],
    candidate: [{
      id: "fixture-check", status: "passed", exitCode: 0, signal: null, durationMs: 1,
      stdout: "", stderr: "", timedOut: false, flaky: false, outputTruncated: false,
      startedAt: timestamp, finishedAt: timestamp,
    }],
    repairs: [],
    manualChecks: [],
    diagnostics: [],
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  const runId = "verified-apply";
  const record: RunRecordV1 = {
    runId,
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    root: item.root,
    status: "VERIFIED",
    contractHash: hashCanonical(contract),
    contextManifestHash: hashContextManifest(context),
    patchHash: hashCanonical(patch),
    validationReportHash: hashCanonical(validationReport),
    diagnostics: [],
  };
  await item.store.create(record);
  await Promise.all([
    item.store.writeArtifact(runId, "contract.json", contract),
    item.store.writeArtifact(runId, "context.json", context),
    item.store.writeArtifact(runId, "patch.json", patch),
    item.store.writeArtifact(runId, "validation-report.json", validationReport),
    item.store.writeArtifact(runId, "certification.json", {
      schemaVersion: 1,
      supportMatrixVersion: "1.0.0",
      provider: { matrixKey: "test.certified", certified: true, reason: "Synthetic apply mechanics fixture." },
      profileCertified: true,
      certified: true,
      reasons: [],
    }),
  ]);
  const applied = await applyVerifiedRun(runId, item.store);
  assert.equal(applied.status, "VERIFIED", JSON.stringify(applied));
  return { ...item, contract, runId, patch };
}

test("remote generation stops at the outbound preview without explicit consent", async () => {
  const item = await fixture(false);
  let calls = 0;
  const remote: ProviderAdapter = {
    name: "remote-mock",
    capabilities: {
      nativeStructuredOutput: true,
      toolCalling: false,
      cancellation: true,
      tokenCounting: "exact",
      usageReporting: true,
      remote: true,
    },
    async generate(): Promise<ProviderGenerationResultV1> {
      calls += 1;
      throw new Error("remote provider must not be called");
    },
  };
  try {
    const outcome = await generateRun({
      root: item.root,
      profile: item.profile,
      contract: item.contract,
      config: item.config,
      provider: remote,
      store: item.store,
    });
    assert.equal(outcome.status, "NEEDS_INPUT", JSON.stringify(outcome));
    assert.equal(calls, 0);
    assert.match(outcome.diagnostics.join("\n"), /remote provider consent is false/u);
    assert.ok((await item.store.readArtifact(outcome.runId, "context.json")));
    await assert.rejects(access(join(item.root, "src/status.ts")));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("context preview preloads installed declarations for referenced APIs", async () => {
  const item = await fixture(false);
  try {
    await put(item.root, "node_modules/react/package.json", JSON.stringify({
      name: "react",
      version: "18.3.1",
      types: "index.d.ts",
    }));
    await put(item.root, "node_modules/react/index.d.ts", "export function useState<T>(initial: T): [T, (value: T) => void];\n");
    const direct = await new CompilerToolExecutor(item.root, item.profile).execute({
      schemaVersion: 1,
      requestId: "direct-react",
      kind: "dependency-doc",
      workspace: item.profile.workspaces[0]!.id,
      query: "react",
      reason: "Test installed declaration discovery.",
      maxItems: 4,
      path: null,
    });
    assert.ok(direct.some((candidate) => candidate.origin === "dependency"
      && "path" in candidate && candidate.path === "node_modules/react/index.d.ts"), JSON.stringify({
        dependencies: item.profile.workspaces[0]!.framework.dependencies,
        direct,
      }, null, 2));
    const manifest = await buildContextPreview(item.root, item.profile, item.contract, item.config, true);
    assert.ok(manifest.evidence.some((evidence) => evidence.origin === "dependency"
      && "path" in evidence && evidence.path === "node_modules/react/index.d.ts"), JSON.stringify(manifest, null, 2));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("mock generation produces a patch, unavailable Docker stays INCONCLUSIVE, and the working tree is unchanged", async () => {
  const item = await fixture(true);
  // Local providers do not require outbound consent; keep the fixture's value explicit.
  item.config.provider = { name: "ollama", model: "mock-model" };
  const provider = new DeterministicPatchProvider(item.contract);
  try {
    const generated = await generateRun({
      root: item.root,
      profile: item.profile,
      contract: item.contract,
      config: item.config,
      provider,
      store: item.store,
    });
    assert.equal(generated.status, "INCONCLUSIVE", JSON.stringify(generated));
    assert.equal(provider.calls, 1);
    assert.match(generated.diff ?? "", /src\/status\.ts/u);
    const persisted = await item.store.readArtifact<PatchSetV1>(generated.runId, "patch.json");
    assert.equal(persisted.operations[0]?.kind, "create");

    const validated = await validateStoredRun({
      runId: generated.runId,
      store: item.store,
      dockerBinary: join(item.container, "missing-docker"),
      provider,
      config: item.config,
    });
    assert.equal(validated.status, "INCONCLUSIVE");
    assert.equal(validated.report?.status, "unvalidated");
    assert.equal(validated.report?.sandbox, "none");
    assert.match(validated.diagnostics.join("\n"), /strong Docker sandbox is unavailable/u);
    assert.equal(provider.calls, 1, "infrastructure-unavailable validation must not trigger a repair");

    assert.equal(await readFile(join(item.root, "src/value.ts"), "utf8"), "export const value = 1;\n");
    await assert.rejects(access(join(item.root, "src/status.ts")));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("guided validation performs at most two immutable diagnostic repairs on fresh candidates", async () => {
  const item = await fixture(true);
  item.config.provider = { name: "ollama", model: "mock-model" };
  const provider = new DeterministicRepairProvider(item.contract);
  const candidateRoots = new Set<string>();
  const baselineRoots = new Set<string>();
  try {
    const generated = await generateRun({
      root: item.root,
      profile: item.profile,
      contract: item.contract,
      config: item.config,
      provider,
      store: item.store,
    });
    assert.equal(generated.status, "INCONCLUSIVE", JSON.stringify(generated));

    const validated = await validateStoredRun({
      runId: generated.runId,
      store: item.store,
      provider,
      config: item.config,
      dockerBinary: "deterministic-test-sandbox",
      validationRunner: async (plan, options) => {
        candidateRoots.add(options.candidateRoot);
        baselineRoots.add(options.baselineRoot);
        const content = await readFile(join(options.candidateRoot, "src/status.ts"), "utf8");
        const fixed = content === "export const status: string = 'fixed';\n";
        const timestamp = new Date().toISOString();
        const requiredFailure = plan.commands.find((command) => command.required)?.id;
        const result = (id: string, passed: boolean) => ({
          id,
          status: passed ? "passed" as const : "failed" as const,
          exitCode: passed ? 0 : 1,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: passed ? "" : "Type error in generated status module.",
          timedOut: false,
          flaky: false,
          outputTruncated: false,
          startedAt: timestamp,
          finishedAt: timestamp,
        });
        return {
          schemaVersion: 1,
          status: fixed ? "validated" as const : "failed" as const,
          sandbox: "strong" as const,
          baseline: plan.commands.map((command) => result(command.id, true)),
          candidate: plan.commands.map((command) => result(
            command.id,
            fixed || command.id !== requiredFailure,
          )),
          repairs: [],
          manualChecks: [],
          diagnostics: fixed
            ? []
            : ["The candidate introduced or retained a required command failure in generated status."],
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    });

    assert.equal(validated.report?.status, "validated", JSON.stringify(validated));
    assert.equal(validated.report?.repairs.length, 2);
    assert.deepEqual(provider.operations, ["patch", "repair", "repair"]);
    assert.equal(provider.calls, 3, "initial generation plus the hard maximum of two repairs");
    assert.equal(candidateRoots.size, 3, "every attempt validates a fresh candidate snapshot");
    assert.equal(baselineRoots.size, 3, "every attempt receives a disposable clean baseline");

    const finalPatch = await item.store.readArtifact<PatchSetV1>(generated.runId, "patch.json");
    assert.equal(finalPatch.operations[0]?.kind, "create");
    assert.match(finalPatch.operations[0]?.kind === "create" ? finalPatch.operations[0].content : "", /'fixed'/u);
    assert.ok(await item.store.readArtifact(generated.runId, "patch-repair-1.json"));
    assert.ok(await item.store.readArtifact(generated.runId, "patch-repair-2.json"));
    assert.ok(await item.store.readArtifact(generated.runId, "validation-report-attempt-0.json"));
    assert.ok(await item.store.readArtifact(generated.runId, "validation-report-attempt-2.json"));
    const provenance = await item.store.readArtifact<{
      attempts: unknown[];
      results: Array<{ status: string }>;
      usage: { repairs: number; requests: number };
    }>(generated.runId, "repair-provenance.json");
    assert.equal(provenance.attempts.length, 2);
    assert.deepEqual(provenance.results.map((result) => result.status), ["failed", "validated"]);
    assert.equal(provenance.usage.repairs, 2);
    assert.equal(provenance.usage.requests, 3);
    const record = await item.store.read(generated.runId);
    assert.deepEqual(record.provider?.requestIds, [
      "repair-request-1",
      "repair-request-2",
      "repair-request-3",
    ]);
    assert.equal(record.provider?.resolvedModel, "deterministic-repair-v1");
    assert.equal(record.usage?.requests, 3);
    assert.equal(record.usage?.repairs, 2);

    const callsBeforeResume = provider.calls;
    const exhausted = await validateStoredRun({
      runId: generated.runId,
      store: item.store,
      provider,
      config: item.config,
      dockerBinary: "deterministic-test-sandbox",
      validationRunner: async (plan) => {
        const timestamp = new Date().toISOString();
        const failedId = plan.commands.find((command) => command.required)?.id;
        const result = (id: string, baseline: boolean) => ({
          id,
          status: baseline || id !== failedId ? "passed" as const : "failed" as const,
          exitCode: baseline || id !== failedId ? 0 : 1,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: baseline || id !== failedId ? "" : "Persistent candidate failure.",
          timedOut: false,
          flaky: false,
          outputTruncated: false,
          startedAt: timestamp,
          finishedAt: timestamp,
        });
        return {
          schemaVersion: 1,
          status: "failed" as const,
          sandbox: "strong" as const,
          baseline: plan.commands.map((command) => result(command.id, true)),
          candidate: plan.commands.map((command) => result(command.id, false)),
          repairs: [],
          manualChecks: [],
          diagnostics: ["The candidate still fails after resume."],
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    });
    assert.equal(provider.calls, callsBeforeResume, "repair budget is cumulative across resumed validation");
    assert.equal(exhausted.report?.repairs.length, 2);
    await assert.rejects(access(join(item.root, "src/status.ts")));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("baseline-unhealthy validation never invokes the repair provider", async () => {
  const item = await fixture(true);
  item.config.provider = { name: "ollama", model: "mock-model" };
  const provider = new DeterministicPatchProvider(item.contract);
  try {
    const generated = await generateRun({
      root: item.root,
      profile: item.profile,
      contract: item.contract,
      config: item.config,
      provider,
      store: item.store,
    });
    const validated = await validateStoredRun({
      runId: generated.runId,
      store: item.store,
      provider,
      config: item.config,
      dockerBinary: "deterministic-test-sandbox",
      validationRunner: async (plan) => {
        const timestamp = new Date().toISOString();
        const failedId = plan.commands.find((command) => command.required)?.id;
        const result = (id: string) => ({
          id,
          status: id === failedId ? "failed" as const : "passed" as const,
          exitCode: id === failedId ? 1 : 0,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: id === failedId ? "Existing baseline failure." : "",
          timedOut: false,
          flaky: false,
          outputTruncated: false,
          startedAt: timestamp,
          finishedAt: timestamp,
        });
        return {
          schemaVersion: 1,
          status: "non_regression_only" as const,
          sandbox: "strong" as const,
          baseline: plan.commands.map((command) => result(command.id)),
          candidate: plan.commands.map((command) => result(command.id)),
          repairs: [],
          manualChecks: [],
          diagnostics: ["Required failures existed in the baseline and remain."],
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    });
    assert.equal(validated.status, "INCONCLUSIVE");
    assert.equal(validated.report?.status, "non_regression_only");
    assert.equal(validated.report?.repairs.length, 0);
    assert.equal(provider.calls, 1, "baseline failures cannot be presented to the model as repairable regressions");
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("repair scope expansion is rejected before a second candidate executes", async () => {
  const item = await fixture(true);
  item.config.provider = { name: "ollama", model: "mock-model" };
  const provider = new DeterministicRepairProvider(item.contract, true);
  let validations = 0;
  try {
    const generated = await generateRun({
      root: item.root,
      profile: item.profile,
      contract: item.contract,
      config: item.config,
      provider,
      store: item.store,
    });
    const validated = await validateStoredRun({
      runId: generated.runId,
      store: item.store,
      provider,
      config: item.config,
      dockerBinary: "deterministic-test-sandbox",
      validationRunner: async (plan) => {
        validations += 1;
        const timestamp = new Date().toISOString();
        const failedId = plan.commands.find((command) => command.required)?.id;
        const result = (id: string, passed: boolean) => ({
          id,
          status: passed ? "passed" as const : "failed" as const,
          exitCode: passed ? 0 : 1,
          signal: null,
          durationMs: 1,
          stdout: "",
          stderr: passed ? "" : "Generated status does not typecheck.",
          timedOut: false,
          flaky: false,
          outputTruncated: false,
          startedAt: timestamp,
          finishedAt: timestamp,
        });
        return {
          schemaVersion: 1,
          status: "failed" as const,
          sandbox: "strong" as const,
          baseline: plan.commands.map((command) => result(command.id, true)),
          candidate: plan.commands.map((command) => result(command.id, command.id !== failedId)),
          repairs: [],
          manualChecks: [],
          diagnostics: ["The candidate introduced a required command failure in generated status."],
          startedAt: timestamp,
          finishedAt: timestamp,
        };
      },
    });
    assert.equal(validated.status, "SECURITY_BLOCKED", JSON.stringify(validated));
    assert.match(validated.diagnostics.join("\n"), /add, remove, rename, or change the kind/u);
    assert.equal(validations, 1, "an expanded repair must be rejected before execution");
    assert.equal(provider.calls, 2, "one generation and one rejected repair request");
    assert.equal(validated.report?.repairs.length, 1);
    assert.equal(validated.report?.repairs[0]?.patchHash, undefined);
    const finalPatch = await item.store.readArtifact<PatchSetV1>(generated.runId, "patch.json");
    assert.deepEqual(finalPatch.operations.map((operation) => operation.path), ["src/status.ts"]);
    await assert.rejects(item.store.readArtifact(generated.runId, "patch-repair-1.json"));
    await assert.rejects(access(join(item.root, "src/status.ts")));
    await assert.rejects(access(join(item.root, "src/extra.ts")));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("verified apply records rollback provenance and rollback restores every operation and file mode", async () => {
  const item = await appliedFixture();
  try {
    assert.equal(await readFile(join(item.root, "src/value.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(join(item.root, "src/status.ts"), "utf8"), "export const status = 'applied';\n");
    await assert.rejects(access(join(item.root, "src/delete.ts")));
    assert.equal(await readFile(join(item.root, "src/to.ts"), "utf8"), "export const renamed = true;\n");

    const artifact = await item.store.readArtifact<{
      patchHash: string;
      entries: Array<{ kind: string; path: string; afterHash: string | null }>;
    }>(item.runId, "rollback.json");
    assert.equal(artifact.patchHash, hashCanonical(item.patch));
    assert.deepEqual(artifact.entries.map((entry) => entry.kind), ["edited", "created", "deleted", "renamed"]);
    assert.ok(artifact.entries.every((entry) => entry.kind === "deleted" || entry.afterHash?.length === 64));

    const rolledBack = await rollbackAppliedRun(item.runId, item.store);
    assert.equal(rolledBack.status, "VERIFIED", JSON.stringify(rolledBack));
    assert.equal(await readFile(join(item.root, "src/value.ts"), "utf8"), "export const value = 1;\n");
    assert.equal(await readFile(join(item.root, "src/delete.ts"), "utf8"), "export const removeMe = true;\n");
    assert.equal(await readFile(join(item.root, "src/from.ts"), "utf8"), "export const renamed = true;\n");
    await assert.rejects(access(join(item.root, "src/status.ts")));
    await assert.rejects(access(join(item.root, "src/to.ts")));
    assert.equal((await stat(join(item.root, "src/value.ts"))).mode & 0o777, 0o640);
    assert.equal((await stat(join(item.root, "src/delete.ts"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(item.root, "src/from.ts"))).mode & 0o777, 0o700);
    assert.ok(await item.store.readArtifact(item.runId, "rollback-result.json"));
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("rollback refuses post-apply drift before restoring any operation", async () => {
  const item = await appliedFixture();
  try {
    await put(item.root, "src/status.ts", "export const status = 'operator-edited';\n");
    const outcome = await rollbackAppliedRun(item.runId, item.store);
    assert.equal(outcome.status, "INCONCLUSIVE");
    assert.match(outcome.diagnostics.join("\n"), /base hash does not match/u);

    // preparePatch validates the entire inverse before its first write.
    assert.equal(await readFile(join(item.root, "src/value.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(join(item.root, "src/status.ts"), "utf8"), "export const status = 'operator-edited';\n");
    await assert.rejects(access(join(item.root, "src/delete.ts")));
    assert.equal(await readFile(join(item.root, "src/to.ts"), "utf8"), "export const renamed = true;\n");
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});

test("rollback rejects a tampered out-of-root artifact before reading or mutating files", async () => {
  const item = await appliedFixture();
  try {
    const artifact = await item.store.readArtifact<Record<string, unknown>>(item.runId, "rollback.json");
    const entries = artifact.entries as Array<Record<string, unknown>>;
    entries[0] = { ...entries[0], path: "../../outside.txt" };
    await item.store.writeArtifact(item.runId, "rollback.json", artifact);

    const outcome = await rollbackAppliedRun(item.runId, item.store);
    assert.equal(outcome.status, "INCONCLUSIVE");
    assert.match(outcome.diagnostics.join("\n"), /escapes the root|canonical confined path/u);
    assert.equal(await readFile(join(item.root, "src/value.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(join(item.root, "src/status.ts"), "utf8"), "export const status = 'applied';\n");
  } finally {
    await rm(item.container, { recursive: true, force: true });
  }
});
