import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

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

test("default human-readable flow starts with the human-to-code ASCII banner", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-banner-"));
  try {
    await put(root, "hello.human", "Write a hello-world function.\n");

    const result = await cli([root, "--dry-run"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.startsWith([
      "╦ ╦╦ ╦╔╦╗╔═╗╔╗╔   ╔╦╗╔═╗    ╔═╗╔═╗╔╦╗╔═╗",
      "╠═╣║ ║║║║╠═╣║║║    ║ ║ ║    ║  ║ ║ ║║║╣",
      "╩ ╩╚═╝╩ ╩╩ ╩╝╚╝────╩ ╚═╝────╚═╝╚═╝═╩╝╚═╝",
      "",
      "",
    ].join("\n")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--agent is no longer a supported CLI option", async () => {
  const result = await cli(["--agent"]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Unknown option '--agent'/u);
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

test("compiler mode blocks an underspecified request before any provider request or write", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-gate-"));
  try {
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      compiler: { enabled: true },
    }));
    await put(root, "styles.css", "/* @human add a gradient */\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 3, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout) as {
      status: string;
      diagnostics: Array<{ rule: string; facets: Array<{ id: string }> }>;
    };
    assert.equal(response.status, "NEEDS_SPECIFICATION");
    assert.equal(response.diagnostics[0]?.rule, "gradient");
    assert.deepEqual(
      response.diagnostics[0]?.facets.map((facet) => facet.id),
      ["colors", "direction", "target"],
    );
    assert.equal(
      await readFile(join(root, "styles.css"), "utf8"),
      "/* @human add a gradient */\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler replay preserves first bytes and makes zero requests on the second run", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-replay-"));
  const cache = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-cache-"));
  let requests = 0;
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => {
      requests += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        message: {
          content: `export const generatedValue = ${requests};`,
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      provider: {
        name: "ollama",
        model: "changing-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: false,
        crossFileChecks: false,
        planning: { enabled: false },
      },
      compiler: {
        enabled: true,
        semanticDiagnostics: false,
      },
    }));
    await put(root, "value.human", "Export a constant named generatedValue.\n");

    const first = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: cache },
    );
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.equal(requests, 1);
    const firstBytes = await readFile(join(root, "value.ts"), "utf8");
    assert.match(firstBytes, /= 1;/u);

    const second = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: cache },
    );
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const response = JSON.parse(second.stdout) as {
      replayed: string[];
      codingRequests: number;
    };
    assert.deepEqual(response.replayed, ["value.ts"]);
    assert.equal(response.codingRequests, 0);
    assert.equal(requests, 1);
    assert.equal(await readFile(join(root, "value.ts"), "utf8"), firstBytes);

    await put(
      root,
      "value.human",
      "Export a constant named generatedValue with the updated implementation.\n",
    );
    const rebuilt = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: cache },
    );
    assert.equal(rebuilt.code, 0, rebuilt.stderr || rebuilt.stdout);
    assert.equal(requests, 2);
    assert.match(await readFile(join(root, "value.ts"), "utf8"), /= 2;/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("matching target and lock stay up to date when the external artifact cache is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-cold-cache-"));
  const firstCache = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-cache-"));
  const emptyCache = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-empty-cache-"));
  let requests = 0;
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => {
      requests += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        message: {
          content: `export const generatedValue = ${requests};`,
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      provider: {
        name: "ollama",
        model: "changing-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: false,
        crossFileChecks: false,
        planning: { enabled: false },
      },
      compiler: { enabled: true },
    }));
    await put(root, "value.human", "Export a constant named generatedValue.\n");

    const first = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: firstCache },
    );
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.equal(requests, 1);
    const firstBytes = await readFile(join(root, "value.ts"), "utf8");

    const repeated = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: emptyCache },
    );
    assert.equal(repeated.code, 0, repeated.stderr || repeated.stdout);
    const response = JSON.parse(repeated.stdout) as {
      replayed: string[];
      codingRequests: number;
    };
    assert.deepEqual(response.replayed, ["value.ts"]);
    assert.equal(response.codingRequests, 0);
    assert.equal(requests, 1);
    assert.equal(await readFile(join(root, "value.ts"), "utf8"), firstBytes);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
    await rm(firstCache, { recursive: true, force: true });
    await rm(emptyCache, { recursive: true, force: true });
  }
});

