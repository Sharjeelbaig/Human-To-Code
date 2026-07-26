import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COMPILER_LANGUAGE_RULE_PROFILES,
  candidateTextsForGenerated,
  discoverDirectUnits,
  expectedCodeFromLanguageRules,
  generateCode,
  generateConversionUnits,
  isModelLikelyTooSmallForCode,
  normalizeCompilerGeneratedUnitCode,
  renderReceipt,
  validateGeneratedUnit,
  type ConversionUnit,
} from "../src/index.ts";
import { LANGUAGE_PROFILES } from "../src/tools/discovery/languages.ts";

function unit(
  language: string,
  insertionContext: ConversionUnit["insertionContext"],
  prompt: string,
): ConversionUnit {
  return {
    kind: "inline",
    sourcePath: `sample.${LANGUAGE_PROFILES[language]!.ext}`,
    absoluteSource: `/tmp/sample.${LANGUAGE_PROFILES[language]!.ext}`,
    language,
    insertionContext,
    prompt,
    describe: prompt,
  };
}

test("deterministic compiler syntax profiles cover every supported language", () => {
  assert.deepEqual(
    Object.keys(COMPILER_LANGUAGE_RULE_PROFILES).sort(),
    Object.keys(LANGUAGE_PROFILES).sort(),
  );
});

test("only explicitly tiny model sizes trigger the warning-only capability classification", () => {
  assert.equal(isModelLikelyTooSmallForCode("gemma3:270m"), true);
  assert.equal(isModelLikelyTooSmallForCode("qwen2.5-coder:0.5b"), true);
  assert.equal(isModelLikelyTooSmallForCode("qwen2.5-coder:1.5b"), false);
  assert.equal(isModelLikelyTooSmallForCode("gemma4:31b-cloud"), false);
  assert.equal(isModelLikelyTooSmallForCode("custom-model:latest"), false);
});

test("typed parameter expectations follow each language's declaration order", () => {
  const prompt = "add the parameters x and y with number types";
  const expected: Readonly<Record<string, string>> = {
    typescript: "x: number, y: number",
    javascript: "x, y",
    python: "x: float, y: float",
    rust: "x: f64, y: f64",
    go: "x float64, y float64",
    java: "double x, double y",
    ruby: "x, y",
    csharp: "double x, double y",
    cpp: "double x, double y",
    c: "double x, double y",
  };
  for (const [language, code] of Object.entries(expected)) {
    assert.equal(
      expectedCodeFromLanguageRules(unit(language, "parameter-list", prompt)),
      code,
      language,
    );
  }
});

test("arithmetic and call-output rules derive expectations only for complete instructions", () => {
  assert.equal(
    expectedCodeFromLanguageRules(
      unit("typescript", "function-body", "add the logic of adding x and y"),
    ),
    "return x + y;",
  );
  assert.equal(
    expectedCodeFromLanguageRules(
      unit("python", "function-body", "subtract x from y"),
    ),
    "return y - x",
  );
  assert.equal(
    expectedCodeFromLanguageRules(
      unit(
        "typescript",
        "statement",
        "console log the result of calling the add function with 1,2 parameters",
      ),
    ),
    "console.log(add(1, 2));",
  );
  assert.equal(
    expectedCodeFromLanguageRules(
      unit("typescript", "parameter-list", "add some parameters"),
    ),
    undefined,
  );
  assert.equal(
    expectedCodeFromLanguageRules(
      unit("typescript", "statement", "call a useful function"),
    ),
    undefined,
  );
});

test("compiler normalization never replaces a model echo with rule-generated code", () => {
  const parameterUnit = unit(
    "typescript",
    "parameter-list",
    "add the parameters x and y with number types",
  );
  const echoed = [
    "// FileMemory",
    "<INSERTION_CONTEXT>",
    "function add(<CURRENT_MARKER>) {}",
    "</INSERTION_CONTEXT>",
    "Return only the replacement for the current marker.",
  ].join("\n");
  const normalized = normalizeCompilerGeneratedUnitCode(parameterUnit, echoed);
  assert.notEqual(normalized, "x: number, y: number");
  assert.match(normalized, /<INSERTION_CONTEXT>/u);
});

