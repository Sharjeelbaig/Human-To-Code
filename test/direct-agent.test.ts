import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContextSecurityError } from "../src/context/context.ts";
import {
  FileMemory,
  FileMemoryConflictError,
  applyUnit,
  discoverUnits,
  extractInlineMarkers,
  generateCode,
  generateConversionUnits,
  type UnitGenerationContext,
} from "../src/agents/direct/index.ts";

test("inline marker extraction ignores marker-shaped text in strings and comments", () => {
  const source = [
    'const help = "run // @human to convert";',
    "const block = 'example: /* @human replace this */';",
    "const hash = \"example: # @human replace this\";",
    "const template = `example text",
    "  // @human replace this",
    "  /* @human replace this too */",
    "`;",
    'const pythonHelp = """example: # @human replace this""";',
    "/* Documentation example:",
    " * // @human replace this",
    " */",
    "// Documentation says // @human replace this",
    "// @human add the real line instruction",
    "/* @human add the real block instruction */",
  ].join("\n");

  const markers = extractInlineMarkers(source);

  assert.deepEqual(markers.map((marker) => marker.prompt), [
    "add the real line instruction",
    "add the real block instruction",
  ]);
  assert.deepEqual(markers.map((marker) => source.slice(marker.start, marker.end)), [
    "// @human add the real line instruction",
    "/* @human add the real block instruction */",
  ]);
});

