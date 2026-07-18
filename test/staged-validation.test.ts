import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyUnit,
  buildCandidateOverlay,
  discoverDirectUnits,
  validateCandidateProject,
  type ConversionUnit,
  type GeneratedConversionUnit,
  type StagedRepairRequest,
} from "../src/agents/direct/index.ts";
import { buildDirectRepairPrompt } from "../src/prompts/direct-repair.ts";

function fileUnit(root: string, source: string, output: string): ConversionUnit {
  return {
    kind: "file",
    sourcePath: source,
    absoluteSource: join(root, source),
    prompt: `generate ${output}`,
    outputPath: output,
    describe: `${source} -> ${output}`,
  };
}

/**
 * A minimized deterministic reproduction of the multi-file calculator failure:
 * every file parses on its own, but the combined project contradicts itself
 * with a wrong named node: import, a missing method, an uppercase literal
 * against a lowercase union, a renamed record field, and a one-argument call
 * to a two-argument constructor. Production code never sees these names.
 */
function calculatorStyleUnits(root: string): GeneratedConversionUnit[] {
  return [
    {
      unit: fileUnit(root, "contracts.human", "contracts.ts"),
      code: [
        'export type OperationName = "add" | "subtract";',
        "export interface CalculationRecord {",
        "  readonly id: number;",
        "  readonly operation: OperationName;",
        "  readonly createdAt: string;",
        "}",
      ].join("\n"),
    },
    {
      unit: fileUnit(root, "errors.human", "errors.ts"),
      code: [
        "export class CalculatorError extends Error {",
        "  constructor(public readonly code: string, message: string) { super(message); }",
        "}",
      ].join("\n"),
    },
    {
      unit: fileUnit(root, "history.human", "history.ts"),
      code: [
        'import type { CalculationRecord } from "./contracts.ts";',
        "export class CalculationHistory {",
        "  #records: CalculationRecord[] = [];",
        "  add(record: CalculationRecord): void {",
        "    this.#records.push({ ...record, timestamp: new Date().toISOString() });",
        "  }",
        "  list(): readonly CalculationRecord[] { return this.#records; }",
        "}",
      ].join("\n"),
    },
    {
      unit: fileUnit(root, "calculator.human", "calculator.ts"),
      code: [
        'import { assert } from "node:assert/strict";',
        'import { CalculationHistory } from "./history.ts";',
        'import { CalculatorError } from "./errors.ts";',
        "export class Calculator {",
        "  #history = new CalculationHistory();",
        "  add(a: number, b: number): number {",
        '    this.#history.push({ id: 1, operation: "ADD", createdAt: "now" });',
        '    if (!Number.isFinite(a + b)) throw new CalculatorError("INVALID");',
        "    return a + b;",
        "  }",
        "}",
      ].join("\n"),
    },
  ];
}

