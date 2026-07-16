import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeProject } from "../src/analysis/analyzer.ts";
import { ArtifactValidationError, validateChangeContractV1 } from "../src/core/contracts.ts";
import {
  PlanningError,
  createDraftContract,
  loadReviewedContract,
  writeDraftContract,
} from "../src/pipeline/planner.ts";
import type { SourceFile } from "../src/core/types.ts";

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function reactFixture(): Promise<{ root: string; source: SourceFile }> {
  const root = await mkdtemp(join(tmpdir(), "h2c-planner-"));
  await put(root, "package.json", JSON.stringify({
    name: "planner-fixture",
    dependencies: { react: "18.3.1", vite: "6.1.0" },
    scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
  }));
  await put(root, "src/main.tsx", "export function App() { return null; }\n");
  await put(root, "change.human", "Add a small status component and cover it with tests.\n");
  return {
    root,
    source: {
      absPath: join(root, "change.human"),
      relPath: "change.human",
      kind: "human",
      strictSibling: "change.strict.human",
    },
  };
}

test("draft contracts remain blocked until their material review question is resolved", async () => {
  const { root, source } = await reactFixture();
  try {
    const profile = await analyzeProject(root);
    assert.equal(profile.status, "SUPPORTED", JSON.stringify(profile.diagnostics));

    const draft = await createDraftContract(root, source, profile);
    assert.equal(draft.needsReview, true);
    assert.equal(draft.contract.unresolvedQuestions[0]?.material, true);
    assert.throws(
      () => validateChangeContractV1(draft.contract),
      (error: unknown) => error instanceof ArtifactValidationError
        && error.issues.some((issue) => issue.code === "UNRESOLVED"),
    );

    await writeDraftContract(draft);
    await assert.rejects(
      loadReviewedContract(root, "change.strict.human.json", profile),
      (error: unknown) => error instanceof PlanningError
        && error.code === "INVALID_CONTRACT"
        && /material questions/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed contracts are bound to both the source hash and project fingerprint", async () => {
  const { root, source } = await reactFixture();
  try {
    const profile = await analyzeProject(root);
    const draft = await createDraftContract(root, source, profile);
    const reviewed = { ...draft.contract, unresolvedQuestions: [] };
    await writeFile(draft.contractPath, `${JSON.stringify(reviewed, null, 2)}\n`);

    const loaded = await loadReviewedContract(root, "change.strict.human.json", profile);
    assert.equal(loaded.contract.source.sha256, reviewed.source.sha256);
    assert.match(loaded.hash, /^[a-f0-9]{64}$/u);

    const originalSource = await readFile(source.absPath, "utf8");
    await put(root, "change.human", "The request changed after review.\n");
    await assert.rejects(
      loadReviewedContract(root, "change.strict.human.json", profile),
      (error: unknown) => error instanceof PlanningError && error.code === "STALE_SOURCE",
    );

    await put(root, "change.human", originalSource);
    const changedProfile = { ...profile, fingerprint: "f".repeat(64) };
    await assert.rejects(
      loadReviewedContract(root, "change.strict.human.json", changedProfile),
      (error: unknown) => error instanceof PlanningError && error.code === "STALE_PROFILE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
