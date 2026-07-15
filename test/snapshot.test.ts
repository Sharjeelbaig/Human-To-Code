import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  SnapshotError,
  createWorkspaceSnapshot,
  disposeWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "../src/snapshot.ts";

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

test("snapshots exclude credential-bearing and tool-state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-snapshot-"));
  let snapshot: WorkspaceSnapshot | undefined;
  try {
    await put(root, "src/app.ts", "export const ok = true;\n");
    await put(root, ".env", "API_TOKEN=not-for-copying\n");
    await put(root, "nested/secrets.human", "never copy this\n");
    await put(root, ".git/config", "[core]\nrepositoryformatversion = 0\n");

    snapshot = await createWorkspaceSnapshot(root);
    assert.deepEqual(snapshot.files.map((file) => file.path), ["src/app.ts"]);
    assert.deepEqual(snapshot.excluded, [".env", ".git", "nested/secrets.human"]);
    assert.equal(await readFile(join(snapshot.root, "src/app.ts"), "utf8"), "export const ok = true;\n");
    await assert.rejects(access(join(snapshot.root, ".env")));
    assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/u);
  } finally {
    if (snapshot) await disposeWorkspaceSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshots reject symlinks instead of dereferencing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-snapshot-link-"));
  const outside = await mkdtemp(join(tmpdir(), "h2c-snapshot-outside-"));
  try {
    await put(outside, "data.ts", "export const outside = true;\n");
    await symlink(join(outside, "data.ts"), join(root, "linked.ts"));
    await assert.rejects(
      createWorkspaceSnapshot(root),
      (error: unknown) => error instanceof SnapshotError && error.code === "SYMLINK_BLOCKED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