test("restoring identical inline markers replays cached snippets with zero requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-inline-replay-"));
  const cache = await mkdtemp(join(tmpdir(), "h2c-cli-compiler-inline-cache-"));
  let classificationRequests = 0;
  let codingRequests = 0;
  const original = [
    "/* @human Declare const one = 1. */",
    "/* @human Declare const two = 2. */",
    "",
  ].join(" ");
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = request.messages?.find((message) =>
        message.role === "system"
      )?.content ?? "";
      const user = request.messages?.find((message) =>
        message.role === "user"
      )?.content ?? "";
      let content: string;
      if (system.includes("Classify one @human")) {
        classificationRequests += 1;
        content = '{"action":"edit"}';
      } else {
        codingRequests += 1;
        const currentInstruction =
          user.match(/Current @human instruction:\n([^\n]+)/u)?.[1] ?? "";
        content = currentInstruction.includes("const one")
          ? "const one = 1;"
          : "const two = 2;";
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
      language: "javascript",
      languages: ["javascript"],
      provider: {
        name: "ollama",
        model: "changing-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: false,
        crossFileChecks: false,
        planning: { enabled: false },
      },
      compiler: { enabled: true },
    }));
    await put(root, "app.js", original);

    const receipt = await cli([root, "--dry-run"]);
    assert.equal(receipt.code, 0, receipt.stderr || receipt.stdout);
    assert.match(receipt.stdout, /Engine\s+: compiler \(isolated unit codegen/u);
    assert.match(
      receipt.stdout,
      /unit-local instruction, required inline file context, and selected model skills/u,
    );
    assert.doesNotMatch(receipt.stdout, /turn classification|ProjectMemory/u);

    const first = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: cache },
    );
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.equal(
      classificationRequests,
      0,
      "compiler mode treats every @human marker as source instead of asking an agent classifier",
    );
    assert.equal(codingRequests, 2);
    const firstBytes = await readFile(join(root, "app.js"), "utf8");
    assert.match(firstBytes, /const one = 1;/u);
    assert.match(firstBytes, /const two = 2;/u);

    await put(root, "app.js", original);
    const second = await cli(
      [root, "--yes", "--json"],
      { HUMAN_TO_CODE_CACHE: cache },
    );
    assert.equal(second.code, 0, second.stderr || second.stdout);
    const response = JSON.parse(second.stdout) as {
      replayed: string[];
      classificationRequests: number;
      codingRequests: number;
    };
    assert.deepEqual(response.replayed, ["app.js"]);
    assert.equal(response.classificationRequests, 0);
    assert.equal(response.codingRequests, 0);
    assert.equal(classificationRequests, 0);
    assert.equal(codingRequests, 2);
    assert.equal(await readFile(join(root, "app.js"), "utf8"), firstBytes);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("--init stays compiler-off in non-interactive mode and migrate-config upgrades legacy JSON", async () => {
  const initRoot = await mkdtemp(join(tmpdir(), "h2c-cli-init-compiler-"));
  const migrateRoot = await mkdtemp(join(tmpdir(), "h2c-cli-migrate-compiler-"));
  try {
    const initialized = await cli(["--init", initRoot]);
    assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
    const initialConfig = JSON.parse(
      await readFile(join(initRoot, "human-to-code.config.json"), "utf8"),
    ) as { compiler: { enabled: boolean } };
    assert.equal(initialConfig.compiler.enabled, false);

    await put(migrateRoot, "human-to-code.config.json", JSON.stringify({
      language: "javascript",
      filesToIgnore: ["vendor"],
      allowNonHumanFiles: false,
      provider: { name: "ollama", model: "fixture" },
    }));
    const migrated = await cli([
      "migrate-config",
      migrateRoot,
      "--compiler",
      "--json",
    ]);
    assert.equal(migrated.code, 0, migrated.stderr || migrated.stdout);
    const migratedConfig = JSON.parse(
      await readFile(join(migrateRoot, "human-to-code.config.json"), "utf8"),
    ) as {
      schemaVersion: number;
      compiler: { enabled: boolean };
    };
    assert.equal(migratedConfig.schemaVersion, 1);
    assert.equal(migratedConfig.compiler.enabled, true);
  } finally {
    await rm(initRoot, { recursive: true, force: true });
    await rm(migrateRoot, { recursive: true, force: true });
  }
});

