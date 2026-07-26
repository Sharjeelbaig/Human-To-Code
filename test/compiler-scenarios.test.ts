import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { buildDirectConversionPrompt } from "../src/prompts/direct-conversion.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("code generation explicitly translates pseudocode into the selected language", () => {
  const prompt = buildDirectConversionPrompt({
    languageLabel: "TypeScript",
    targetPath: "gcd.ts",
    instruction: "fn gcd(a, b) -> integer",
    inline: false,
  });
  assert.match(prompt.system, /pseudocode, prose algorithms/u);
  assert.match(
    prompt.system,
    /Translate them completely into valid TypeScript/u,
  );
  assert.match(prompt.system, /Preserve explicit requirements such as export/u);
  assert.match(
    prompt.user,
    /fn gcd\(a, b\) -> number/u,
  );
  assert.doesNotMatch(prompt.user, /-> integer/u);
  const retry = buildDirectConversionPrompt({
    languageLabel: "JavaScript",
    targetPath: "solution.js",
    instruction: "Export function solve.",
    inline: false,
    rejectedDraft: "function solve() {}",
    validationFailure: "solution.js: missing export and empty-input guard",
  });
  assert.match(
    retry.user,
    /MANDATORY CORRECTION: solution\.js: missing export and empty-input guard/u,
  );
  assert.match(retry.user, /fix every listed violation/u);
  const html = buildDirectConversionPrompt({
    languageLabel: "HTML",
    targetPath: "page.html",
    instruction: 'Create a main landmark with id="app".',
    inline: false,
  });
  assert.match(html.user, /<main id="app">/u);
  assert.match(html.user, /putting that id on `<body>` does not satisfy/u);
  const rust = buildDirectConversionPrompt({
    languageLabel: "Rust",
    targetPath: "search.rs",
    instruction: "Publish function binary_search for a sorted slice.",
    inline: false,
  });
  assert.match(rust.user, /literal `pub fn`/u);
  assert.match(rust.user, /guard `values\.is_empty\(\)` first/u);
});

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function cli(
  root: string,
  cache: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, root, "--compiler", "--yes", "--json"],
      {
        cwd: dirname(CLI),
        env: {
          ...process.env,
          HUMAN_TO_CODE_CACHE: cache,
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr })
    );
  });
}

