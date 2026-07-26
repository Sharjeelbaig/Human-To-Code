/**
 * TypeScript evaluation runner: does the generated code actually work?
 *
 * For every (model, task) pair this creates a real project, runs the real CLI
 * against a real provider, and then scores the result in three escalating steps:
 *
 *   written    the CLI wrote the target and left no `@human` marker behind
 *   typechecks `tsc` accepts the project under strict settings
 *   behaves    the compiled output runs and the task's assertions all hold
 *
 * Only `behaves` counts as a pass. Nothing here inspects the code or asks a model
 * to judge it — a score is an execution result, which is the only kind of
 * evidence the certification contract in src/llms/certification.ts accepts.
 *
 * Usage:
 *   node test/eval/run.mjs --models qwen2.5-coder:1.5b,gemma3:270m
 *   node test/eval/run.mjs --models qwen2.5-coder:1.5b --runs 3
 *   node test/eval/run.mjs --models qwen2.5-coder:1.5b --filter stack
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EVAL_TSCONFIG, TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CLI = join(REPO, "dist", "cli.js");
const TSC = join(REPO, "node_modules", ".bin", "tsc");

const MARKER = /(?:^|[^A-Za-z0-9])@human(?:\s|$)/u;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < 512_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 512_000) stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: signal === "SIGKILL" });
    });
  });
}

async function scoreOnce(model, task) {
  const root = await mkdtemp(join(tmpdir(), "h2c-eval-"));
  const started = Date.now();
  try {
    for (const [path, content] of Object.entries(task.files)) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
    await writeFile(join(root, "tsconfig.json"), EVAL_TSCONFIG, "utf8");
    await writeFile(
      join(root, "human-to-code.config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        languages: ["typescript"],
        provider: { name: "ollama", model },
        budgets: { timeoutMs: 300_000 },
      }, null, 2)}\n`,
      "utf8",
    );

    const cli = await run(process.execPath, [CLI, root, "--yes"], {
      cwd: root,
      timeoutMs: 600_000,
    });

    // 1. written — the target exists and carries no marker the tool left behind.
    let produced = "";
    try {
      produced = await readFile(join(root, task.target), "utf8");
    } catch {
      return {
        written: false, typechecks: false, behaves: false,
        durationMs: Date.now() - started,
        detail: cli.timedOut ? "cli timed out" : firstSkip(cli.stdout) || `cli exit ${cli.code}`,
      };
    }
    if (produced.trim().length === 0 || MARKER.test(produced)) {
      return {
        written: false, typechecks: false, behaves: false,
        durationMs: Date.now() - started,
        detail: "target still holds a marker or is empty",
      };
    }

    // The oracle is added only now, so it never becomes conversion input.
    await writeFile(join(root, "check.ts"), task.check, "utf8");

    // 2. typechecks — strict tsc over the generated project plus the oracle.
    const compiled = await run(TSC, ["-p", "tsconfig.json"], { cwd: root, timeoutMs: 180_000 });
    if (compiled.code !== 0) {
      return {
        written: true, typechecks: false, behaves: false,
        durationMs: Date.now() - started,
        detail: firstLine(compiled.stdout) || firstLine(compiled.stderr) || "tsc failed",
      };
    }

    // 3. behaves — run it. Assertions throw, so a clean exit is the pass.
    const executed = await run(process.execPath, [join(root, "dist", "check.js")], {
      cwd: root,
      timeoutMs: 60_000,
    });
    return {
      written: true,
      typechecks: true,
      behaves: executed.code === 0,
      durationMs: Date.now() - started,
      detail: executed.code === 0 ? "" : firstLine(executed.stderr) || `check exit ${executed.code}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function firstLine(text) {
  return (text ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function firstSkip(stdout) {
  return (stdout ?? "").split("\n").find((line) => line.includes("skipped"))?.trim() ?? "";
}

function pct(part, whole) {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      models: { type: "string" },
      runs: { type: "string" },
      filter: { type: "string" },
      report: { type: "string" },
    },
  });

  const models = (values.models ?? "qwen2.5-coder:1.5b").split(",").map((m) => m.trim()).filter(Boolean);
  const runs = Math.max(1, Number(values.runs ?? 1));
  const tasks = values.filter
    ? TASKS.filter((task) => task.id.includes(values.filter))
    : TASKS;

  process.stderr.write(
    `evaluating ${models.length} model(s) x ${tasks.length} task(s) x ${runs} run(s)\n\n`,
  );

  const results = [];
  for (const model of models) {
    let written = 0;
    let typechecks = 0;
    let behaves = 0;
    let total = 0;
    const started = Date.now();
    process.stderr.write(`${model}\n`);
    for (const task of tasks) {
      const outcomes = [];
      for (let index = 0; index < runs; index += 1) {
        const outcome = await scoreOnce(model, task);
        outcomes.push(outcome);
        total += 1;
        if (outcome.written) written += 1;
        if (outcome.typechecks) typechecks += 1;
        if (outcome.behaves) behaves += 1;
        results.push({ model, task: task.id, run: index + 1, ...outcome });
      }
      const passes = outcomes.filter((outcome) => outcome.behaves).length;
      const mark = passes === runs ? "pass" : passes === 0 ? "FAIL" : `${passes}/${runs}`;
      const worst = outcomes.find((outcome) => !outcome.behaves);
      process.stderr.write(
        `  ${mark.padEnd(5)} ${task.id.padEnd(28)}`
        + `${worst?.detail ? ` ${worst.detail.slice(0, 92)}` : ""}\n`,
      );
    }
    process.stderr.write(
      `  -> written ${pct(written, total)}  typechecks ${pct(typechecks, total)}`
      + `  BEHAVES ${pct(behaves, total)}  (${((Date.now() - started) / 1000).toFixed(0)}s)\n\n`,
    );
  }

  const summary = models.map((model) => {
    const own = results.filter((entry) => entry.model === model);
    return {
      model,
      runs: own.length,
      written: own.filter((entry) => entry.written).length,
      typechecks: own.filter((entry) => entry.typechecks).length,
      behaves: own.filter((entry) => entry.behaves).length,
    };
  });

  process.stderr.write("model                       written  typechecks  behaves\n");
  for (const row of summary) {
    process.stderr.write(
      `${row.model.padEnd(26)} ${pct(row.written, row.runs).padStart(7)}`
      + ` ${pct(row.typechecks, row.runs).padStart(11)}`
      + ` ${pct(row.behaves, row.runs).padStart(8)}\n`,
    );
  }

  const reportPath = values.report ?? join(HERE, "last-eval.json");
  await writeFile(reportPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
  process.stderr.write(`\nreport written to ${reportPath}\n`);
}

await main();
