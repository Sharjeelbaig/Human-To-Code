import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sha256Text, type PatchSetV1 } from "../src/core/contracts.ts";
import { applyPatchAtomic, PatchSafetyError, preparePatch } from "../src/pipeline/patch.ts";

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function patch(operations: PatchSetV1["operations"], snapshotHash = sha256Text("snapshot")): PatchSetV1 {
  return {
    schemaVersion: 1,
    contractHash: sha256Text("contract"),
    snapshotHash,
    operations,
    requirementIds: ["REQ-1"],
    proposedTests: ["Run the focused tests."],
  };
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof PatchSafetyError && error.code === code,
  );
}

test("structured edits require exact base hashes and apply all candidate operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-patch-"));
  const original = "export const value = 1;\n";
  try {
    await put(root, "src/value.ts", original);
    const artifact = patch([
      {
        kind: "edit",
        path: "src/value.ts",
        baseHash: sha256Text(original),
        oldText: "value = 1",
        newText: "value = 2",
      },
      { kind: "create", path: "src/status.ts", content: "export const status = 'ok';\n" },
    ]);

    const prepared = await preparePatch(root, artifact, {
      allowedPaths: ["src/**"],
      expectedSnapshotHash: artifact.snapshotHash,
    });
    assert.equal(prepared.operations.length, 2);

    const applied = await applyPatchAtomic(root, artifact, {
      allowedPaths: ["src/**"],
      expectedSnapshotHash: artifact.snapshotHash,
    });
    assert.deepEqual(applied.applied, ["src/value.ts", "src/status.ts"]);
    assert.equal(await readFile(join(root, "src/value.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(await readFile(join(root, "src/status.ts"), "utf8"), "export const status = 'ok';\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch preparation rejects stale, out-of-scope, and protected operations before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-patch-policy-"));
  const original = "export const value = 1;\n";
  try {
    await put(root, "src/value.ts", original);
    await rejectsCode(preparePatch(root, patch([{
      kind: "edit",
      path: "src/value.ts",
      baseHash: sha256Text("stale"),
      oldText: "value = 1",
      newText: "value = 2",
    }]), { allowedPaths: ["src/**"] }), "STALE_BASE");

    await rejectsCode(preparePatch(root, patch([
      { kind: "create", path: "outside.ts", content: "export {};\n" },
    ]), { allowedPaths: ["src/**"] }), "OUT_OF_SCOPE");

    await rejectsCode(preparePatch(root, patch([
      { kind: "create", path: ".env.production", content: "SAFE=value\n" },
    ]), { allowedPaths: ["**"] }), "INVALID_PATCH");

    await rejectsCode(preparePatch(root, patch([
      { kind: "create", path: "src/generated.ts", content: "export {};\n" },
    ]), {
      allowedPaths: ["src/**"],
      protectedPaths: ["src/generated.ts"],
    }), "PROTECTED_PATH");

    assert.equal(await readFile(join(root, "src/value.ts"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patches cannot dereference target or parent symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-patch-link-"));
  const outside = await mkdtemp(join(tmpdir(), "h2c-patch-outside-"));
  try {
    await put(outside, "victim.ts", "export const untouched = true;\n");
    await mkdir(join(root, "src"), { recursive: true });
    await symlink(join(outside, "victim.ts"), join(root, "src", "linked.ts"));
    await rejectsCode(preparePatch(root, patch([{
      kind: "edit",
      path: "src/linked.ts",
      baseHash: sha256Text("export const untouched = true;\n"),
      oldText: "true",
      newText: "false",
    }]), { allowedPaths: ["src/**"] }), "SYMLINK_ESCAPE");

    await symlink(outside, join(root, "linked-parent"));
    await rejectsCode(preparePatch(root, patch([
      { kind: "create", path: "linked-parent/created.ts", content: "export {};\n" },
    ]), { allowedPaths: ["linked-parent/**"] }), "SYMLINK_ESCAPE");
    assert.equal(await readFile(join(outside, "victim.ts"), "utf8"), "export const untouched = true;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
