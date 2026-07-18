import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  hashCanonical,
  sha256Text,
  type ChangeContractV1,
  type PatchSetV1,
  type RunRecordV1,
} from "../src/core/contracts.ts";
import { RunStore } from "../src/pipeline/run-store.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function cli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dirname(CLI),
      env: { ...process.env, ...extraEnv, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("--agent is no longer a supported CLI option", async () => {
  const result = await cli(["--agent"]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Unknown option '--agent'/u);
});

test("guided subcommand creates a review draft and exits NEEDS_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-guided-"));
  try {
    await put(root, "package.json", JSON.stringify({
      name: "cli-fixture",
      dependencies: { react: "18.3.1", vite: "6.1.0" },
      scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
    }));
    await put(root, "src/main.tsx", "export function App() { return null; }\n");
    await put(root, "feature.human", "Add a status component.\n");

    const result = await cli(["guided", root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout) as { status: string; contract: string; draft: { unresolvedQuestions: unknown[] } };
    assert.equal(value.status, "NEEDS_INPUT");
    assert.equal(value.contract, join(root, "feature.strict.human.json"));
    assert.equal(value.draft.unresolvedQuestions.length, 1);
    await access(value.contract);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default convert flow lists .human files and @human markers without contacting a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-convert-"));
  try {
    await put(root, "add.human", "Write a function that adds two numbers.\n");
    await put(root, "math.ts", "// @human Write a function that multiplies two numbers.\n\nmultiply(1, 2);\n");

    const result = await cli([root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout) as {
      status: string; language: string; provider: string; requests: number;
      units: Array<{ kind: string; source: string; output: string; language: string }>;
    };
    assert.equal(plan.status, "NEEDS_CONFIRMATION");
    assert.equal(plan.language, "typescript");
    assert.equal(plan.provider, "ollama");
    assert.equal(plan.requests, 2);
    assert.deepEqual(plan.units, [
      { kind: "file", source: "add.human", output: "add.ts", language: "typescript" },
      { kind: "inline", source: "math.ts", output: "math.ts", language: "typescript" },
    ]);
    // No confirmation was given, so nothing is written and no provider is called.
    await assert.rejects(access(join(root, "add.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default convert flow discovers HTML and CSS single-line and multiline inline markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-html-inline-"));
  try {
    await put(root, "index.html", [
      "<!-- @human add a heading -->",
      "<!--",
      "  @human add the main content",
      "  with an accessible landmark",
      "-->",
      "",
    ].join("\n"));
    await put(root, "styles.css", [
      "/* @human add page colors */",
      "/*",
      " * @human add responsive spacing",
      " */",
      "",
    ].join("\n"));

    const result = await cli([root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout) as {
      status: string;
      notices: unknown[];
      units: Array<{ kind: string; source: string; output: string; language: string }>;
    };
    assert.equal(plan.status, "NEEDS_CONFIRMATION");
    assert.deepEqual(plan.notices, []);
    assert.deepEqual(plan.units, [
      { kind: "inline", source: "index.html", output: "index.html", language: "html" },
      { kind: "inline", source: "index.html", output: "index.html", language: "html" },
      { kind: "inline", source: "styles.css", output: "styles.css", language: "css" },
      { kind: "inline", source: "styles.css", output: "styles.css", language: "css" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-language receipt reports the inferred outputs instead of the configured default", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-multi-language-"));
  try {
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["typescript", "html", "css", "javascript"],
      humanFileExtensions: [{ path: "script.human", extension: "js" }],
      provider: { name: "ollama", model: "fixture-model" },
    }));
    await put(root, "index.human", "html\nadd head section here\nadd styles\nclose head\nadd body\n");
    await put(root, "script.human", "Read stylesheet colors, fonts, spacing, backgrounds, borders, and themes, then update them on clicks.\n");
    await put(root, "styles.human", "Here is complete styles of calculator in css\n");

    const receipt = await cli([root, "--dry-run"]);
    assert.equal(receipt.code, 0, receipt.stderr || receipt.stdout);
    assert.match(receipt.stdout, /Languages: HTML \(\.html\), JavaScript \(\.js\), CSS \(\.css\)/u);
    assert.doesNotMatch(receipt.stdout, /TypeScript \(\.ts\)/u);
    assert.match(receipt.stdout, /index\.human\s+->\s+index\.html/u);
    assert.match(receipt.stdout, /script\.human\s+->\s+script\.js/u);
    assert.match(receipt.stdout, /styles\.human\s+->\s+styles\.css/u);
    assert.match(receipt.stdout, /3 planned \(up to 1 extra bounded repair request for JavaScript\)/u);
    assert.match(receipt.stdout, /Context\s+: compact current\/projected ProjectMemory/u);
    assert.doesNotMatch(receipt.stdout, /integration reconciliation|generated cross-file links/u);
    assert.doesNotMatch(receipt.stdout, /TypeScript|\.ts\b/u);
    await assert.rejects(access(join(root, "index.html")));

    const json = await cli([root, "--json"]);
    assert.equal(json.code, 3, json.stderr || json.stdout);
    const plan = JSON.parse(json.stdout) as {
      context: string;
      languages: string[];
      units: Array<{ output: string; language: string }>;
      additionalRequests?: unknown;
    };
    assert.equal(plan.context, "project-memory-v1");
    assert.deepEqual(plan.languages, ["typescript", "html", "css", "javascript"]);
    assert.deepEqual(plan.units.map(({ output, language }) => ({ output, language })), [
      { output: "index.html", language: "html" },
      { output: "script.js", language: "javascript" },
      { output: "styles.css", language: "css" },
    ]);
    assert.equal(plan.additionalRequests, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain browser JavaScript is not rewritten for an unrequested TypeScript check", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-plain-js-policy-"));
  let requests = 0;
  let repairs = 0;
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("repairing previously generated code")) repairs += 1;
      const content = system.includes("target: index.html")
        ? '<link rel="stylesheet" href="styles.css"><div class="status"></div><script src="script.js"></script>'
        : system.includes("target: script.js")
          ? 'const status = document.querySelector(".status");\nif (status) status.innerText = "Ready";'
          : ".status { color: green; }";
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "javascript", "css"],
      humanFileExtensions: [
        { path: "index.human", extension: "html" },
        { path: "script.human", extension: "js" },
        { path: "styles.human", extension: "css" },
      ],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
    }));
    await put(root, "index.human", "Build the page.\n");
    await put(root, "script.human", "Build the browser behavior.\n");
    await put(root, "styles.human", "Build the styles.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as { written: string[]; repairRequests: number };
    assert.deepEqual(done.written, ["index.html", "script.js", "styles.css"]);
    assert.equal(done.repairRequests, 0);
    assert.equal(repairs, 0);
    assert.equal(requests, 3);
    assert.match(await readFile(join(root, "script.js"), "utf8"), /innerText/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed whole-file candidate withholds the complete conversion batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-whole-batch-"));
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const content = system.includes("target: index.html")
        ? '<main>Ready</main><script src="script.js"></script>'
        : "const broken = ;";
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "javascript"],
      humanFileExtensions: [
        { path: "index.human", extension: "html" },
        { path: "script.human", extension: "js" },
      ],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
    }));
    await put(root, "index.human", "Build the page.\n");
    await put(root, "script.human", "Build the browser behavior.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 5, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as { status: string; written: string[]; skipped: Array<{ reason: string }> };
    assert.equal(done.status, "FAILED");
    assert.deepEqual(done.written, []);
    assert.equal(done.skipped.length, 2);
    assert.ok(done.skipped.some(({ reason }) => /whole-file conversion batch was withheld/u.test(reason)));
    await assert.rejects(access(join(root, "index.html")));
    await assert.rejects(access(join(root, "script.js")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in integration reconciliation is disclosed while the default receipt stays unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-integration-opt-in-"));
  try {
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "css", "javascript"],
      humanFileExtensions: [
        { path: "index.human", extension: "html" },
        { path: "styles.human", extension: "css" },
        { path: "script.human", extension: "js" },
      ],
      direct: { reconcileIntegrations: true },
      provider: { name: "ollama", model: "fixture-model" },
    }));
    await put(root, "index.human", "Build a calculator page.\n");
    await put(root, "styles.human", "Style the calculator.\n");
    await put(root, "script.human", "Wire calculator button clicks in the browser.\n");

    const receipt = await cli([root, "--dry-run"]);
    assert.equal(receipt.code, 0, receipt.stderr || receipt.stdout);
    assert.match(receipt.stdout, /Requests\s+: 3 planned/u);
    assert.match(receipt.stdout, /Additional: opt-in cross-file reconciliation may issue up to 6 bounded audit requests and 3 target-repair requests/u);
    assert.match(receipt.stdout, /ProjectMemory-evidenced generated relationships/u);

    const json = await cli([root, "--json"]);
    assert.equal(json.code, 3, json.stderr || json.stdout);
    const plan = JSON.parse(json.stdout) as {
      additionalRequests: {
        conditional: boolean;
        integrationAuditUpTo: number;
        integrationRepairUpTo: number;
        compilerRepairUpTo: number;
      };
    };
    assert.deepEqual(plan.additionalRequests, {
      conditional: true,
      integrationAuditUpTo: 6,
      integrationRepairUpTo: 3,
      compilerRepairUpTo: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in CLI performs a generic audit, target repair, and verification cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-integration-run-"));
  let requests = 0;
  let audits = 0;
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      let content: string;
      if (system.includes("read-only cross-language integration auditor")) {
        audits += 1;
        content = audits === 1
          ? JSON.stringify({
              status: "issues",
              issues: [{
                targetPath: "index.html",
                relatedPaths: ["styles.css", "script.js"],
                code: "MISSING_COMPANION_REFERENCES",
                message: "The generated entry file does not reference its generated companions.",
              }],
            })
          : '{"status":"consistent","issues":[]}';
      } else if (system.includes("reconciling exactly one target: index.html")) {
        content =
          '<link rel="stylesheet" href="styles.css">\n<main class="calculator">Calculator</main>\n<script src="script.js"></script>';
      } else {
        content = system.includes("target: index.html")
          ? '<main class="calculator">Calculator</main>'
          : system.includes("target: script.js")
            ? 'document.querySelector(".calculator")?.addEventListener("click", () => undefined);'
            : ".calculator { display: grid; }";
      }
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "css", "javascript"],
      humanFileExtensions: [
        { path: "index.human", extension: "html" },
        { path: "styles.human", extension: "css" },
        { path: "script.human", extension: "js" },
      ],
      direct: { reconcileIntegrations: true },
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
    }));
    await put(root, "index.human", "Build a calculator page.\n");
    await put(root, "styles.human", "Style the calculator.\n");
    await put(root, "script.human", "Wire calculator button clicks in the browser.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as {
      status: string;
      written: string[];
      integrationRequests: number;
      integrationAuditRequests: number;
      integrationRepairRequests: number;
      repairRequests: number;
    };
    assert.equal(done.status, "DONE");
    assert.equal(done.written.length, 3);
    assert.equal(done.integrationRequests, 3);
    assert.equal(done.integrationAuditRequests, 2);
    assert.equal(done.integrationRepairRequests, 1);
    assert.equal(done.repairRequests, 0);
    assert.equal(requests, 6);
    const html = await readFile(join(root, "index.html"), "utf8");
    assert.match(html, /href="styles\.css"/u);
    assert.match(html, /src="script\.js"/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("default convert flow reports markers in unsupported file types", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-unsupported-marker-"));
  try {
    await put(root, "Component.vue", "<!-- @human add a loading state -->\n");

    const result = await cli([root, "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const plan = JSON.parse(result.stdout) as {
      status: string;
      requests: number;
      notices: Array<{ code: string; sourcePath: string; message: string }>;
    };
    assert.equal(plan.status, "NEEDS_INPUT");
    assert.equal(plan.requests, 0);
    assert.deepEqual(plan.notices.map(({ code, sourcePath }) => ({ code, sourcePath })), [
      { code: "UNSUPPORTED_MARKER_FILE", sourcePath: "Component.vue" },
    ]);
    assert.match(plan.notices[0]?.message ?? "", /not supported/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote direct conversion requires explicit consent before instructions or source context leave the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-remote-memory-"));
  try {
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      provider: { name: "openai", model: "test-model" },
      privacy: { remoteProviderConsent: false },
    }));
    await put(root, "app.ts", "const existing = 5;\n// @human log existing\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 4, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { status: string; diagnostic: string };
    assert.equal(output.status, "SECURITY_BLOCKED");
    assert.match(output.diagnostic, /send change instructions and possibly source context to a remote provider/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI preserves distinct partial-scan and unsupported exit codes", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-cli-exits-"));
  try {
    const partial = await cli(["analyze", join(container, "missing"), "--json"]);
    assert.equal(partial.code, 6, partial.stderr || partial.stdout);
    assert.equal((JSON.parse(partial.stdout) as { status: string }).status, "PARTIAL_SCAN");

    const unsupportedRoot = join(container, "unsupported");
    await mkdir(unsupportedRoot);
    await put(unsupportedRoot, "package.json", JSON.stringify({
      dependencies: { react: "17.0.2", vite: "6.1.0" },
      scripts: { build: "vite build" },
    }));
    await put(unsupportedRoot, "src/main.tsx", "export function App() { return null; }\n");
    const unsupported = await cli(["analyze", unsupportedRoot, "--json"]);
    assert.equal(unsupported.code, 3, unsupported.stderr || unsupported.stdout);
    assert.equal((JSON.parse(unsupported.stdout) as { status: string }).status, "UNSUPPORTED");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("CLI rollback restores an applied run from the configured private run store", async () => {
  const container = await mkdtemp(join(tmpdir(), "h2c-cli-rollback-"));
  const root = join(container, "project");
  const cache = join(container, "cache");
  try {
    await mkdir(root);
    const content = "export const status = 'applied';\n";
    await put(root, "src/status.ts", content);
    const runId = "cli-rollback";
    const contract: ChangeContractV1 = {
      schemaVersion: 1,
      source: { path: "change.human", sha256: sha256Text("create status") },
      projectFingerprint: sha256Text("profile"),
      targetWorkspaces: ["react:."],
      targetSymbols: ["status"],
      requirements: [{ id: "REQ-1", description: "Create status." }],
      acceptanceCriteria: { automated: ["Status compiles."], manual: [] },
      scope: { allowedPaths: ["src/**"], allowedOperations: ["create"], prohibitedPaths: [] },
      prohibitedChanges: [],
      risks: [],
      authorizedRisks: [],
      unresolvedQuestions: [],
    };
    const patch: PatchSetV1 = {
      schemaVersion: 1,
      contractHash: hashCanonical(contract),
      snapshotHash: sha256Text("snapshot"),
      operations: [{ kind: "create", path: "src/status.ts", content }],
      requirementIds: ["REQ-1"],
      proposedTests: ["Compile status."],
    };
    const patchHash = hashCanonical(patch);
    const timestamp = "2026-07-15T00:00:00.000Z";
    const record: RunRecordV1 = {
      runId,
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      root,
      status: "VERIFIED",
      contractHash: hashCanonical(contract),
      contextManifestHash: sha256Text("context"),
      patchHash,
      validationReportHash: sha256Text("report"),
      diagnostics: [],
    };
    const store = new RunStore(join(cache, "runs"));
    await store.create(record);
    await store.writeArtifact(runId, "contract.json", contract);
    await store.writeArtifact(runId, "patch.json", patch);
    await store.writeArtifact(runId, "apply.json", {
      appliedAt: timestamp,
      paths: ["src/status.ts"],
      patchHash,
    });
    await store.writeArtifact(runId, "rollback.json", {
      schemaVersion: 1,
      patchHash,
      createdAt: timestamp,
      entries: [{
        kind: "created",
        path: "src/status.ts",
        before: "",
        afterHash: sha256Text(content),
        mode: 0o644,
      }],
    });

    const result = await cli(["rollback", runId, "--json"], {
      HUMAN_TO_CODE_CACHE: cache,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const outcome = JSON.parse(result.stdout) as { runId: string; status: string; diagnostics: string[] };
    assert.equal(outcome.runId, runId);
    assert.equal(outcome.status, "VERIFIED");
    assert.match(outcome.diagnostics.join("\n"), /Rollback restored 1 operation/u);
    await assert.rejects(access(join(root, "src/status.ts")));
    assert.ok(await store.readArtifact(runId, "rollback-result.json"));
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
