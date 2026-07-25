import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readCompilerArtifact,
  writeCompilerArtifact,
} from "../src/index.ts";

test("compiler artifact cache round trips exact bytes and blocks secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-artifacts-"));
  const key = "a".repeat(64);
  try {
    const content = Buffer.from("export const answer = 42;\n", "utf8");
    await writeCompilerArtifact(key, content, root);
    assert.deepEqual(await readCompilerArtifact(key, root), content);
    await assert.rejects(
      () => writeCompilerArtifact(
        "b".repeat(64),
        Buffer.from('const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";\n'),
        root,
      ),
      /Credential-like content/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler artifact cache refuses a symlinked root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "h2c-artifacts-parent-"));
  const outside = await mkdtemp(join(tmpdir(), "h2c-artifacts-outside-"));
  const root = join(parent, "artifacts");
  try {
    await symlink(outside, root);
    await assert.rejects(
      () => writeCompilerArtifact(
        "c".repeat(64),
        Buffer.from("safe\n"),
        root,
      ),
      /non-symlink/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

