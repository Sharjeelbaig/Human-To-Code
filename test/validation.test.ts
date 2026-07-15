import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Text, type ValidationPlanV1 } from "../src/contracts.ts";
import { ValidationError, validateBaselineAndCandidate } from "../src/validation.ts";

function plan(argv: string[] = ["npm", "run", "test"]): ValidationPlanV1 {
  return {
    schemaVersion: 1,
    profileFingerprint: sha256Text("profile"),
    commands: [{
      id: "test",
      argv,
      cwd: ".",
      timeoutMs: 60_000,
      required: true,
      category: "test",
    }],
    manualChecks: ["Confirm the visible behavior."],
  };
}

test("unavailable strong sandbox is INCONCLUSIVE and executes no project command", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "h2c-validation-base-"));
  const candidate = await mkdtemp(join(tmpdir(), "h2c-validation-candidate-"));
  try {
    const report = await validateBaselineAndCandidate(plan(), {
      baselineRoot: baseline,
      candidateRoot: candidate,
      image: "unused:test",
      dockerBinary: join(baseline, "definitely-not-a-container-runtime"),
    });
    assert.equal(report.status, "unvalidated");
    assert.equal(report.sandbox, "none");
    assert.deepEqual(report.baseline, []);
    assert.deepEqual(report.candidate, []);
    assert.equal(report.manualChecks[0]?.status, "pending");
    assert.match(report.diagnostics.join("\n"), /strong Docker sandbox is unavailable/u);
  } finally {
    await rm(baseline, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
  }
});

test("validation rejects shells and implicit downloaders before probing a sandbox", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "h2c-validation-shell-base-"));
  const candidate = await mkdtemp(join(tmpdir(), "h2c-validation-shell-candidate-"));
  try {
    await assert.rejects(
      validateBaselineAndCandidate(plan(["npx", "vitest", "run"]), {
        baselineRoot: baseline,
        candidateRoot: candidate,
        image: "unused:test",
        dockerBinary: join(baseline, "missing-runtime"),
      }),
      (error: unknown) => error instanceof ValidationError && error.code === "SHELL_COMMAND_BLOCKED",
    );
  } finally {
    await rm(baseline, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
  }
});

test("validation pins an already-installed image and forbids implicit pulls", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "h2c-validation-pinned-base-"));
  const candidate = await mkdtemp(join(tmpdir(), "h2c-validation-pinned-candidate-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "h2c-validation-runtime-"));
  const runtime = join(runtimeRoot, "container-runtime.mjs");
  const invocations = join(runtimeRoot, "invocations.jsonl");
  const imageId = `sha256:${"a".repeat(64)}`;
  try {
    await writeFile(runtime, [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `const output = ${JSON.stringify(invocations)};`,
      "const args = process.argv.slice(2);",
      'appendFileSync(output, `${JSON.stringify(args)}\\n`);',
      'if (args[0] === "version") process.stdout.write("99.1.0\\n");',
      `else if (args[0] === "image" && args[1] === "inspect") process.stdout.write(${JSON.stringify(`${imageId}\n`)});`,
      'else if (args[0] !== "run" && args[0] !== "rm") process.exitCode = 1;',
      "",
    ].join("\n"), "utf8");
    await chmod(runtime, 0o755);

    const report = await validateBaselineAndCandidate({ ...plan(["node", "--version"]), manualChecks: [] }, {
      baselineRoot: baseline,
      candidateRoot: candidate,
      image: "node:24-bookworm",
      dockerBinary: runtime,
      retryFailedOnce: false,
    });
    assert.equal(report.status, "validated");
    const calls = (await readFile(invocations, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "image" && args.includes("node:24-bookworm")));
    const runs = calls.filter((args) => args[0] === "run");
    assert.equal(runs.length, 2);
    for (const args of runs) {
      assert.deepEqual(args.slice(0, 5), ["run", "--rm", "--pull", "never", "--name"]);
      assert.ok(args.includes(imageId));
      assert.ok(!args.includes("node:24-bookworm"));
    }
    assert.match(report.diagnostics.join("\n"), /image pulling disabled/u);
  } finally {
    await rm(baseline, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
