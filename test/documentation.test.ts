import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextSecurityError } from "../src/memory/context.ts";
import { DocumentationError, OfficialDocumentationClient } from "../src/memory/documentation.ts";

async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "human-to-code-doc-test-"));
}

test("official documentation is version-bound, normalized, cached, and available offline", async () => {
  const root = await temporary();
  try {
    const client = new OfficialDocumentationClient({
      cacheRoot: root,
      allowedHosts: ["docs.example.com"],
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => new Response("<html><script>drop()</script><h1>Widget API</h1><code>createWidget</code></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"' },
      }),
    });
    const online = await client.retrieve({
      url: "https://docs.example.com/widget",
      version: "2.4.1",
      reason: "Exact Widget API used by the patch.",
    });
    assert.equal(online.cached, false);
    assert.match(online.content, /Widget API/u);
    assert.match(online.content, /createWidget/u);
    assert.doesNotMatch(online.content, /drop/u);

    const offline = await client.retrieve({
      url: "https://docs.example.com/widget",
      version: "2.4.1",
      reason: "Offline validation.",
      offline: true,
    });
    assert.equal(offline.cached, true);
    assert.equal(offline.contentSha256, online.contentSha256);
    assert.equal((await readdir(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documentation cache is conditionally revalidated", async () => {
  const root = await temporary();
  try {
    let calls = 0;
    const client = new OfficialDocumentationClient({
      cacheRoot: root,
      allowedHosts: ["docs.example.com"],
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) return new Response("Stable API", { headers: { "content-type": "text/plain", etag: '"stable"' } });
        assert.equal(new Headers(init.headers).get("if-none-match"), '"stable"');
        return new Response(null, { status: 304 });
      },
    });
    const first = await client.retrieve({ url: "https://docs.example.com/api", version: "1.0.0", reason: "First." });
    const second = await client.retrieve({ url: "https://docs.example.com/api", version: "1.0.0", reason: "Second." });
    assert.equal(first.content, second.content);
    assert.equal(second.cached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documentation retrieval blocks private DNS and secrets before cache writes", async () => {
  const privateRoot = await temporary();
  try {
    let fetched = false;
    const privateClient = new OfficialDocumentationClient({
      cacheRoot: privateRoot,
      allowedHosts: ["docs.example.com"],
      resolveHostname: async () => ["127.0.0.1"],
      fetch: async () => { fetched = true; return new Response("never"); },
    });
    await assert.rejects(
      privateClient.retrieve({ url: "https://docs.example.com/api", version: "1.0.0", reason: "Blocked." }),
      (error: unknown) => error instanceof DocumentationError && error.code === "NETWORK_BLOCKED",
    );
    assert.equal(fetched, false);

    const secretClient = new OfficialDocumentationClient({
      cacheRoot: privateRoot,
      allowedHosts: ["docs.example.com"],
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => new Response('api_key="abcdefghijklmnop"', { headers: { "content-type": "text/plain" } }),
    });
    await assert.rejects(
      secretClient.retrieve({ url: "https://docs.example.com/secret", version: "1.0.0", reason: "Blocked." }),
      (error: unknown) => error instanceof ContextSecurityError && error.code === "SECRET_DETECTED",
    );
    assert.deepEqual(await readdir(privateRoot).catch(() => []), []);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("documentation retrieval blocks mapped/scoped addresses and DNS rebinding", async (t) => {
  for (const address of ["::ffff:7f00:1", "fe80::1%lo0"]) {
    await t.test(address, async () => {
      const root = await temporary();
      let fetched = false;
      try {
        const client = new OfficialDocumentationClient({
          cacheRoot: root,
          allowedHosts: ["docs.example.com"],
          resolveHostname: async () => [address],
          fetch: async () => { fetched = true; return new Response("never"); },
        });
        await assert.rejects(
          client.retrieve({ url: "https://docs.example.com/api", version: "1.0.0", reason: "Blocked." }),
          (error: unknown) => error instanceof DocumentationError && error.code === "NETWORK_BLOCKED",
        );
        assert.equal(fetched, false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  const root = await temporary();
  let resolutions = 0;
  try {
    const client = new OfficialDocumentationClient({
      cacheRoot: root,
      allowedHosts: ["docs.example.com"],
      resolveHostname: async () => (++resolutions === 1 ? ["93.184.216.34"] : ["93.184.216.35"]),
      fetch: async () => new Response("API", { headers: { "content-type": "text/plain" } }),
    });
    await assert.rejects(
      client.retrieve({ url: "https://docs.example.com/1.0.0/api", version: "1.0.0", reason: "Rebinding check." }),
      (error: unknown) => error instanceof DocumentationError && error.code === "DNS_REBINDING",
    );
    assert.deepEqual(await readdir(root).catch(() => []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