test("direct discovery does not create a unit for @human example text", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-lexical-marker-"));
  try {
    await writeFile(join(root, "example.ts"), 'const help = "run // @human to convert";\n');

    assert.deepEqual(await discoverUnits(root, "typescript"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 03: a line marker inside a block comment is not discovered or applied", async () => {
  const source = [
    "/* setup",
    "// @human do the thing",
    "*/",
    "const ready = true;",
    "",
  ].join("\n");
  assert.deepEqual(extractInlineMarkers(source), []);

  const root = await mkdtemp(join(tmpdir(), "h2c-block-comment-marker-"));
  const path = join(root, "example.ts");
  try {
    await writeFile(path, source);

    assert.deepEqual(await discoverUnits(root, "typescript"), []);
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileMemory records deterministic replacement line ranges without persistence", () => {
  const source = "// @human add a const named value and assign 5\nconst gap = true;\n// @human log the const\n";
  const start = source.indexOf("// @human");
  const end = source.indexOf("\n");
  const memory = new FileMemory("example.ts", source);

  memory.rememberReplacement({ start, end }, "const value = 5;");

  assert.equal(memory.render(), [
    "line 1 to line 1:\nconst value = 5;",
    "line 2 to line 2:\nconst gap = true;",
  ].join("\n\n"));
  assert.deepEqual(memory.entries, [
    { startLine: 1, endLine: 1, code: "const value = 5;", fragment: false },
    { startLine: 2, endLine: 2, code: "const gap = true;", fragment: false },
  ]);
});

test("FileMemory marks signature-only spans as fragments", () => {
  const memory = new FileMemory("example.ts", "const done = true;\nfunction run() {\n  return done;\n}\n");
  assert.deepEqual(memory.entries, [
    { startLine: 1, endLine: 1, code: "const done = true;", fragment: false },
    { startLine: 2, endLine: 2, code: "function run() {", fragment: true },
  ]);
});

test("FileMemory keeps a new function intact when its signature matches indexed evidence", () => {
  const source = [
    "function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "",
    '// @human create a function named "add" that takes two numbers as parameters and returns their sum.',
    "",
  ].join("\n");
  const memory = new FileMemory("example.ts", source);
  const generated = "function add(a: number, b: number) {\n  return a + b;\n}";

  assert.equal(memory.normalizeReplacement(generated), generated);
});

test("FileMemory statically indexes declarations in every direct-path language", () => {
  const cases: Array<{ path: string; source: string; expected: string[] }> = [
    {
      path: "sample.ts",
      source: "const settings = {\n  retries: 3,\n};\nfunction health(\n  code: number,\n): number {\nclass Service {\n  constructor() {\n    this.ready = true;\n  }\n  check() {",
      expected: ["line 1 to line 3:\nconst settings = {\n  retries: 3,\n};", "line 4 to line 6:\nfunction health(\n  code: number,\n): number {", "line 7 to line 7:\nclass Service {", "line 8 to line 8:\nconstructor() {", "line 9 to line 9:\nthis.ready = true;", "line 11 to line 11:\ncheck() {"],
    },
    {
      path: "sample.js",
      source: "let count = 0;\nconst greet = (name) => {\n  return name;\n};\nfunction reset() {}",
      expected: ["line 1 to line 1:\nlet count = 0;", "line 2 to line 4:\nconst greet = (name) => {\n  return name;\n};", "line 5 to line 5:\nfunction reset() {}"],
    },
    {
      path: "sample.py",
      source: "CONFIG = {\n    \"retries\": 3,\n}\ndef health(\n    code: int,\n) -> int:\nclass Service:\n    def __init__(self):\n        self.ready = True",
      expected: ["line 1 to line 3:\nCONFIG = {\n    \"retries\": 3,\n}", "line 4 to line 6:\ndef health(\n    code: int,\n) -> int:", "line 7 to line 7:\nclass Service:", "line 8 to line 8:\ndef __init__(self):", "line 9 to line 9:\nself.ready = True"],
    },
    {
      path: "sample.rs",
      source: "const LIMIT: usize = 5;\nfn health(\n    code: i32,\n) -> i32 {\nstruct Service {",
      expected: ["line 1 to line 1:\nconst LIMIT: usize = 5;", "line 2 to line 4:\nfn health(\n    code: i32,\n) -> i32 {", "line 5 to line 5:\nstruct Service {"],
    },
    {
      path: "sample.go",
      source: "const (\n  Limit = 5\n)\nfunc health(\n  code int,\n) int {",
      expected: ["line 1 to line 3:\nconst (\n  Limit = 5\n)", "line 4 to line 6:\nfunc health(\n  code int,\n) int {"],
    },
    {
      path: "sample.java",
      source: "static final int LIMIT = 5;\npublic int health(\n  int code\n) {\nclass Service {",
      expected: ["line 1 to line 1:\nstatic final int LIMIT = 5;", "line 2 to line 4:\npublic int health(\n  int code\n) {", "line 5 to line 5:\nclass Service {"],
    },
    {
      path: "sample.rb",
      source: "LIMIT = 5\ndef health(\n  code\n)\nclass Service",
      expected: ["line 1 to line 1:\nLIMIT = 5", "line 2 to line 4:\ndef health(\n  code\n)", "line 5 to line 5:\nclass Service"],
    },
    {
      path: "sample.cs",
      source: "private const int Limit = 5;\npublic int Health(\n  int code\n) {\npublic class Service {",
      expected: ["line 1 to line 1:\nprivate const int Limit = 5;", "line 2 to line 4:\npublic int Health(\n  int code\n) {", "line 5 to line 5:\npublic class Service {"],
    },
    {
      path: "sample.cpp",
      source: "static const int limit = 5;\nint health(\n  int code\n) {\nstruct Service {",
      expected: ["line 1 to line 1:\nstatic const int limit = 5;", "line 2 to line 4:\nint health(\n  int code\n) {", "line 5 to line 5:\nstruct Service {"],
    },
    {
      path: "sample.c",
      source: "static const int limit = 5;\nint health(\n  int code\n) {",
      expected: ["line 1 to line 1:\nstatic const int limit = 5;", "line 2 to line 4:\nint health(\n  int code\n) {"],
    },
  ];

  for (const item of cases) {
    const rendered = new FileMemory(item.path, item.source).render();
    for (const expected of item.expected) assert.ok(rendered.includes(expected), `${item.path} missing ${expected}`);
  }
});

test("FileMemory ignores ordinary statements and keeps shifted declaration line numbers current", () => {
  const source = [
    "// @human create two declaration lines",
    "const existing = 10;",
    "console.log(existing);",
    "if (existing > 0) doWork();",
    "// function fake() {}",
  ].join("\n");
  const markerEnd = source.indexOf("\n");
  const memory = new FileMemory("example.ts", source);

  assert.equal(memory.render(), "line 2 to line 2:\nconst existing = 10;");
  memory.rememberReplacement(
    { start: 0, end: markerEnd },
    "const first = 1;\nconst second = 2;",
  );

  assert.equal(memory.render(), [
    "line 1 to line 2:\nconst first = 1;\nconst second = 2;",
    "line 3 to line 3:\nconst existing = 10;",
  ].join("\n\n"));
  assert.doesNotMatch(memory.render(), /console\.log|doWork|fake/u);
});

test("FileMemory blocks credential-bearing declarations before prompt rendering", () => {
  const memory = new FileMemory("config.ts", "export const API_KEY = 'super-secret-value-123';\n");
  assert.throws(
    () => memory.render(),
    (error: unknown) => error instanceof ContextSecurityError
      && error.code === "SECRET_DETECTED"
      && error.location === "config.ts"
      && !error.message.includes("super-secret-value-123"),
  );
});

test("later inline markers receive FileMemory from earlier markers in the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-file-memory-"));
  const path = join(root, "example.ts");
  try {
    await writeFile(path, [
      "// @human add a const here with the name value and assign 5 to it",
      "const unrelated = 100;",
      "",
      "// @human console log the const we declared above",
      "",
    ].join("\n"));
    const units = await discoverUnits(root, "typescript");
    const contexts: UnitGenerationContext[] = [];
    const generated = await generateConversionUnits(units, async (unit, context) => {
      contexts.push(context);
      return unit.prompt.includes("assign 5") ? "const value = 5;" : "const value = 5;\\nconsole.log(value);";
    });

    assert.equal(generated.length, 2);
    assert.match(contexts[0]?.fileMemory ?? "", /line 2 to line 2:\nconst unrelated = 100;/u);
    assert.match(contexts[1]?.fileMemory ?? "", /line 1 to line 1:\nconst value = 5;/u);
    assert.equal(generated[1]?.code, "console.log(value);");

    for (const item of [...generated].sort((left, right) => right.unit.range!.start - left.unit.range!.start)) {
      await applyUnit(root, item.unit, item.code);
    }
    assert.equal(await readFile(path, "utf8"), [
      "const value = 5;",
      "const unrelated = 100;",
      "",
      "console.log(value);",
      "",
    ].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline markers next to a pre-existing identical signature apply without decapitation", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-fragment-"));
  const path = join(root, "example.ts");
  try {
    await writeFile(path, [
      "function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      '// @human create a function named "add" that takes two numbers as parameters and returns their sum.',
      "",
      "/* @human use the function to add 1 and 1,",
      "and logs the result to the console.",
      "*/",
      "",
    ].join("\n"));
    const units = await discoverUnits(root, "typescript");
    const generated = await generateConversionUnits(units, async (unit) =>
      unit.prompt.includes("create a function")
        ? "function add(a: number, b: number) {\n  return a + b;\n}"
        : "const result = add(1, 1);\nconsole.log(result);");

    for (const item of [...generated].sort((left, right) => right.unit.range!.start - left.unit.range!.start)) {
      await applyUnit(root, item.unit, item.code);
    }
    assert.equal(await readFile(path, "utf8"), [
      "function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      "function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      "const result = add(1, 1);",
      "console.log(result);",
      "",
    ].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileMemory fails closed when a provider redeclares a remembered identifier differently", () => {
  const source = "// @human add value\n// @human log value\n";
  const memory = new FileMemory("example.ts", source);
  memory.rememberReplacement({ start: 0, end: source.indexOf("\n") }, "const value = 5;");

  assert.throws(
    () => memory.normalizeReplacement("const value: number = 5;\nconsole.log(value);"),
    (error: unknown) => error instanceof FileMemoryConflictError && /redeclared FileMemory identifier value/u.test(error.message),
  );
});

test("one failing marker is skipped with a reason while the others still convert", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-resilience-"));
  const path = join(root, "example.ts");
  try {
    await writeFile(path, [
      "// @human first",
      "// @human second",
      "// @human third",
      "",
    ].join("\n"));
    const units = await discoverUnits(root, "typescript");
    const generated = await generateConversionUnits(
      units,
      async (unit) => {
        if (unit.prompt === "second") throw new Error("provider exploded");
        return `const ${unit.prompt} = 1;`;
      },
      { retries: 0 },
    );

    const bySecond = generated.find((item) => item.unit.prompt === "second");
    assert.equal(bySecond?.code, "");
    assert.match(bySecond?.error ?? "", /provider exploded/u);
    // The other two markers are unaffected.
    assert.equal(generated.find((item) => item.unit.prompt === "first")?.code, "const first = 1;");
    assert.equal(generated.find((item) => item.unit.prompt === "third")?.code, "const third = 1;");
    assert.equal(generated.filter((item) => item.error === undefined).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a security stop still aborts the whole conversion run", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-security-abort-"));
  try {
    await writeFile(join(root, "example.ts"), "// @human one\n// @human two\n");
    const units = await discoverUnits(root, "typescript");
    await assert.rejects(
      () => generateConversionUnits(units, async () => {
        throw new ContextSecurityError("SECRET_DETECTED", "credential-like content");
      }),
      (error: unknown) => error instanceof ContextSecurityError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline provider prompts attach FileMemory as read-only earlier code", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: { messages?: Array<{ role?: string; content?: string }> } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ message: { content: "console.log(value);" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await generateCode("console log the const", {
      language: "typescript",
      provider: "ollama",
      model: "test-model",
      inline: true,
      fileMemory: "line 1 to line 1:\nconst value = 5;",
    });
    assert.equal(result, "console.log(value);");
    assert.match(requestBody?.messages?.[0]?.content ?? "", /NEVER redeclare, repeat, or re-output them/u);
    assert.match(requestBody?.messages?.[1]?.content ?? "", /line 1 to line 1:\nconst value = 5;/u);
    assert.match(requestBody?.messages?.[1]?.content ?? "", /Current @human instruction:\nconsole log the const/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multi-language discovery routes .human files by inner extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-multi-language-"));
  try {
    await writeFile(join(root, "index.html.human"), "build a landing page\n");
    await writeFile(join(root, "styles.css.human"), "style the landing page\n");
    await writeFile(join(root, "app.human"), "wire up the landing page\n");
    await writeFile(join(root, "notes.py.human"), "unconfigured inner extension\n");

    const units = await discoverUnits(root, ["typescript", "html", "css"]);
    const byOutput = new Map(units.map((unit) => [unit.outputPath, unit.language]));

    assert.equal(byOutput.get("index.html"), "html");
    assert.equal(byOutput.get("styles.css"), "css");
    assert.equal(byOutput.get("app.ts"), "typescript");
    // Python is not configured, so the inner extension is not honored.
    assert.equal(byOutput.get("notes.py.ts"), "typescript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-language discovery infers bare .human outputs from explicit request languages", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inferred-language-"));
  try {
    await writeFile(join(root, "index.human"), "Here is complete structure of calculator in html\n");
    await writeFile(join(root, "script.human"), "Here is the logic for calculator in javascript\n");
    await writeFile(join(root, "styles.human"), "Here is complete styles of calculator in css\n");

    const units = await discoverUnits(root, ["typescript", "html", "css", "javascript"]);
    assert.deepEqual(units.map(({ sourcePath, outputPath, language }) => ({
      sourcePath,
      outputPath,
      language,
    })), [
      { sourcePath: "index.human", outputPath: "index.html", language: "html" },
      { sourcePath: "script.human", outputPath: "script.js", language: "javascript" },
      { sourcePath: "styles.human", outputPath: "styles.css", language: "css" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit request language wins over filename and vocabulary hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-explicit-language-"));
  try {
    await writeFile(
      join(root, "styles.human"),
      "Write JavaScript code that stores colors, fonts, spacing, backgrounds, borders, and themes.\n",
    );

    const units = await discoverUnits(root, ["typescript", "javascript", "css"]);
    assert.equal(units[0]?.outputPath, "styles.js");
    assert.equal(units[0]?.language, "javascript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-language discovery keeps its legacy output naming", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-single-language-"));
  try {
    await writeFile(join(root, "index.html.human"), "build a landing page\n");

    const units = await discoverUnits(root, "python");
    assert.equal(units[0]?.outputPath, "index.html.py");
    assert.equal(units[0]?.language, "python");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline units carry the host file's language", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-language-"));
  try {
    await writeFile(join(root, "script.py"), "# @human print hello\n");

    const units = await discoverUnits(root, ["typescript", "python"]);
    assert.equal(units[0]?.language, "python");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
