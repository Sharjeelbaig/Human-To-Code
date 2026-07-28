/**
 * Stress-corpus runner.
 *
 * Every scenario gets its own temporary project, its own scripted model
 * endpoint, and its own CLI process, then is judged against stability
 * invariants only. Whether the generated code is *good* is out of scope and
 * unknowable here; whether the CLI stayed within its documented contract is
 * exactly what this measures.
 *
 * Usage:
 *   node test/stress/run.mjs                  all 450 scenarios
 *   node test/stress/run.mjs --mode direct    only the 350 direct scenarios
 *   node test/stress/run.mjs --filter ts-lru  substring match on scenario name
 *   node test/stress/run.mjs --concurrency 4
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startMockModel } from "./mock-model.mjs";
import {
  allScenarios,
  directScenarios,
  compilerScenarios,
  COMPILER_SCENARIO_COUNT,
  DIRECT_SCENARIO_COUNT,
} from "./corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CLI = join(REPO, "dist", "cli.js");

/** Documented exit codes, from the CLI's own help text. */
const DOCUMENTED_EXIT_CODES = new Set([0, 1, 3, 4, 5, 6]);

/** Substrings that only ever appear when an unexpected exception escaped. */
const CRASH_SIGNATURES = [
  "TypeError:",
  "ReferenceError:",
  "RangeError:",
  "SyntaxError:",
  "Cannot read properties",
  "Cannot read property",
  "is not a function",
  "is not iterable",
  "ERR_UNHANDLED_REJECTION",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_STRING_TOO_LONG",
  "ERR_OUT_OF_RANGE",
  "AssertionError",
  "Invalid string length",
  "JavaScript heap out of memory",
  "MaxListenersExceededWarning",
  "DeprecationWarning",
  "UnhandledPromiseRejection",
  "at async ",
  "at Object.",
];

const LIVE_MARKER = /(?:^|[^A-Za-z0-9])@human(?:\s|$)/u;

async function walk(root, base = root, found = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(full, base, found);
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
    // Symlinks are deliberately not listed: reading through one reports the
    // target's bytes under a second path, which would look like content the run
    // wrote. Fixtures use them only to check that discovery refuses them.
  }
  return found;
}