test("calculator-style cross-file contradictions are rejected before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-calculator-"));
  try {
    const units = calculatorStyleUnits(root);
    const outcome = await validateCandidateProject(root, units);

    assert.equal(outcome.validated, true);
    for (const item of outcome.results) {
      assert.match(item.error ?? "", /combined project validation/u, `${item.unit.outputPath} must be rejected`);
    }
    // Wrong named import, missing method, literal-union casing, and
    // constructor arity are all reported in the shared rejection reason.
    const reason = outcome.results[0]?.error ?? "";
    assert.match(reason, /TS\d+/u);
    for (const item of outcome.results) {
      await assert.rejects(access(join(root, item.unit.outputPath!)), "nothing may be written");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an internally consistent multi-file candidate passes and applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-consistent-"));
  try {
    const units: GeneratedConversionUnit[] = [
      {
        unit: fileUnit(root, "contracts.human", "contracts.ts"),
        code: 'export type OperationName = "add" | "subtract";\nexport interface Entry { readonly op: OperationName; }',
      },
      {
        unit: fileUnit(root, "store.human", "store.ts"),
        code: [
          'import type { Entry } from "./contracts.ts";',
          "export class Store {",
          "  #entries: Entry[] = [];",
          "  add(entry: Entry): void { this.#entries.push(entry); }",
          "  list(): readonly Entry[] { return this.#entries; }",
          "}",
        ].join("\n"),
      },
      {
        unit: fileUnit(root, "main.human", "main.ts"),
        code: [
          'import { Store } from "./store.ts";',
          "const store = new Store();",
          'store.add({ op: "add" });',
          "console.log(store.list().length);",
        ].join("\n"),
      },
    ];
    const outcome = await validateCandidateProject(root, units);
    for (const item of outcome.results) {
      assert.equal(item.error, undefined, `${item.unit.outputPath}: ${item.error}`);
      await applyUnit(root, item.unit, item.code);
      await access(join(root, item.unit.outputPath!));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded repair fixes a cross-file mismatch and the repaired group applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-repair-"));
  try {
    const units: GeneratedConversionUnit[] = [
      {
        unit: fileUnit(root, "shared.human", "shared.ts"),
        code: "export function greet(name: string): string { return name; }",
      },
      {
        unit: fileUnit(root, "main.human", "main.ts"),
        code: 'import { hello } from "./shared.ts";\nconsole.log(hello("world"));',
      },
    ];
    const requests: StagedRepairRequest[] = [];
    const outcome = await validateCandidateProject(root, units, {
      repair: async (request) => {
        requests.push(request);
        return 'import { greet } from "./shared.ts";\nconsole.log(greet("world"));';
      },
    });

    assert.equal(outcome.repairRequests, 1);
    assert.equal(requests[0]?.targetPath, "main.ts");
    assert.match(requests[0]?.diagnostics[0]?.message ?? "", /hello/u);
    assert.deepEqual(requests[0]?.relatedFiles.map((file) => file.path), ["shared.ts"]);
    for (const item of outcome.results) {
      assert.equal(item.error, undefined, `${item.unit.outputPath}: ${item.error}`);
    }
    assert.match(outcome.results.find((item) => item.unit.outputPath === "main.ts")?.code ?? "", /greet/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repair that stays broken exhausts its bounded budget and the group fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-repair-fail-"));
  try {
    const units: GeneratedConversionUnit[] = [
      {
        unit: fileUnit(root, "shared.human", "shared.ts"),
        code: "export function greet(name: string): string { return name; }",
      },
      {
        unit: fileUnit(root, "main.human", "main.ts"),
        code: 'import { hello } from "./shared.ts";\nconsole.log(hello("world"));',
      },
    ];
    let calls = 0;
    const outcome = await validateCandidateProject(root, units, {
      repair: async () => {
        calls += 1;
        return 'import { stillWrong } from "./shared.ts";\nconsole.log(stillWrong("world"));';
      },
    });

    assert.equal(calls, 1, "repair budget is one request per whole-file unit");
    assert.equal(outcome.repairRequests, 1);
    for (const item of outcome.results) {
      assert.match(item.error ?? "", /combined project validation/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incorrect named imports across generated modules are detected", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-named-import-"));
  try {
    const outcome = await validateCandidateProject(root, [
      {
        unit: fileUnit(root, "util.human", "util.ts"),
        code: "export function double(value: number): number { return value * 2; }",
      },
      {
        unit: fileUnit(root, "use.human", "use.ts"),
        code: 'import { triple } from "./util.ts";\nconsole.log(triple(2));',
      },
    ]);
    assert.match(outcome.results[1]?.error ?? "", /TS2305|TS2724/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing methods, union casing, and constructor arity are each detected", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-semantic-"));
  try {
    const outcome = await validateCandidateProject(root, [
      {
        unit: fileUnit(root, "api.human", "api.ts"),
        code: [
          'export type Mode = "fast" | "slow";',
          "export class Service {",
          "  constructor(public readonly name: string, public readonly mode: Mode) {}",
          "  run(mode: Mode): string { return `${this.name}:${mode}`; }",
          "}",
        ].join("\n"),
      },
      {
        unit: fileUnit(root, "caller.human", "caller.ts"),
        code: [
          'import { Service } from "./api.ts";',
          'const service = new Service("only-one-argument");',
          'service.run("FAST");',
          "service.stop();",
        ].join("\n"),
      },
    ]);
    const reason = outcome.results[1]?.error ?? "";
    assert.match(reason, /combined project validation/u);
    // Expected 2 arguments (TS2554), incompatible literal union (TS2345),
    // and a missing method (TS2339) all belong to the same failing group.
    assert.match(reason, /TS2554|TS2345|TS2339/u);
    assert.notEqual(outcome.results[0]?.error, undefined, "the dependency-connected api.ts is rejected too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-existing baseline errors are tolerated when the candidate adds none", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-baseline-"));
  try {
    await writeFile(join(root, "legacy.ts"), 'export const broken: number = "not a number";\n');
    const outcome = await validateCandidateProject(root, [
      {
        unit: fileUnit(root, "fresh.human", "fresh.ts"),
        code: "export const fresh: number = 1;",
      },
    ]);
    assert.equal(outcome.validated, true);
    assert.equal(outcome.results[0]?.error, undefined, outcome.results[0]?.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new diagnostic sharing a baseline diagnostic's code is still caught by multiplicity", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-multiplicity-"));
  try {
    await writeFile(join(root, "values.ts"), [
      'export const first: number = "oops";',
      "// @human declare a second numeric constant",
      "",
    ].join("\n"));
    const units = (await discoverDirectUnits(root, "typescript")).units;
    assert.equal(units.length, 1);
    const outcome = await validateCandidateProject(root, [
      // The replacement introduces a second string-into-number TS2322 with the
      // exact same message as the baseline error in the same file.
      { unit: units[0]!, code: 'export const second: number = "also wrong";' },
    ]);
    assert.match(outcome.results[0]?.error ?? "", /TS2322/u);

    const tolerated = await validateCandidateProject(root, [
      { unit: units[0]!, code: "export const second: number = 2;" },
    ]);
    assert.equal(tolerated.results[0]?.error, undefined, tolerated.results[0]?.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid dependency-connected group is rejected whole while an independent unit applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-isolation-"));
  try {
    const units: GeneratedConversionUnit[] = [
      ...calculatorStyleUnits(root),
      {
        unit: fileUnit(root, "greeting.human", "greeting.ts"),
        code: "export function greet(name: string): string { return `hello ${name}`; }",
      },
    ];
    const outcome = await validateCandidateProject(root, units);

    const greeting = outcome.results.find((item) => item.unit.outputPath === "greeting.ts")!;
    assert.equal(greeting.error, undefined, greeting.error);
    const rejected = outcome.results.filter((item) => item.error !== undefined);
    assert.equal(rejected.length, 4, "the whole calculator group is rejected, nothing partial");

    await applyUnit(root, greeting.unit, greeting.code);
    assert.match(await readFile(join(root, "greeting.ts"), "utf8"), /hello/u);
    for (const item of rejected) {
      await assert.rejects(access(join(root, item.unit.outputPath!)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing sibling targets are excluded from the overlay and never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-sibling-"));
  try {
    await writeFile(join(root, "feature.ts"), "export const handwritten = true;\n");
    const outcome = await validateCandidateProject(root, [
      { unit: fileUnit(root, "feature.human", "feature.ts"), code: "export const generated = true;" },
    ]);
    assert.match(outcome.results[0]?.error ?? "", /never overwritten/u);
    assert.equal(await readFile(join(root, "feature.ts"), "utf8"), "export const handwritten = true;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale inline marker excludes every inline unit of that file fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-stale-"));
  try {
    await writeFile(join(root, "app.ts"), "// @human declare value\n// @human log value\n");
    const units = (await discoverDirectUnits(root, "typescript")).units;
    assert.equal(units.length, 2);
    await writeFile(join(root, "app.ts"), "const shifted = 1;\n// @human declare value\n// @human log value\n");

    const overlay = await buildCandidateOverlay(root, [
      { unit: units[0]!, code: "const value = 1;" },
      { unit: units[1]!, code: "console.log(value);" },
    ]);
    assert.equal(overlay.files.size, 0);
    assert.equal(overlay.excluded.length, 2);
    for (const entry of overlay.excluded) assert.match(entry.reason, /stale|changed after discovery/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-JS/TS units bypass combined program validation unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-python-"));
  try {
    const outcome = await validateCandidateProject(root, [
      { unit: fileUnit(root, "tool.human", "tool.py"), code: "def run():\n    return 1" },
    ]);
    assert.equal(outcome.validated, false);
    assert.equal(outcome.results[0]?.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default JavaScript project validation accepts browser DOM APIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-staged-browser-js-"));
  try {
    const outcome = await validateCandidateProject(root, [{
      unit: fileUnit(root, "script.human", "script.js"),
      code: [
        'const display = document.querySelector("#display");',
        'display?.addEventListener("click", () => console.log(window.location.href));',
      ].join("\n"),
    }]);
    assert.equal(outcome.validated, true);
    assert.equal(outcome.results[0]?.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair prompt wraps diagnostics and related files as untrusted data in src/prompts", () => {
  const prompt = buildDirectRepairPrompt({
    languageLabel: "TypeScript",
    targetPath: "main.ts",
    inline: false,
    instruction: "wire the store",
    currentCode: 'import { hello } from "./shared.ts";',
    diagnostics: [{ path: "main.ts", line: 1, code: 2305, message: "Module has no exported member 'hello'." }],
    relatedFiles: [{ path: "shared.ts", content: "export function greet(): void {}" }],
  });
  assert.match(prompt.system, /untrusted data/u);
  assert.match(prompt.system, /no markdown fences/iu);
  assert.match(prompt.user, /main\.ts:1 TS2305/u);
  assert.match(prompt.user, /related generated file: shared\.ts/u);
  assert.match(prompt.user, /wire the store/u);
});