test("English matches, English misses, and non-English instructions all invoke generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-local-language-rules-"));
  try {
    const source = [
      "function add(",
      "  // @human add the parameters x and y with number types",
      ") {",
      "  // @human add the logic of adding x and y",
      "}",
      "",
      "// @human console log the result of calling the add function with 1,2 parameters",
      "// @human نتیجہ بھی دکھائیں",
      "",
    ].join("\n");
    await writeFile(join(root, "index.ts"), source);
    const units = (await discoverDirectUnits(root, "typescript")).units;
    assert.equal(units.length, 4);
    assert.equal(expectedCodeFromLanguageRules(units[3]!), undefined);
    const compilerReceipt = renderReceipt(
      units,
      "ollama",
      "gemma3:270m",
      "typescript",
      {
        planning: {
          enabled: false,
          adaptive: false,
          projectBlueprint: false,
          fileTodo: false,
          markerTodo: false,
          maxCodingPassesPerUnit: 1,
        },
        compiler: { enabled: true, onUnderspecified: "error" },
      },
    );
    assert.match(compilerReceipt, /Requests : up to 4 model requests/u);
    assert.doesNotMatch(compilerReceipt, /compile locally|Local rules/u);

    let generationCalls = 0;
    const compiled = await generateConversionUnits(
      units,
      async (current) => {
        generationCalls += 1;
        if (current.insertionContext === "parameter-list") return "x: number, y: number";
        if (current.insertionContext === "function-body") return "return x + y;";
        if (current.prompt.includes("نتیجہ")) return 'console.log("نتیجہ");';
        return "console.log(add(1, 2));";
      },
      {
        retries: 0,
        validate: validateGeneratedUnit,
      },
    );
    assert.equal(generationCalls, 4);
    assert.equal(
      (await candidateTextsForGenerated(compiled)).get("index.ts"),
      [
        "function add(",
        "  x: number, y: number",
        ") {",
        "  return x + y;",
        "}",
        "",
        "console.log(add(1, 2));",
        'console.log("نتیجہ");',
        "",
      ].join("\n"),
    );

    await assert.rejects(
      validateGeneratedUnit(units[0]!, "left: number, right: number"),
      /contradicts a deterministic structural check/u,
    );
    let failedGenerationCalls = 0;
    const failed = await generateConversionUnits(
      [units[0]!],
      async () => {
        failedGenerationCalls += 1;
        return "left: number, right: number";
      },
      {
        retries: 0,
        validate: validateGeneratedUnit,
      },
    );
    assert.equal(failedGenerationCalls, 1);
    assert.match(failed[0]?.error ?? "", /structural check/u);
    assert.equal(failed[0]?.code, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler coding requests include the selected skill guidance", async () => {
  let capturedPrompt = "";
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as {
        messages: Array<{ content: string }>;
      };
      capturedPrompt = request.messages.map((message) => message.content).join("\n");
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        message: { content: "x: number, y: number" },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const code = await generateCode(
      "add the parameters x and y with number types",
      {
        provider: "ollama",
        model: "fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        language: "typescript",
        targetPath: "sample.ts",
        inline: true,
        insertionContext: "parameter-list",
        compilerMode: true,
      },
    );
    assert.equal(code, "x: number, y: number");
    assert.match(capturedPrompt, /<SELECTED_SKILLS>/u);
    assert.match(capturedPrompt, /<SKILL name="insertion-grammar">/u);
    assert.match(capturedPrompt, /<SKILL name="typescript-local-code">/u);
    assert.match(capturedPrompt, /<SKILL name="type-correctness">/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
