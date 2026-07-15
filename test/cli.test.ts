import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  hashCanonical,
  sha256Text,
  type ChangeContractV1,
  type PatchSetV1,
  type RunRecordV1,
} from "../src/contracts.ts";
import { RunStore } from "../src/run-store.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function cli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dirname(CLI),
      env: { ...process.env, ...extraEnv, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("guided subcommand creates a review draft and exits NEEDS_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-guided-"));
  try {
    await put(root, "package.json", JSON.stringify({
      name: "cli-fixture",
      dependencies: { react: "18.3.1", vite: "6.1.0" },
      scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
    }));
    await put(root, "src/main.tsx", "export function App() { return null; }\n");
    await put(root, "feature.human", "Add a status component.\n");

    const result = await cli(["guided", root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout) as { status: string; contract: string; draft: { unresolvedQuestions: unknown[] } };
    assert.equal(value.status, "NEEDS_INPUT");
    assert.equal(value.contract, join(root, "feature.strict.human.json"));
    assert.equal(value.draft.unresolvedQuestions.length, 1);
    await access(value.contract);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default convert flow lists .human files and @human markers without contacting a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-convert-"));
  try {
    await put(root, "add.human", "Write a function that adds two numbers.\n");
    await put(root, "math.ts", "// @human Write a function that multiplies two numbers.\n\nmultiply(1, 2);\n");

    const result = await cli([root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout) as {
      status: string; language: string; provider: string; requests: number;
      units: Array<{ kind: string; source: string; output: string }>;
    };
    assert.equal(plan.status, "NEEDS_CONFIRMATION");
    assert.equal(plan.language, "typescript");
    assert.equal(plan.provider, "ollama");
    assert.equal(plan.requests, 2);
    assert.deepEqual(plan.units, [
      { kind: "file", source: "add.human", output: "add.ts" },
      { kind: "inline", source: "math.ts", output: "math.ts" },
    ]);
    // No confirmation was given, so nothing is written and no provider is called.
    await assert.rejects(access(join(root, "add.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI preserves distinct partial-scan and unsupported exit codes", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-cli-exits-"));
  try {
    const partial = await cli(["analyze", join(container, "missing"), "--json"]);
    assert.equal(partial.code, 6, partial.stderr || partial.stdout);
    assert.equal((JSON.parse(partial.stdout) as { status: string }).status, "PARTIAL_SCAN");

    const unsupportedRoot = join(container, "unsupported");
    await mkdir(unsupportedRoot);
    await put(unsupportedRoot, "package.json", JSON.stringify({
      dependencies: { react: "17.0.2", vite: "6.1.0" },
      scripts: { build: "vite build" },
    }));
    await put(unsupportedRoot, "src/main.tsx", "export function App() { return null; }\n");
    const unsupported = await cli(["analyze", unsupportedRoot, "--json"]);
    assert.equal(unsupported.code, 3, unsupported.stderr || unsupported.stdout);
    assert.equal((JSON.parse(unsupported.stdout) as { status: string }).status, "UNSUPPORTED");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("CLI rollback restores an applied run from the configured private run store", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-cli-rollback-"));
  const root = join(container, "project");
  const cache = join(container, "cache");
  try {
    await mkdir(root);
    const content = "export const status = 'applied';\n";
    await put(root, "src/status.ts", content);
    const runId = "cli-rollback";
    const contract: ChangeContractV1 = {
      schemaVersion: 1,
      source: { path: "change.human", sha256: sha256Text("create status") },
      projectFingerprint: sha256Text("profile"),
      targetWorkspaces: ["react:."],
      targetSymbols: ["status"],
      requirements: [{ id: "REQ-1", description: "Create status." }],
      acceptanceCriteria: { automated: ["Status compiles."], manual: [] },
      scope: { allowedPaths: ["src/**"], allowedOperations: ["create"], prohibitedPaths: [] },
      prohibitedChanges: [],
      risks: [],
      authorizedRisks: [],
      unresolvedQuestions: [],
    };
    const patch: PatchSetV1 = {
      schemaVersion: 1,
      contractHash: hashCanonical(contract),
      snapshotHash: sha256Text("snapshot"),
      operations: [{ kind: "create", path: "src/status.ts", content }],
      requirementIds: ["REQ-1"],
      proposedTests: ["Compile status."],
    };
    const patchHash = hashCanonical(patch);
    const timestamp = "2026-07-15T00:00:00.000Z";
    const record: RunRecordV1 = {
      runId,
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      root,
      status: "VERIFIED",
      contractHash: hashCanonical(contract),
      contextManifestHash: sha256Text("context"),
      patchHash,
      validationReportHash: sha256Text("report"),
      diagnostics: [],
    };
    const store = new RunStore(join(cache, "runs"));
    await store.create(record);
    await store.writeArtifact(runId, "contract.json", contract);
    await store.writeArtifact(runId, "patch.json", patch);
    await store.writeArtifact(runId, "apply.json", {
      appliedAt: timestamp,
      paths: ["src/status.ts"],
      patchHash,
    });
    await store.writeArtifact(runId, "rollback.json", {
      schemaVersion: 1,
      patchHash,
      createdAt: timestamp,
      entries: [{
        kind: "created",
        path: "src/status.ts",
        before: "",
        afterHash: sha256Text(content),
        mode: 0o644,
      }],
    });

    const result = await cli(["rollback", runId, "--json"], {
      HUMAN_TO_CODE_CACHE: cache,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const outcome = JSON.parse(result.stdout) as { runId: string; status: string; diagnostics: string[] };
    assert.equal(outcome.runId, runId);
    assert.equal(outcome.status, "VERIFIED");
    assert.match(outcome.diagnostics.join("\n"), /Rollback restored 1 operation/u);
    await assert.rejects(access(join(root, "src/status.ts")));
    assert.ok(await store.readArtifact(runId, "rollback-result.json"));
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