test("unreachable cross-file CSS receives one bounded repair before atomic write", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-selector-repair-"));
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const user = parsed.messages.find((message) => message.role === "user")?.content ?? "";
      const content = system.includes("Classify one @human")
        ? '{"action":"edit"}'
        : system.includes("repairing previously generated code")
        ? ".hero-gradient { position: absolute; inset: 0; background: linear-gradient(red, blue); }"
        : system.includes("target: src/Hero.tsx")
          ? '<div className="hero-gradient" aria-hidden="true" />'
          : user.includes("Current @human instruction:\nadd container layout")
            ? "position: relative; overflow: hidden;"
            : ".hero-overlay.hero-gradient { background: linear-gradient(red, blue); }";
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
      languages: ["typescript", "css"],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
    }));
    await put(root, "src/Hero.tsx", [
      'import "./hero.css";',
      'export function Hero() { return <section className="hero-container hero-overlay">',
      "  {/* @human add gradient child */}",
      "</section>; }",
      "",
    ].join("\n"));
    await put(root, "src/hero.css", [
      ".hero-container {",
      "  /* @human add container layout */",
      "}",
      "/* @human add gradient class */",
      "",
    ].join("\n"));

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as { status: string; repairRequests: number; skipped: unknown[] };
    assert.equal(done.status, "DONE");
    assert.equal(done.repairRequests, 1);
    assert.deepEqual(done.skipped, []);
    assert.match(await readFile(join(root, "src/hero.css"), "utf8"), /\.hero-gradient \{ position: absolute; inset: 0;/u);
    assert.doesNotMatch(await readFile(join(root, "src/hero.css"), "utf8"), /\.hero-overlay\.hero-gradient/u);
    assert.match(await readFile(join(root, "src/Hero.tsx"), "utf8"), /className="hero-gradient"/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("unused generated CSS selector drift receives one bounded reconciliation pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-css-drift-repair-"));
  let repairs = 0;
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const content = system.includes("Classify one @human")
        ? '{"action":"edit"}'
        : system.includes("planning a shared contract")
        ? JSON.stringify({
            files: [
              { path: "src/Projects.tsx", responsibility: "Render the project grid." },
              { path: "src/portfolio.css", responsibility: "Style the project grid." },
            ],
            vocabulary: [
              { name: "project-grid", kind: "class", definedIn: "src/Projects.tsx", usedIn: ["src/portfolio.css"] },
            ],
          })
        : system.includes("repairing previously generated code")
        ? (repairs += 1, ".project-grid { display: grid; }")
        : system.includes("target: src/Projects.tsx")
          ? 'export default function Projects() { return <section className="project-grid" />; }'
          : ".projects-grid { display: grid; }";
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
      languages: ["typescript", "css"],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: { reconcileIntegrations: false },
    }));
    await put(root, "src/Projects.tsx", "/* @human render the project grid */\n");
    await put(root, "src/portfolio.css", "/* @human style the project grid */\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as { repairRequests: number; skipped: unknown[] };
    const writtenCss = await readFile(join(root, "src/portfolio.css"), "utf8");
    assert.equal(done.repairRequests, 1, result.stdout);
    assert.equal(repairs, 1);
    assert.deepEqual(done.skipped, []);
    assert.match(writtenCss, /\.project-grid/u);
    assert.doesNotMatch(writtenCss, /\.projects-grid/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
      // This test is about language inference, so the receipt is pinned to the
      // pre-reconciliation shape; the default-on receipt is covered separately.
      direct: { reconcileIntegrations: false },
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
    // Planning is on by default; reconciliation is pinned off above, so the
    // JavaScript repair allowance still shows alongside the planning breakdown.
    assert.match(receipt.stdout, /7 planned \(1 shared contract, 3 per-target todo, 3 coding\) \(up to 1 extra bounded repair request for JavaScript\)/u);
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
      // Subject here is the TypeScript-check policy for plain JS, so the exact
      // request count is pinned to generation only.
      direct: { reconcileIntegrations: false },
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
    // 1 blueprint + 3 todo + 3 coding. This stub answers every request with
    // markup, so both planning parses fail and each unit falls back to a single
    // coding pass — which is exactly the graceful-degradation path.
    assert.equal(requests, 7);
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
    // With cross-file reconciliation on by default the incomplete group is
    // rejected first and names the sibling that failed; with it off the batch
    // is withheld later. Either way no file is written and both units skip.
    assert.ok(done.skipped.some(({ reason }) =>
      /whole-file conversion batch was withheld|cross-file integration group is incomplete|related conversion group was withheld/u.test(reason)));
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
    // 1 shared contract + 3 todo + 3 coding, disclosed before confirmation.
    assert.match(receipt.stdout, /Requests\s+: 7 planned \(1 shared contract, 3 per-target todo, 3 coding\)/u);
    assert.match(receipt.stdout, /Additional: up to 3 completion request\(s\), only for targets whose todo list is not fully covered/u);
    assert.match(receipt.stdout, /Additional: cross-file reconciliation may issue up to 6 bounded audit requests and 3 target-repair requests/u);
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
    // 6 pre-planning requests (3 coding + 3 integration) plus 1 blueprint and
    // 3 todo requests. This stub answers planning requests with code, so both
    // parses fail and generation stays single-pass.
    assert.equal(requests, 10);
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

// Schema v1 accepts the alpha provider names, and the generation client routes
// everything that is not `openai` down its Ollama branch. Without an explicit
// refusal, `"name": "anthropic"` reached http://localhost:11434/api/chat and
// answered with whatever model was listening there.
test("a configured provider with no adapter is refused instead of using the Ollama endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-no-adapter-"));
  try {
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      provider: { name: "anthropic", model: "claude-opus-4-5" },
      privacy: { remoteProviderConsent: true },
    }));
    await put(root, "api.human", "Write a health function.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { status: string; diagnostic: string };
    assert.equal(output.status, "ERROR");
    assert.match(output.diagnostic, /has no adapter in this release/u);
    await assert.rejects(access(join(root, "api.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning agrees a shared vocabulary and completes an incomplete first pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-planning-"));
  const seen: string[] = [];
  let cssCodingRequests = 0;
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const user = parsed.messages.find((message) => message.role === "user")?.content ?? "";
      let content: string;
      if (system.includes("planning a shared contract")) {
        seen.push("blueprint");
        content = JSON.stringify({
          files: [
            { path: "index.html", responsibility: "Structure." },
            { path: "styles.css", responsibility: "Presentation." },
          ],
          vocabulary: [
            { name: "project-card", kind: "class", definedIn: "index.html", usedIn: ["styles.css"] },
          ],
        });
      } else if (system.includes("A separate later request will write the code")) {
        seen.push(`todo:${system.includes("styles.css") ? "css" : "html"}`);
        content = system.includes("styles.css")
          ? JSON.stringify({
              todos: [
                { id: "T1", requirement: "Card rule.", expects: { kind: "class", names: ["project-card"] } },
                { id: "T2", requirement: "Breakpoints.", expects: { kind: "selector", names: ["media"] } },
              ],
            })
          : JSON.stringify({
              todos: [{ id: "T1", requirement: "Card markup.", expects: { kind: "class", names: ["project-card"] } }],
            });
      } else if (system.includes("target: index.html")) {
        seen.push("code:html");
        content = '<link rel="stylesheet" href="styles.css"><article class="project-card">Hi</article>';
      } else {
        cssCodingRequests += 1;
        seen.push(`code:css:${cssCodingRequests}`);
        // First pass deliberately omits the breakpoints T2 asked for; the
        // refinement adds them without losing the card rule.
        content = cssCodingRequests === 1
          ? ".project-card{display:flex}"
          : ".project-card{display:flex}\n@media (max-width:600px){.project-card{display:block}}";
      }
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: { content } }));
      void user;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "css"],
      humanFileExtensions: [
        { path: "index.human", extension: "html" },
        { path: "styles.human", extension: "css" },
      ],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: { reconcileIntegrations: false },
    }));
    await put(root, "index.human", "Build a card list.\n");
    await put(root, "styles.human", "Style the cards responsively.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as {
      written: string[];
      blueprintRequests: number;
      todoRequests: number;
      codingRequests: number;
      referenceFindings: Array<{ code: string }>;
    };
    assert.deepEqual(done.written, ["index.html", "styles.css"]);
    assert.equal(done.blueprintRequests, 1);
    assert.equal(done.todoRequests, 2);
    // 2 first passes plus exactly one refinement for the incomplete stylesheet.
    assert.equal(done.codingRequests, 3);
    assert.equal(seen.filter((entry) => entry === "blueprint").length, 1);
    assert.equal(cssCodingRequests, 2);

    const css = await readFile(join(root, "styles.css"), "utf8");
    assert.match(css, /@media/u, "the refinement must add the missing breakpoints");
    assert.match(css, /project-card/u, "the refinement must keep the first pass's rule");
    const html = await readFile(join(root, "index.html"), "utf8");
    assert.match(html, /project-card/u, "markup must use the agreed shared name");
    assert.deepEqual(done.referenceFindings, [], "agreed vocabulary must leave no drift");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("planning.enabled false restores exactly one request per unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-cli-planning-off-"));
  let requests = 0;
  const systems: string[] = [];
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      systems.push(parsed.messages.find((message) => message.role === "system")?.content ?? "");
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ message: { content: ".project-card{display:flex}" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["css"],
      humanFileExtensions: [
        { path: "a.human", extension: "css" },
        { path: "b.human", extension: "css" },
      ],
      provider: {
        name: "ollama",
        model: "fixture-model",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: { reconcileIntegrations: false, planning: { enabled: false } },
    }));
    await put(root, "a.human", "Style the cards.\n");
    await put(root, "b.human", "Style the footer.\n");

    const receipt = await cli([root, "--dry-run"]);
    assert.match(receipt.stdout, /Requests\s+: 2 planned/u);
    assert.match(receipt.stdout, /Engine\s+: direct \(one model request per prompt/u);
    assert.doesNotMatch(receipt.stdout, /shared contract|per-target todo/u);

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const done = JSON.parse(result.stdout) as {
      written: string[]; blueprintRequests: number; todoRequests: number; codingRequests: number;
    };
    assert.deepEqual(done.written, ["a.css", "b.css"]);
    assert.equal(requests, 2);
    assert.equal(done.blueprintRequests, 0);
    assert.equal(done.todoRequests, 0);
    assert.equal(done.codingRequests, 2);
    assert.ok(systems.every((system) => !system.includes("planning a shared contract")));
    assert.ok(systems.every((system) => !system.includes("A separate later request will write the code")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
