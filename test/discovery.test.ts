import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, secretsTrackedError } from "../src/discovery.ts";

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "h2c-disc-"));
  await writeFile(join(root, "a.human"), "print hello");
  await writeFile(join(root, "a.strict.human"), "fn printHello");
  await writeFile(join(root, "b.human"), "print bye"); // no strict sibling
  await writeFile(join(root, "secrets.human"), "API Key: sk-x");
  await writeFile(join(root, "config.human"), "Language: typescript");
  await writeFile(join(root, "human-to-code.config.json"), "{}");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "dep.human"), "ignored");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "c.human"), "nested");
  try {
    await symlink(join(root, "sub"), join(root, "linkdir"), "dir");
  } catch {
    // symlinks may be unavailable; the rest of the assertions still hold.
  }
  return root;
}

test("discover classifies files and applies ignore rules", async () => {
  const root = await makeFixture();
  try {
    const r = await discover(root, ["node_modules", ".git", "dist"]);

    const humanPaths = r.human.map((f) => f.relPath).sort();
    assert.deepEqual(humanPaths, ["a.human", "b.human", "sub/c.human"]);

    assert.deepEqual(
      r.strict.map((f) => f.relPath),
      ["a.strict.human"],
    );

    // node_modules/dep.human is ignored.
    assert.ok(!humanPaths.includes("node_modules/dep.human"));

    // The symlinked dir must not be followed (no duplicate c.human).
    assert.ok(!humanPaths.includes("linkdir/c.human"));

    // secrets.human is surfaced separately, never as a human source.
    assert.ok(r.secrets);
    assert.equal(r.secrets?.relPath, "secrets.human");

    // strictSibling wiring.
    const a = r.human.find((f) => f.relPath === "a.human");
    assert.equal(a?.strictSibling, "a.strict.human");
    const b = r.human.find((f) => f.relPath === "b.human");
    assert.equal(b?.strictSibling, "b.strict.human");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secretsTrackedError returns null when not in a git repo", async () => {
  const root = await makeFixture();
  try {
    const r = await discover(root, ["node_modules"]);
    assert.ok(r.secrets);
    assert.equal(secretsTrackedError(r.secrets!), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secretsTrackedError refuses when secrets.human is git-tracked", async () => {
  const root = await makeFixture();
  try {
    assert.equal(
      spawnSync("git", ["-C", root, "init", "-q"]).status,
      0,
      "git init failed",
    );
    // Staging is enough for `git ls-files` to consider it tracked.
    spawnSync("git", ["-C", root, "add", "secrets.human"]);

    const r = await discover(root, ["node_modules"]);
    assert.ok(r.secrets);
    const msg = secretsTrackedError(r.secrets!);
    assert.ok(msg && msg.includes("Refusing to run"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