test("compiler mode is byte-deterministic across web, algorithm, pseudocode, and Rust scenarios", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-compiler-scenarios-"));
  const artifactCache = await mkdtemp(
    join(tmpdir(), "h2c-compiler-scenarios-cache-"),
  );
  const emptyCache = await mkdtemp(
    join(tmpdir(), "h2c-compiler-scenarios-empty-cache-"),
  );
  const outputs: Readonly<Record<string, string>> = {
    "page.html": [
      '<main id="app">',
      "  <h1>Deterministic compiler</h1>",
      "</main>",
    ].join("\n"),
    "two-sum.js": [
      "export function twoSum(values, target) {",
      "  const seen = new Map();",
      "  for (let index = 0; index < values.length; index += 1) {",
      "    const complement = target - values[index];",
      "    if (seen.has(complement)) return [seen.get(complement), index];",
      "    seen.set(values[index], index);",
      "  }",
      "  return [];",
      "}",
    ].join("\n"),
    "gcd.ts": [
      "export function gcd(left: number, right: number): number {",
      "  let a = Math.abs(left);",
      "  let b = Math.abs(right);",
      "  while (b !== 0) [a, b] = [b, a % b];",
      "  return a;",
      "}",
    ].join("\n"),
    "divisible-pairs.py": [
      "def divisible_pairs(values, divisor):",
      "    return sum(",
      "        1",
      "        for left in range(len(values))",
      "        for right in range(left + 1, len(values))",
      "        if (values[left] + values[right]) % divisor == 0",
      "    )",
    ].join("\n"),
    "binary-search.rs": [
      "pub fn binary_search(values: &[i32], target: i32) -> Option<usize> {",
      "    let mut low = 0;",
      "    let mut high = values.len();",
      "    while low < high {",
      "        let middle = low + (high - low) / 2;",
      "        match values[middle].cmp(&target) {",
      "            std::cmp::Ordering::Less => low = middle + 1,",
      "            std::cmp::Ordering::Greater => high = middle,",
      "            std::cmp::Ordering::Equal => return Some(middle),",
      "        }",
      "    }",
      "    None",
      "}",
    ].join("\n"),
  };
  let requests = 0;
  const compilerPrompts: string[] = [];
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", () => {
      requests += 1;
      const request = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      compilerPrompts.push(
        request.messages?.map((message) => message.content ?? "").join("\n")
          ?? "",
      );
      const system = request.messages?.find((message) =>
        message.role === "system"
      )?.content ?? "";
      const target = system.match(
        /responsible for exactly one target: ([^\n]+)\.\n/u,
      )?.[1];
      const content = target === undefined ? undefined : outputs[target];
      outgoing.writeHead(content === undefined ? 400 : 200, {
        "content-type": "application/json",
      });
      outgoing.end(JSON.stringify({
        message: { content: content ?? "unknown target" },
      }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      language: "typescript",
      languages: ["html", "javascript", "typescript", "python", "rust"],
      provider: {
        name: "ollama",
        model: "scenario-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: true,
        crossFileChecks: true,
        planning: {
          enabled: true,
          projectBlueprint: true,
          fileTodo: true,
          maxCodingPassesPerUnit: 3,
        },
      },
      compiler: {
        enabled: true,
        semanticDiagnostics: false,
      },
    }));
    await put(
      root,
      "page.html.human",
      "Create an HTML main landmark with id app containing an h1 whose exact text is Deterministic compiler.",
    );
    await put(
      root,
      "two-sum.js.human",
      "Implement twoSum(values, target) with a Map; return the two zero-based indices or an empty array.",
    );
    await put(
      root,
      "gcd.ts.human",
      [
        "Compile this pseudocode to TypeScript:",
        "fn gcd(a, b) -> number",
        "  a = abs(a)",
        "  b = abs(b)",
        "  while b != 0: (a, b) = (b, a mod b)",
        "  return a",
      ].join("\n"),
    );
    await put(
      root,
      "divisible-pairs.py.human",
      "Given input integer array values and positive divisor, count pairs i < j whose sum is divisible by divisor.",
    );
    await put(
      root,
      "binary-search.rs.human",
      "In Rust implement binary_search over a sorted &[i32]; return Some(index) when target exists and None otherwise.",
    );

    const first = await cli(root, artifactCache);
    assert.equal(first.code, 0, first.stderr || first.stdout);
    const firstResult = JSON.parse(first.stdout) as {
      written: string[];
      codingRequests: number;
      blueprintRequests: number;
      todoRequests: number;
      integrationAuditRequests: number;
      integrationRepairRequests: number;
    };
    assert.equal(firstResult.codingRequests, Object.keys(outputs).length);
    assert.equal(firstResult.blueprintRequests, 0);
    assert.equal(firstResult.todoRequests, 0);
    assert.equal(firstResult.integrationAuditRequests ?? 0, 0);
    assert.equal(firstResult.integrationRepairRequests ?? 0, 0);
    assert.ok(
      compilerPrompts.every((prompt) =>
        /<SELECTED_SKILLS>/u.test(prompt)
        && !/<PROJECT_MEMORY>|<SESSION_MEMORY>|<TODO_LIST>/u.test(prompt)
      ),
      "compiler requests must include selected skills but no project/session/planning context",
    );
    assert.deepEqual([...firstResult.written].sort(), Object.keys(outputs).sort());
    assert.equal(requests, Object.keys(outputs).length);

    const firstBytes = new Map<string, string>();
    for (const [path, expected] of Object.entries(outputs)) {
      const content = await readFile(join(root, path), "utf8");
      assert.equal(content, `${expected}\n`);
      firstBytes.set(path, content);
    }

    const withoutArtifacts = await cli(root, emptyCache);
    assert.equal(
      withoutArtifacts.code,
      0,
      withoutArtifacts.stderr || withoutArtifacts.stdout,
    );
    const coldResult = JSON.parse(withoutArtifacts.stdout) as {
      replayed: string[];
      codingRequests: number;
    };
    assert.equal(coldResult.codingRequests, 0);
    assert.deepEqual([...coldResult.replayed].sort(), Object.keys(outputs).sort());
    assert.equal(requests, Object.keys(outputs).length);

    for (const path of Object.keys(outputs)) {
      await put(root, path, `locally modified ${path}\n`);
    }
    const restored = await cli(root, artifactCache);
    assert.equal(restored.code, 0, restored.stderr || restored.stdout);
    const restoredResult = JSON.parse(restored.stdout) as {
      replayed: string[];
      codingRequests: number;
    };
    assert.equal(restoredResult.codingRequests, 0);
    assert.deepEqual(
      [...restoredResult.replayed].sort(),
      Object.keys(outputs).sort(),
    );
    assert.equal(requests, Object.keys(outputs).length);
    for (const path of Object.keys(outputs)) {
      assert.equal(await readFile(join(root, path), "utf8"), firstBytes.get(path));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await rm(root, { recursive: true, force: true });
    await rm(artifactCache, { recursive: true, force: true });
    await rm(emptyCache, { recursive: true, force: true });
  }
});
