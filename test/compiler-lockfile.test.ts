import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COMPILER_LOCK_FILENAME,
  loadCompilerLockfile,
  readCompilerLockfile,
  validateCompilerLockfile,
  writeCompilerLockfile,
} from "../src/index.ts";

const ID = "a".repeat(64);
const LOCK = {
  schemaVersion: 1 as const,
  units: {
    [ID]: {
      compileKey: "b".repeat(64),
      outputHash: "c".repeat(64),
      targetPath: "src/output.ts",
    },
  },
};

test("compiler lockfile round trips through atomic secure storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-lock-"));
  try {
    await writeCompilerLockfile(root, LOCK);
    assert.deepEqual(await loadCompilerLockfile(root), LOCK);
    assert.match(
      await readFile(join(root, COMPILER_LOCK_FILENAME), "utf8"),
      /"schemaVersion": 1/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown fields are rejected and corrupt or symlinked locks become cache misses", async () => {
  assert.throws(
    () => validateCompilerLockfile({ ...LOCK, extra: true }),
    /Unknown lockfile field/u,
  );
  const root = await mkdtemp(join(tmpdir(), "h2c-lock-"));
  const outside = join(root, "outside.json");
  try {
    await mkdir(join(root, "unused"));
    await writeCompilerLockfile(root, LOCK);
    await rm(join(root, COMPILER_LOCK_FILENAME));
    await writeCompilerLockfile(root, LOCK);
    await rm(join(root, COMPILER_LOCK_FILENAME));
    await symlink(outside, join(root, COMPILER_LOCK_FILENAME));
    await assert.rejects(() => loadCompilerLockfile(root), /non-symlink/u);
    assert.equal(await readCompilerLockfile(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

