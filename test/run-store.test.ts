import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRecordV1 } from "../src/core/contracts.ts";
import { RunStore, RunStoreError } from "../src/workflows/run-store.ts";

function record(runId: string, root: string): RunRecordV1 {
  const timestamp = "2026-07-15T00:00:00.000Z";
  return {
    runId,
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    root,
    status: "INCONCLUSIVE",
    diagnostics: ["Created for a deterministic test."],
  };
}

test("RunStore persists private records and JSON artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-run-store-"));
  try {
    const store = new RunStore(join(root, "runs"));
    await store.create(record("run-1", root));
    assert.equal((await store.read("run-1")).status, "INCONCLUSIVE");

    const artifactPath = await store.writeArtifact("run-1", "patch.json", { safe: true });
    assert.deepEqual(await store.readArtifact("run-1", "patch.json"), { safe: true });
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);

    await assert.rejects(
      store.writeArtifact("run-1", "../escape.json", {}),
      (error: unknown) => error instanceof RunStoreError && error.code === "INVALID_ARTIFACT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunStore locks serialize state-changing actions across callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-run-lock-"));
  try {
    const store = new RunStore(join(root, "runs"));
    await store.create(record("run-locked", root));

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = store.exclusive("run-locked", async () => {
      enter();
      await gate;
      return "first";
    });
    await entered;

    await assert.rejects(
      store.exclusive("run-locked", async () => "second"),
      (error: unknown) => error instanceof RunStoreError && error.code === "RUN_LOCKED",
    );
    release();
    assert.equal(await first, "first");

    // The lock is removed even after the protected action completes.
    assert.equal(await store.exclusive("run-locked", async () => "third"), "third");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunStore recovers a provenance-valid lock left by a dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-stale-lock-"));
  try {
    const store = new RunStore(join(root, "runs"));
    await store.create(record("stale-lock", root));
    await writeFile(join(store.root, "stale-lock", ".lock"), JSON.stringify({
      pid: 2_147_483_647,
      createdAt: "2020-01-01T00:00:00.000Z",
      nonce: "stale-test",
    }));
    assert.equal(await store.exclusive("stale-lock", async () => "resumed"), "resumed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunStore rejects credential-like artifact content before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-run-secret-"));
  try {
    const store = new RunStore(join(root, "runs"));
    await store.create(record("secret-guard", root));
    await assert.rejects(
      store.writeArtifact("secret-guard", "unsafe.json", { output: 'api_key="abcdefghijklmnop"' }),
      (error: unknown) => error instanceof RunStoreError && error.code === "SECRET_BLOCKED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunStore never follows artifact symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-run-symlink-"));
  try {
    const store = new RunStore(join(root, "runs"));
    await store.create(record("symlink-guard", root));
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ escaped: true }));
    await symlink(outside, join(store.root, "symlink-guard", "patch.json"));
    await assert.rejects(
      store.readArtifact("symlink-guard", "patch.json"),
      (error: unknown) => error instanceof RunStoreError && error.code === "INVALID_ARTIFACT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
