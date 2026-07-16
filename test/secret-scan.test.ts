import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectSecretScanError, scanProjectForSecrets } from "../src/security/secret-scan.ts";

test("repository secret scan includes ignored-style first-party paths without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "human-to-code-secret-scan-"));
  try {
    await mkdir(join(root, "ignored", "logs"), { recursive: true });
    await writeFile(join(root, "ignored", "logs", "debug.log"), 'api_key="abcdefghijklmnop"\n', "utf8");
    await assert.rejects(
      scanProjectForSecrets(root),
      (error: unknown) => error instanceof ProjectSecretScanError
        && error.code === "SECRET_DETECTED"
        && error.findings[0]?.path === "ignored/logs/debug.log"
        && !error.message.includes("abcdefghijklmnop"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository secret scan confines symlinks and excludes third-party dependency stores", async () => {
  const container = await mkdtemp(join(tmpdir(), "human-to-code-secret-scan-"));
  const root = join(container, "project");
  try {
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(join(root, "node_modules", "fixture", "example.txt"), 'password="not-a-project-secret"', "utf8");
    await writeFile(join(container, "outside.txt"), 'api_key="abcdefghijklmnop"', "utf8");
    await symlink(join(container, "outside.txt"), join(root, "outside-link"));
    await writeFile(join(root, "source.ts"), "export const value = 1;\n", "utf8");
    const result = await scanProjectForSecrets(root);
    assert.equal(result.findings.length, 0);
    assert.equal(result.symlinksSkipped, 1);
    assert.equal(result.filesScanned, 1);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

