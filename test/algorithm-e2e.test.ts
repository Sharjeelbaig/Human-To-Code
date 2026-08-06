import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dirname(CLI),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
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

function ollamaResponse(request: Record<string, unknown>, content: string): string {
  return JSON.stringify({
    model: typeof request.model === "string" ? request.model : "algorithm-fixture",
    done: true,
    done_reason: "stop",
    message: { content },
    prompt_eval_count: 8,
    eval_count: Math.max(1, Math.ceil(content.length / 4)),
  });
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("compiler mode generates and executes complete .human algorithm solutions", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-algorithm-human-"));
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown> & {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = request.messages?.find((message) => message.role === "system")?.content ?? "";
      const target = system.match(/responsible for exactly one target: ([^\n]+)\./u)?.[1];
      const outputs: Record<string, string> = {
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
        "reverse.py": [
          "def reverse_words(value):",
          "    return \" \".join(reversed(value.split()))",
        ].join("\n"),
      };
      const content = target === undefined ? "" : outputs[target] ?? "";
      outgoing.writeHead(content.length > 0 ? 200 : 400, { "content-type": "application/json" });
      outgoing.end(ollamaResponse(request, content));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "package.json", '{"type":"module"}\n');
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["javascript", "python"],
      provider: {
        name: "ollama",
        model: "algorithm-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: { reconcileIntegrations: false, crossFileChecks: false },
      compiler: { enabled: true, lockfile: false, replayFromLock: false },
    }));
    await put(root, "two-sum.js.human", "Implement twoSum(values, target): return the two zero-based indices whose values sum to target, or an empty array.\n");
    await put(root, "reverse.py.human", "Implement reverse_words(value): reverse the order of words while preserving each word's spelling.\n");

    const result = await cli([root, "--compiler", "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout) as { written: string[]; codingRequests: number };
    assert.deepEqual(receipt.written.sort(), ["reverse.py", "two-sum.js"]);
    assert.equal(receipt.codingRequests, 2);
    assert.equal(await readFile(join(root, "two-sum.js"), "utf8"), [
      "export function twoSum(values, target) {",
      "  const seen = new Map();",
      "  for (let index = 0; index < values.length; index += 1) {",
      "    const complement = target - values[index];",
      "    if (seen.has(complement)) return [seen.get(complement), index];",
      "    seen.set(values[index], index);",
      "  }",
      "  return [];",
      "}",
      "",
    ].join("\n"));
    assert.equal(await readFile(join(root, "reverse.py"), "utf8"), [
      "def reverse_words(value):",
      "    return \" \".join(reversed(value.split()))",
      "",
    ].join("\n"));

    await put(root, "check.mjs", [
      "import assert from 'node:assert/strict';",
      "import { twoSum } from './two-sum.js';",
      "assert.deepEqual(twoSum([2, 7, 11, 15], 9), [0, 1]);",
      "assert.deepEqual(twoSum([3, 3], 6), [0, 1]);",
      "assert.deepEqual(twoSum([1, 2], 8), []);",
    ].join("\n"));
    const js = await runCommand(process.execPath, ["check.mjs"], root);
    assert.equal(js.code, 0, js.stderr || js.stdout);
    const py = await runCommand("python3", ["-c", "from reverse import reverse_words; assert reverse_words('one two three') == 'three two one'; assert reverse_words('') == ''"], root);
    assert.equal(py.code, 0, py.stderr || py.stdout);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a half-written //@human marker fills an algorithm body without rewriting its function", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-algorithm-marker-"));
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown> & {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: unknown[];
      };
      const system = request.messages?.find((message) => message.role === "system")?.content ?? "";
      outgoing.writeHead(200, { "content-type": "application/json" });
      if (system.includes("Classify one @human")) {
        outgoing.end(ollamaResponse(request, '{"action":"edit","mode":"replace","startLine":2,"endLine":2}'));
        return;
      }
      if (request.tools?.some((tool) => JSON.stringify(tool).includes("replace_selected_code"))) {
        outgoing.end(JSON.stringify({
          model: "algorithm-fixture",
          done: true,
          done_reason: "tool_call",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "reverse-edit",
              type: "function",
              function: {
                name: "replace_selected_code",
                arguments: {
                  path: "reverse.js",
                  newText: "return value.split('').reverse().join('');",
                },
              },
            }],
          },
          prompt_eval_count: 8,
          eval_count: 4,
        }));
        return;
      }
      outgoing.end(ollamaResponse(request, "return value.split('').reverse().join('');"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "package.json", '{"type":"module"}\n');
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["javascript"],
      provider: {
        name: "ollama",
        model: "algorithm-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: false,
        crossFileChecks: false,
        planning: { enabled: false },
      },
      compiler: { enabled: false },
    }));
    await put(root, "reverse.js", [
      "export function reverse(value) {",
      "  return value; //@human reverse the string here and return the result",
      "}",
      "",
    ].join("\n"));

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(await readFile(join(root, "reverse.js"), "utf8"), [
      "export function reverse(value) {",
      "  return value.split('').reverse().join('');",
      "}",
      "",
    ].join("\n"));
    await put(root, "check.mjs", [
      "import assert from 'node:assert/strict';",
      "import { reverse } from './reverse.js';",
      "assert.equal(reverse('abcd'), 'dcba');",
      "assert.equal(reverse(''), '');",
    ].join("\n"));
    const check = await runCommand(process.execPath, ["check.mjs"], root);
    assert.equal(check.code, 0, check.stderr || check.stdout);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("the default direct engine generates and executes a complete LeetCode-style .human file", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-algorithm-direct-human-"));
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown> & {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const content = [
        "export function maxSubarray(values) {",
        "  let best = -Infinity;",
        "  let ending = 0;",
        "  for (const value of values) {",
        "    ending = Math.max(value, ending + value);",
        "    best = Math.max(best, ending);",
        "  }",
        "  return best;",
        "}",
      ].join("\n");
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(ollamaResponse(request, content));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "package.json", '{"type":"module"}\n');
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["javascript"],
      provider: {
        name: "ollama",
        model: "algorithm-fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        trustCustomEndpoint: true,
      },
      direct: {
        reconcileIntegrations: false,
        crossFileChecks: false,
        planning: { enabled: false },
      },
      compiler: { enabled: false },
    }));
    await put(root, "max-subarray.js.human", "Implement maxSubarray(values): return the largest sum of any non-empty contiguous subarray, including the all-negative case.\n");

    const result = await cli([root, "--yes", "--json"]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(await readFile(join(root, "max-subarray.js"), "utf8"), [
      "export function maxSubarray(values) {",
      "  let best = -Infinity;",
      "  let ending = 0;",
      "  for (const value of values) {",
      "    ending = Math.max(value, ending + value);",
      "    best = Math.max(best, ending);",
      "  }",
      "  return best;",
      "}",
      "",
    ].join("\n"));
    await put(root, "check.mjs", [
      "import assert from 'node:assert/strict';",
      "import { maxSubarray } from './max-subarray.js';",
      "assert.equal(maxSubarray([-2, 1, -3, 4, -1, 2, 1, -5, 4]), 6);",
      "assert.equal(maxSubarray([-8, -3, -6, -2, -5, -4]), -2);",
      "assert.equal(maxSubarray([5]), 5);",
    ].join("\n"));
    const check = await runCommand(process.execPath, ["check.mjs"], root);
    assert.equal(check.code, 0, check.stderr || check.stdout);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
