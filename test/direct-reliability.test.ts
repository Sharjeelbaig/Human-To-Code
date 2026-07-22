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
  applyWholeFileBatch,
  applyUnit,
  declaredIdentifiers,
  discoverDirectUnits,
  extractInlineMarkers,
  stripCodeFence,
  validateGeneratedUnit,
  type ConversionUnit,
} from "../src/index.ts";
import { extractStaticFileMemory } from "../src/memory/file-memory-extraction.ts";

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

test("HTML inline parsing supports single-line, multiline, script, and style markers lexically", () => {
  const source = [
    "<p>Don't let an apostrophe hide the next marker.</p>",
    '<div data-example="<!-- @human ignore this attribute example -->">',
    "<!-- Documentation mentions @human but is not an instruction. -->",
    "<!-- @human add the primary heading -->",
    "<!--",
    "  @human add a footer",
    "  with legal links",
    "-->",
    "<script>",
    '  const example = "<!-- @human ignore this script string -->";',
    "  // @human add a click handler",
    "  /*",
    "   * @human add a keyboard handler",
    "   */",
    "</script>",
    "<style>",
    '  .example::after { content: "<!-- @human ignore this CSS string -->"; }',
    "  /* @human add a focus style */",
    "</style>",
  ].join("\n");

  const markers = extractInlineMarkers(source, "page.html");
  assert.deepEqual(markers.map(({ prompt }) => prompt), [
    "add the primary heading",
    "add a footer\n  with legal links",
    "add a click handler",
    "add a keyboard handler",
    "add a focus style",
  ]);
  assert.deepEqual(markers.map(({ start, end }) => source.slice(start, end)), [
    "<!-- @human add the primary heading -->",
    "<!--\n  @human add a footer\n  with legal links\n-->",
    "// @human add a click handler",
    "/*\n   * @human add a keyboard handler\n   */",
    "/* @human add a focus style */",
  ]);
});

test("HTML and CSS inline markers apply exactly and preserve multiline indentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-html-css-inline-"));
  const htmlPath = join(root, "index.html");
  const cssPath = join(root, "styles.css");
  try {
    await writeFile(htmlPath, [
      "<main>",
      "  <!-- @human add title -->",
      "  <!--",
      "    @human add content",
      "    with a paragraph",
      "  -->",
      "</main>",
      "",
    ].join("\n"));
    await writeFile(cssPath, [
      ":root {",
      "  /* @human add colors */",
      "}",
      "",
      ".button {",
      "  /*",
      "   * @human add interaction styles",
      "   * on hover and focus",
      "   */",
      "}",
      "",
    ].join("\n"));

    const discovered = await discoverDirectUnits(root, ["html", "css"]);
    assert.deepEqual(discovered.notices, []);
    assert.deepEqual(discovered.units.map(({ sourcePath, language, prompt }) => ({
      sourcePath,
      language,
      prompt,
    })), [
      { sourcePath: "index.html", language: "html", prompt: "add title" },
      { sourcePath: "index.html", language: "html", prompt: "add content\n    with a paragraph" },
      { sourcePath: "styles.css", language: "css", prompt: "add colors" },
      { sourcePath: "styles.css", language: "css", prompt: "add interaction styles\non hover and focus" },
    ]);

    const replacements = new Map([
      ["add title", "<h1>Calculator</h1>"],
      ["add content\n    with a paragraph", "<section>\n<p>Ready.</p>\n</section>"],
      ["add colors", "--accent: royalblue;"],
      ["add interaction styles\non hover and focus", "&:hover,\n&:focus {\n  color: var(--accent);\n}"],
    ]);
    const ordered = [...discovered.units].sort((left, right) => {
      const byPath = left.sourcePath.localeCompare(right.sourcePath);
      return byPath !== 0 ? byPath : right.range!.start - left.range!.start;
    });
    for (const unit of ordered) {
      const code = replacements.get(unit.prompt)!;
      await validateGeneratedUnit(unit, code);
      await applyUnit(root, unit, code);
    }

    assert.equal(await readFile(htmlPath, "utf8"), [
      "<main>",
      "  <h1>Calculator</h1>",
      "  <section>",
      "  <p>Ready.</p>",
      "  </section>",
      "</main>",
      "",
    ].join("\n"));
    assert.equal(await readFile(cssPath, "utf8"), [
      ":root {",
      "  --accent: royalblue;",
      "}",
      "",
      ".button {",
      "  &:hover,",
      "  &:focus {",
      "    color: var(--accent);",
      "  }",
      "}",
      "",
    ].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTM, MTS, and CTS files participate in inline discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-aliases-"));
  try {
    await writeFile(join(root, "page.htm"), "<!-- @human add a landmark -->\n");
    await writeFile(join(root, "module.mts"), "// @human export a value\n");
    await writeFile(join(root, "legacy.cts"), "/* @human export another value */\n");

    const discovered = await discoverDirectUnits(root, ["typescript", "html"]);
    assert.deepEqual(discovered.notices, []);
    assert.deepEqual(discovered.units.map(({ sourcePath, language, prompt }) => ({ sourcePath, language, prompt })), [
      { sourcePath: "legacy.cts", language: "typescript", prompt: "export another value" },
      { sourcePath: "module.mts", language: "typescript", prompt: "export a value" },
      { sourcePath: "page.htm", language: "html", prompt: "add a landmark" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("whole-file batch application rolls back earlier creates when a later target cannot be created", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-whole-file-batch-"));
  const firstHuman = join(root, "first.human");
  const secondHuman = join(root, "second.human");
  try {
    await writeFile(firstHuman, "create first");
    await writeFile(secondHuman, "create second");
    await writeFile(join(root, "second.ts"), "export const existing = true;\n");
    const first: ConversionUnit = {
      kind: "file",
      sourcePath: "first.human",
      absoluteSource: firstHuman,
      outputPath: "first.ts",
      prompt: "create first",
      describe: "first.human -> first.ts",
    };
    const second: ConversionUnit = {
      kind: "file",
      sourcePath: "second.human",
      absoluteSource: secondHuman,
      outputPath: "second.ts",
      prompt: "create second",
      describe: "second.human -> second.ts",
    };
    await assert.rejects(
      () => applyWholeFileBatch(root, [
        { unit: first, code: "export const first = true;" },
        { unit: second, code: "export const second = true;" },
      ]),
      (error: unknown) => error instanceof DirectApplicationError && /batch was not applied.*overwrite/u.test(error.message),
    );
    await assert.rejects(readFile(join(root, "first.ts"), "utf8"));
    assert.equal(await readFile(join(root, "second.ts"), "utf8"), "export const existing = true;\n");
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
