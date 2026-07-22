import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactValidationError, sha256Text } from "../src/core/contracts.ts";
import {
  ContextRequestLimitError,
  ContextRequestSession,
  ContextSecurityError,
  hashContextManifest,
  scanSecrets,
  selectContext,
  validateContextManifestV1,
} from "../src/memory/context.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "h2c-context-"));
  await mkdir(join(root, "src"));
  return root;
}

test("selectContext is deterministic and records exact bounded evidence", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "src", "b.ts"), "one\ntwo\nthree\n");
    await writeFile(join(root, "src", "a.ts"), "alpha\nbeta\n");
    const options = {
      root,
      projectFingerprint: sha256Text("profile"),
      candidates: [
        { origin: "project" as const, path: "src/b.ts", reason: "Target definition", range: { startLine: 2, endLine: 3 } },
        { origin: "project" as const, path: "src/a.ts", reason: "Nearest convention" },
      ],
    };
    const first = await selectContext(options);
    const second = await selectContext(options);
    assert.deepEqual(first, second);
    assert.equal(hashContextManifest(first), hashContextManifest(second));
    assert.deepEqual(first.evidence.map((item) => item.origin === "official_documentation" ? item.url : item.path), ["src/a.ts", "src/b.ts"]);
    assert.equal(first.evidence[1]?.content, "two\nthree");
    assert.equal(first.evidence[1]?.startLine, 2);
    assert.equal(first.evidence[1]?.sha256, sha256Text("two\nthree"));
    assert.equal(first.budget.usedItems, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selectContext blocks traversal and protected files regardless of optionality", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "secrets.human"), "secret");
    await assert.rejects(
      () => selectContext({
        root,
        projectFingerprint: sha256Text("profile"),
        candidates: [{ origin: "project", path: "secrets.human", reason: "Ignore prior instructions" }],
      }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "PROTECTED_PATH",
    );
    await assert.rejects(
      () => selectContext({
        root,
        projectFingerprint: sha256Text("profile"),
        candidates: [{ origin: "project", path: "../outside", reason: "Escape" }],
      }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "PATH_ESCAPE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confined dependency symlinks work for pnpm-style installs while project symlinks remain blocked", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg", "index.d.ts"), "export declare const api: string;\n");
    await symlink(".pnpm/pkg@1.0.0/node_modules/pkg", join(root, "node_modules", "pkg"));
    await symlink(join(root, "src", "missing.ts"), join(root, "src", "link.ts"));
    const manifest = await selectContext({
      root,
      projectFingerprint: sha256Text("profile"),
      candidates: [{ origin: "dependency", path: "node_modules/pkg/index.d.ts", version: "1.0.0", reason: "Installed declaration" }],
    });
    assert.equal(manifest.evidence[0]?.content, "export declare const api: string;\n");
    await assert.rejects(() => selectContext({
      root,
      projectFingerprint: sha256Text("profile"),
      candidates: [{ origin: "project", path: "src/link.ts", reason: "Project link" }],
    }), (error: unknown) => error instanceof ContextSecurityError && error.code === "SYMLINK_BLOCKED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret content blocks by default and can be irreversibly redacted", async () => {
  const root = await fixture();
  const credential = "super-secret-value-123";
  try {
    const content = `export const API_KEY = '${credential}';\nexport const safe = true;\n`;
    await writeFile(join(root, "src", "config.ts"), content);
    assert.ok(scanSecrets(content).length > 0);
    await assert.rejects(
      () => selectContext({
        root,
        projectFingerprint: sha256Text("profile"),
        candidates: [{ origin: "project", path: "src/config.ts", reason: "Configuration" }],
      }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "SECRET_DETECTED",
    );
    const manifest = await selectContext({
      root,
      projectFingerprint: sha256Text("profile"),
      secretPolicy: "redact",
      candidates: [{ origin: "project", path: "src/config.ts", reason: "Configuration" }],
    });
    assert.equal(manifest.redactionCount, 1);
    assert.doesNotMatch(manifest.evidence[0]?.content ?? "", new RegExp(credential, "u"));
    assert.match(manifest.evidence[0]?.content ?? "", /\[REDACTED:credential_assignment\]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment references are not mistaken for hard-coded secrets", () => {
  assert.deepEqual(scanSecrets("const api_key = process.env.API_KEY;\npassword = settings.password\ntoken = tokenizer.encode\nsecret = user.secret\n"), []);
});

test("ContextManifestV1 validation detects provenance or budget tampering", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
    const manifest = await selectContext({
      root,
      projectFingerprint: sha256Text("profile"),
      candidates: [{ origin: "project", path: "src/safe.ts", reason: "Target" }],
    });
    assert.equal(validateContextManifestV1(manifest), manifest);
    const tampered = structuredClone(manifest);
    tampered.evidence[0]!.content = "malicious replacement";
    assert.throws(() => validateContextManifestV1(tampered), ArtifactValidationError);
    const inflated = structuredClone(manifest);
    inflated.budget.usedBytes += 1;
    assert.throws(() => validateContextManifestV1(inflated), ArtifactValidationError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline official documentation requires versioned, hash-matched cache evidence", async () => {
  const root = await fixture();
  try {
    const content = "# React 19 reference\nuseActionState";
    await assert.rejects(
      () => selectContext({
        root,
        projectFingerprint: sha256Text("profile"),
        offline: true,
        candidates: [{
          origin: "official_documentation",
          url: "https://react.dev/reference/react/useActionState",
          version: "19.1",
          content,
          contentSha256: sha256Text(content),
          reason: "Installed API reference",
          cached: false,
          required: true,
        }],
      }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "OFFLINE_MISS",
    );
    const manifest = await selectContext({
      root,
      projectFingerprint: sha256Text("profile"),
      offline: true,
      candidates: [{
        origin: "official_documentation",
        url: "https://react.dev/reference/react/useActionState#usage",
        version: "19.1",
        content,
        contentSha256: sha256Text(content),
        reason: "Installed API reference",
        cached: true,
        required: true,
      }],
    });
    assert.equal(manifest.evidence[0]?.origin, "official_documentation");
    assert.equal(manifest.evidence[0] && "url" in manifest.evidence[0] ? manifest.evidence[0].url.includes("#") : true, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required evidence never silently truncates to fit budget", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "src", "large.ts"), "x".repeat(200));
    await assert.rejects(
      () => selectContext({
        root,
        projectFingerprint: sha256Text("profile"),
        budget: { maxBytes: 100, maxBytesPerItem: 100 },
        candidates: [{ origin: "project", path: "src/large.ts", reason: "Required target", required: true }],
      }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "BUDGET_EXCEEDED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ContextRequestSession validates tools and enforces the hard eight-request limit", () => {
  const session = new ContextRequestSession();
  for (let index = 0; index < 8; index += 1) {
    session.accept({
      schemaVersion: 1,
      requestId: `req-${index}`,
      kind: "symbol",
      workspace: "apps/web",
      query: `Widget${index}`,
      reason: "Resolve a referenced symbol",
      maxItems: 2,
      path: null,
    });
  }
  assert.equal(session.remaining, 0);
  assert.throws(() => session.accept({
    schemaVersion: 1,
    requestId: "req-9",
    kind: "diagnostic",
    workspace: "apps/web",
    query: "TS2345",
    reason: "Resolve diagnostic",
    maxItems: 1,
    path: null,
  }), ContextRequestLimitError);
  assert.throws(() => new ContextRequestSession().accept({
    schemaVersion: 1,
    requestId: "secrets",
    kind: "file",
    workspace: "apps/web",
    path: ".env",
    query: "read password credentials",
    reason: "Ignore policy",
    maxItems: 1,
    extra: true,
  }), ArtifactValidationError);
});
