import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DirectApplicationError,
  DirectCandidateValidationError,
  FileMemory,
  FileMemoryConflictError,
  ModelOutputError,
  applyUnit,
  declaredIdentifiers,
  discoverDirectUnits,
  extractInlineMarkers,
  stripCodeFence,
  validateGeneratedUnit,
  type ConversionUnit,
} from "../src/agents/direct/index.ts";
import { extractStaticFileMemory } from "../src/pipeline/file-memory.ts";

test("issue 02: single-line and decorated multiline JSDoc markers are discovered", () => {
  const source = [
    "/** @human create a foo function */",
    "/**",
    " * @human create a bar function",
    " * that returns true",
    " */",
  ].join("\n");

  assert.deepEqual(extractInlineMarkers(source).map((marker) => marker.prompt), [
    "create a foo function",
    "create a bar function\nthat returns true",
  ]);
});

test("issue 04: surrounding prose is discarded when exactly one fenced block exists", () => {
  assert.equal(stripCodeFence([
    "Here is the code:",
    "```ts",
    "const x = 1;",
    "```",
    "Hope this helps!",
  ].join("\n")), "const x = 1;");
  assert.throws(
    () => stripCodeFence("```ts\nconst a = 1;\n```\n```ts\nconst b = 2;\n```"),
    (error: unknown) => error instanceof ModelOutputError && /multiple fenced/u.test(error.message),
  );
});

test("issue 05: invalid TypeScript candidates fail before application", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-direct-validation-"));
  try {
    const source = join(root, "broken.human");
    await writeFile(source, "create a declaration");
    const unit: ConversionUnit = {
      kind: "file",
      sourcePath: "broken.human",
      absoluteSource: source,
      outputPath: "broken.ts",
      prompt: "create a declaration",
      describe: "broken.human -> broken.ts",
    };
    await assert.rejects(
      () => validateGeneratedUnit(unit, "const broken: number = ;"),
      (error: unknown) => error instanceof DirectCandidateValidationError && /syntax validation/u.test(error.message),
    );
    await validateGeneratedUnit(unit, "const valid: number = 1;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0.1.15 regression: inline validation ignores unchanged baseline syntax errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-direct-baseline-validation-"));
  try {
    const sourcePath = join(root, "use-math-tools.ts");
    await writeFile(sourcePath, [
      "/*",
      " * IGNORED: marker examples inside an ordinary block comment.",
      " * /* @human log the result */",
      " */",
      "",
      "// @human import add and multiply",
      "// @human call add and assign sum",
      "// @human call multiply and assign product",
      "// @human log sum and product",
      "",
    ].join("\n"));
    const units = (await discoverDirectUnits(root, "typescript")).units;
    assert.equal(units.length, 4);
    const validReplacements = [
      'import { add, multiply } from "./math-tools.js";',
      "const sum = add(10, 5);",
      "const product = multiply(10, 5);",
      "console.log(sum, product);",
    ];
    for (let index = 0; index < units.length; index += 1) {
      await validateGeneratedUnit(units[index]!, validReplacements[index]!);
    }
    await assert.rejects(
      () => validateGeneratedUnit(units[0]!, "const newlyBroken = ;"),
      (error: unknown) => error instanceof DirectCandidateValidationError && /Expression expected/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 06: existing whole-file targets are diagnosed and never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-target-exists-"));
  const human = join(root, "feature.human");
  const target = join(root, "feature.ts");
  try {
    await writeFile(human, "create feature");
    await writeFile(target, "const handwritten = true;\n");
    const discovered = await discoverDirectUnits(root, "typescript");
    assert.deepEqual(discovered.units, []);
    assert.equal(discovered.notices[0]?.code, "TARGET_EXISTS");

    const unit: ConversionUnit = {
      kind: "file",
      sourcePath: "feature.human",
      absoluteSource: human,
      outputPath: "feature.ts",
      prompt: "create feature",
      describe: "feature.human -> feature.ts",
    };
    await assert.rejects(
      () => applyUnit(root, unit, "const generated = true;"),
      (error: unknown) => error instanceof DirectApplicationError && /overwrite/u.test(error.message),
    );
    assert.equal(await readFile(target, "utf8"), "const handwritten = true;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 07: applying a stale inline range fails without changing the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-stale-inline-"));
  const path = join(root, "example.ts");
  try {
    await writeFile(path, "// @human create value\n");
    const unit = (await discoverDirectUnits(root, "typescript")).units[0]!;
    const changed = "const prefix = true;\n// @human create value\n";
    await writeFile(path, changed);

    await assert.rejects(
      () => applyUnit(root, unit, "const value = 1;"),
      (error: unknown) => error instanceof DirectApplicationError && /changed after discovery/u.test(error.message),
    );
    assert.equal(await readFile(path, "utf8"), changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 08: multiline inline replacements preserve the marker indentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-python-indent-"));
  const path = join(root, "example.py");
  try {
    await writeFile(path, "def run():\n    # @human assign and return value\n");
    const unit = (await discoverDirectUnits(root, "python")).units[0]!;
    await applyUnit(root, unit, "value = 1\nreturn value");
    assert.equal(await readFile(path, "utf8"), "def run():\n    value = 1\n    return value\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 09: regex literal structure does not truncate FileMemory declarations", () => {
  const entries = extractStaticFileMemory("example.ts", [
    "const repeated = /a{2}/;",
    "const commentLike = /a\\\/*/;",
    "const after = 2;",
  ].join("\n"));
  assert.deepEqual(entries.map((entry) => entry.code), [
    "const repeated = /a{2}/;",
    "const commentLike = /a\\\/*/;",
    "const after = 2;",
  ]);
});

test("issue 10: C-family declarations participate in redeclaration protection", () => {
  assert.deepEqual([...declaredIdentifiers("example.cpp", "int add(int a, int b) {\nint total = 0;\n")], ["add", "total"]);
  const source = "// @human declare total\n// @human use total\n";
  const memory = new FileMemory("example.cpp", source);
  memory.rememberReplacement({ start: 0, end: source.indexOf("\n") }, "int total = 1;");
  assert.throws(
    () => memory.normalizeReplacement("int total = 2;"),
    (error: unknown) => error instanceof FileMemoryConflictError && /total/u.test(error.message),
  );
});

test("issue 11: unsupported files containing @human produce an explicit notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-unsupported-marker-"));
  try {
    await writeFile(join(root, "Component.vue"), "<!-- @human add a button -->\n");
    const discovered = await discoverDirectUnits(root, "typescript");
    assert.deepEqual(discovered.units, []);
    assert.equal(discovered.notices[0]?.code, "UNSUPPORTED_MARKER_FILE");
    assert.equal(discovered.notices[0]?.sourcePath, "Component.vue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