async function materialize(root, scenario, baseUrl) {
  for (const [path, content] of Object.entries(scenario.files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  for (const [path, target] of Object.entries(scenario.symlinks ?? {})) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await symlink(target, full).catch(() => undefined);
  }
  // The endpoint is only known once the scripted server has a port, so it is
  // written into the config rather than passed as a flag.
  const config = {
    ...scenario.config,
    provider: { ...scenario.config.provider, baseUrl },
  };
  await writeFile(
    join(root, "human-to-code.config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  // chmod last: a read-only fixture must still have been writable to create.
  for (const [path, mode] of Object.entries(scenario.chmod ?? {})) {
    await chmod(join(root, path), mode).catch(() => undefined);
  }
}

function runCli(root, argv, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, root, ...argv], {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: "1",
        CI: "1",
        HUMAN_TO_CODE_STRESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let hardKilled = false;
    const cap = 4 * 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    const softTimer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // A process that ignores SIGTERM is itself a finding.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          hardKilled = true;
          child.kill("SIGKILL");
        }
      }, 2_000).unref?.();
    }, killAfterMs);
    const started = Date.now();
    child.on("error", (error) => {
      clearTimeout(softTimer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nspawn error: ${error.message}`,
        killed,
        hardKilled,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(softTimer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        killed,
        hardKilled,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * A target language's own parser reporting on a candidate is the tool working:
 * behaviors like `windows-paths` append a `//` comment to Python on purpose, and
 * catching that is the point. Such a diagnostic is quoted in the CLI's own
 * framing, so drop the quoted message before hunting for escaped exceptions.
 */
const REPORTED_DIAGNOSTIC = /(?:failed syntax validation|failed import validation): [^\n]*/gu;

function withoutReportedDiagnostics(output) {
  return output.replace(REPORTED_DIAGNOSTIC, "<reported candidate diagnostic>");
}

/** Everything the corpus treats as a stability defect, with a stable id. */
function judge(scenario, run, files, contents, mock) {
  const findings = [];
  const add = (id, detail) => findings.push({ id, detail });
  const combined = `${run.stdout}\n${run.stderr}`;

  if (run.killed) {
    add("HANG", `no exit within the budget (${run.durationMs}ms), SIGTERM sent${run.hardKilled ? ", then SIGKILL" : ""}`);
  }
  if (run.hardKilled) add("IGNORED_SIGTERM", "process needed SIGKILL");
  if (!run.killed && run.code === null) {
    add("SIGNAL_EXIT", `terminated by signal ${run.signal}`);
  }
  if (run.code !== null && !DOCUMENTED_EXIT_CODES.has(run.code)) {
    add("UNDOCUMENTED_EXIT", `exit code ${run.code} is not in the documented set`);
  }
  if (run.code === 6) {
    add("INTERNAL_ERROR", `exit 6 (internal error): ${firstLine(run.stderr) || firstLine(run.stdout)}`);
  }
  const scannable = withoutReportedDiagnostics(combined);
  for (const signature of CRASH_SIGNATURES) {
    if (scannable.includes(signature)) {
      add("CRASH_SIGNATURE", `${signature} — ${nearby(scannable, signature)}`);
      break;
    }
  }
  if (mock.requests.length > 300) {
    add("RUNAWAY_REQUESTS", `${mock.requests.length} provider requests issued`);
  }

  // Fail-closed: a failed run must not have destroyed the request it was given.
  const sources = Object.keys(scenario.files).filter(
    (path) => path.endsWith(".human") || scenario.files[path].includes("@human"),
  );
  if (run.code !== 0) {
    for (const source of sources) {
      if (!files.includes(source)) {
        add("SOURCE_LOST", `${source} disappeared on a non-zero exit`);
      }
    }
  }

  // Litter: temporary and backup artifacts must never survive the run.
  for (const path of files) {
    const name = path.split(sep).pop() ?? path;
    if (/\.tmp$|\.tmp\.|~$|\.bak$|^\.human-to-code-tmp/u.test(name)) {
      add("LITTER", `temporary artifact left behind: ${path}`);
    }
  }

  // A written file that still contains a live marker re-triggers forever.
  for (const [path, content] of Object.entries(contents)) {
    if (LIVE_MARKER.test(content) && !path.endsWith(".human")) {
      const wasThereBefore = LIVE_MARKER.test(scenario.files[path] ?? "");
      if (!wasThereBefore) {
        add("MARKER_REINJECTED", `${path} contains a live @human marker the run wrote`);
      }
    }
  }

  return findings;
}

function firstLine(text) {
  return (text ?? "").split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function nearby(text, needle) {
  const at = text.indexOf(needle);
  return text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/gu, " ").trim();
}

async function runScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), "h2c-stress-"));
  const mock = await startMockModel(scenario);
  try {
    await materialize(root, scenario, mock.baseUrl);
    // `budgets.timeoutMs` bounds each provider request, so a fixture with many
    // targets legitimately spends it once per target before finishing.
    const targets = Object.keys(scenario.files).length;
    const budget = Number(process.env.HUMAN_TO_CODE_STRESS_BUDGET_MS)
      || (scenario.behavior === "hang" ? 20_000 + targets * 3_000 : 45_000);
    const run = await runCli(root, scenario.argv, budget);
    const files = await walk(root);
    const contents = {};
    for (const path of files) {
      if (path === "human-to-code.config.json") continue;
      try {
        const info = await stat(join(root, path));
        if (info.size > 512 * 1024) continue;
        contents[path] = await readFile(join(root, path), "utf8");
      } catch {
        /* unreadable files are reported through other findings */
      }
    }
    const findings = judge(scenario, run, files, contents, mock);
    return {
      name: scenario.name,
      mode: scenario.mode,
      problemId: scenario.problemId,
      behavior: scenario.behavior,
      variantId: scenario.variantId,
      exit: run.code,
      signal: run.signal,
      durationMs: run.durationMs,
      requests: mock.requests.length,
      findings,
      stderrHead: run.stderr.slice(0, 600),
      stdoutHead: run.stdout.slice(0, 400),
    };
  } finally {
    await mock.close().catch(() => undefined);
    // Restore write permission so cleanup of read-only fixtures cannot fail.
    for (const path of Object.keys(scenario.chmod ?? {})) {
      await chmod(join(root, path), 0o644).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pool(items, limit, worker, onDone) {
  const results = [];
  let cursor = 0;
  async function drain() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
      onDone?.(results[index], index + 1, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string" },
      filter: { type: "string" },
      concurrency: { type: "string" },
      report: { type: "string" },
      quiet: { type: "boolean" },
    },
  });

  let scenarios = values.mode === "direct"
    ? directScenarios()
    : values.mode === "compiler"
      ? compilerScenarios()
      : allScenarios();

  if (values.mode === undefined) {
    if (directScenarios().length !== DIRECT_SCENARIO_COUNT) {
      throw new Error("direct scenario count drifted from the declared corpus size");
    }
    if (compilerScenarios().length !== COMPILER_SCENARIO_COUNT) {
      throw new Error("compiler scenario count drifted from the declared corpus size");
    }
  }
  if (values.filter) {
    scenarios = scenarios.filter((scenario) => scenario.name.includes(values.filter));
  }

  const concurrency = Number(values.concurrency ?? 6);
  process.stderr.write(
    `running ${scenarios.length} scenarios, concurrency ${concurrency}\n`,
  );

  const started = Date.now();
  const results = await pool(scenarios, concurrency, runScenario, (result, done, total) => {
    if (values.quiet) return;
    const mark = result.findings.length === 0 ? "." : "F";
    process.stderr.write(mark);
    if (done % 50 === 0 || done === total) {
      process.stderr.write(` ${done}/${total}\n`);
    }
  });

  const failing = results.filter((result) => result.findings.length > 0);
  const byFinding = new Map();
  for (const result of failing) {
    for (const finding of result.findings) {
      const bucket = byFinding.get(finding.id) ?? [];
      bucket.push({ scenario: result.name, detail: finding.detail, behavior: result.behavior, problemId: result.problemId, variantId: result.variantId, exit: result.exit });
      byFinding.set(finding.id, bucket);
    }
  }

  const summary = {
    total: results.length,
    passing: results.length - failing.length,
    failing: failing.length,
    durationMs: Date.now() - started,
    findings: Object.fromEntries(
      [...byFinding.entries()]
        .sort((left, right) => right[1].length - left[1].length)
        .map(([id, entries]) => [id, { count: entries.length, examples: entries.slice(0, 8) }]),
    ),
    exitCodes: results.reduce((counts, result) => {
      const key = result.signal ? `signal:${result.signal}` : String(result.exit);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  };

  process.stderr.write("\n");
  process.stderr.write(`${summary.passing}/${summary.total} scenarios clean in ${(summary.durationMs / 1000).toFixed(1)}s\n`);
  for (const [id, bucket] of Object.entries(summary.findings)) {
    process.stderr.write(`  ${id}: ${bucket.count}\n`);
  }

  const reportPath = values.report ?? join(REPO, "test", "stress", "last-report.json");
  await writeFile(reportPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
  process.stderr.write(`report written to ${reportPath}\n`);

  process.exitCode = failing.length === 0 ? 0 : 1;
}

await main();
