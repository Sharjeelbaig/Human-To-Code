import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discover,
  DiscoveryError,
  secretsTrackedError,
  sourceContentHash,
} from "../src/config/discovery.ts";

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-"));
  await writeFile(join(root, "a.human"), "print hello");
  await writeFile(join(root, "a.strict.human"), "fn printHello");
  await writeFile(join(root, "b.human"), "print bye");
  await writeFile(join(root, "secrets.human"), "API Key: example-not-a-real-key");
  await writeFile(join(root, "config.human"), "Language: typescript");
  await writeFile(join(root, "human-to-code.config.json"), "{}");
  await mkdir(join(root, "node_modules", "dependency", "private"), { recursive: true });
  await writeFile(join(root, "node_modules", "dependency", "dep.human"), "ignored");
  await writeFile(
    join(root, "node_modules", "dependency", "private", "secrets.human"),
    "nested ignored secret",
  );
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "c.human"), "nested");
  try {
    await symlink(join(root, "sub"), join(root, "linkdir"), "dir");
  } catch {
    // Some Windows environments disallow unprivileged symlink creation.
  }
  return root;
}

test("discover classifies sources deterministically and applies name ignores", async () => {
  const root = await makeFixture();
  try {
    const result = await discover(root, ["node_modules", ".git", "dist"]);
    assert.deepEqual(
      result.human.map(({ relPath }) => relPath),
      ["a.human", "b.human", "sub/c.human"],
    );
    assert.deepEqual(
      result.strict.map(({ relPath }) => relPath),
      ["a.strict.human"],
    );
    assert.ok(!result.human.some(({ relPath }) => relPath.startsWith("node_modules/")));
    assert.ok(!result.human.some(({ relPath }) => relPath.startsWith("linkdir/")));

    const first = result.human.find(({ relPath }) => relPath === "a.human");
    const second = result.human.find(({ relPath }) => relPath === "b.human");
    assert.equal(first?.strictSibling, "a.strict.human");
    assert.equal(second?.strictSibling, "b.strict.human");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every nested secrets.human is enumerated even below ignore boundaries", async () => {
  const root = await makeFixture();
  try {
    const result = await discover(root, ["node_modules", "secrets.human"]);
    assert.deepEqual(
      result.secretsFiles.map(({ relPath }) => relPath),
      [
        "node_modules/dependency/private/secrets.human",
        "secrets.human",
      ],
    );
    assert.equal(result.secrets?.relPath, "node_modules/dependency/private/secrets.human");
    assert.ok(result.secretsFiles.every(({ kind }) => kind === "secrets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git-ignored human sources are excluded while ignored secrets remain visible", async () => {
  const root = await makeFixture();
  try {
    assert.equal(spawnSync("git", ["-C", root, "init", "-q"]).status, 0);
    await writeFile(join(root, ".gitignore"), "sub/\nsecrets.human\n");
    const result = await discover(root);
    assert.ok(!result.human.some(({ relPath }) => relPath === "sub/c.human"));
    assert.ok(result.secretsFiles.some(({ relPath }) => relPath === "secrets.human"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discover rejects a missing root and a regular-file root", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-root-"));
  const file = join(root, "file");
  await writeFile(file, "x");
  try {
    await assert.rejects(
      () => discover(join(root, "missing")),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "ROOT_NOT_FOUND",
    );
    await assert.rejects(
      () => discover(file),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "ROOT_NOT_DIRECTORY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discover rejects a symlinked root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-root-"));
  const target = join(root, "target");
  const link = join(root, "link");
  await mkdir(target);
  try {
    try {
      await symlink(target, link, "dir");
    } catch {
      context.skip("symlink creation is unavailable");
      return;
    }
    await assert.rejects(
      () => discover(link),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "ROOT_SYMLINK",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable descendant makes the scan fail instead of becoming partial", async (context) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    context.skip("POSIX non-root permission semantics are required");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-unreadable-"));
  const blocked = join(root, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "hidden.human"), "hidden");
  await chmod(blocked, 0o000);
  try {
    await assert.rejects(
      () => discover(root),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "PARTIAL_SCAN",
    );
  } finally {
    await chmod(blocked, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt Git marker fails closed instead of ignoring Git errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-git-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "source.human"), "source");
    await assert.rejects(
      () => discover(root),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "GIT_ERROR",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secretsTrackedError is a no-op outside Git", async () => {
  const root = await makeFixture();
  try {
    const result = await discover(root);
    assert.ok(result.secrets);
    assert.equal(secretsTrackedError(result.secrets!), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-secret check detects any nested tracked secret", async () => {
  const root = await makeFixture();
  try {
    assert.equal(spawnSync("git", ["-C", root, "init", "-q"]).status, 0);
    assert.equal(
      spawnSync("git", [
        "-C",
        root,
        "add",
        "-f",
        "--",
        "node_modules/dependency/private/secrets.human",
      ]).status,
      0,
    );

    const result = await discover(root);
    // Pass only the compatibility property. The Git query still checks all
    // nested secrets under the discovery root.
    assert.ok(result.secrets);
    const message = secretsTrackedError(result.secrets!);
    assert.match(message ?? "", /node_modules\/dependency\/private\/secrets\.human/);
    assert.match(message ?? "", /Refusing to run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sourceContentHash binds exact bytes and rejects symlinks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-hash-"));
  const source = join(root, "source.human");
  const link = join(root, "linked.human");
  try {
    await writeFile(source, "first");
    const first = await sourceContentHash(source);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await sourceContentHash(source), first);
    await writeFile(source, "second");
    assert.notEqual(await sourceContentHash(source), first);

    try {
      await symlink(source, link);
    } catch {
      context.skip("symlink creation is unavailable");
      return;
    }
    await assert.rejects(
      () => sourceContentHash(link),
      (error: unknown) =>
        error instanceof DiscoveryError && error.code === "SOURCE_UNREADABLE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
