import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COMPILER_LANGUAGE_RULE_PROFILES,
  candidateTextsForGenerated,
  compileInstructionWithLanguageRules,
  discoverDirectUnits,
  generateConversionUnits,
  normalizeCompilerGeneratedUnitCode,
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

test("typed parameter lowering follows each language's declaration order", () => {
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
      compileInstructionWithLanguageRules(unit(language, "parameter-list", prompt)),
      code,
      language,
    );
  }
});

test("arithmetic and call-output rules lower only complete unambiguous instructions", () => {
  assert.equal(
    compileInstructionWithLanguageRules(
      unit("typescript", "function-body", "add the logic of adding x and y"),
    ),
    "return x + y;",
  );
  assert.equal(
    compileInstructionWithLanguageRules(
      unit("python", "function-body", "subtract x from y"),
    ),
    "return y - x",
  );
  assert.equal(
    compileInstructionWithLanguageRules(
      unit(
        "typescript",
        "statement",
        "console log the result of calling the add function with 1,2 parameters",
      ),
    ),
    "console.log(add(1, 2));",
  );
  assert.equal(
    compileInstructionWithLanguageRules(
      unit("typescript", "parameter-list", "add some parameters"),
    ),
    undefined,
  );
  assert.equal(
    compileInstructionWithLanguageRules(
      unit("typescript", "statement", "call a useful function"),
    ),
    undefined,
  );
});

test("compiler rules replace a 270M-style prompt echo with proven target syntax", () => {
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
  assert.equal(
    normalizeCompilerGeneratedUnitCode(parameterUnit, echoed),
    "x: number, y: number",
  );
});

test("compiler lowering bypasses the provider while the ordinary path still calls it", async () => {
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
      "",
    ].join("\n");
    await writeFile(join(root, "index.ts"), source);
    const units = (await discoverDirectUnits(root, "typescript")).units;
    let compilerProviderCalls = 0;
    const compiled = await generateConversionUnits(
      units,
      async () => {
        compilerProviderCalls += 1;
        return "provider must not run";
      },
      {
        retries: 0,
        lower: (current) => compileInstructionWithLanguageRules(current),
        validate: validateGeneratedUnit,
      },
    );
    assert.equal(compilerProviderCalls, 0);
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
        "",
      ].join("\n"),
    );

    let ordinaryProviderCalls = 0;
    const ordinary = await generateConversionUnits(
      [units[0]!],
      async () => {
        ordinaryProviderCalls += 1;
        return "ordinary provider output";
      },
      { retries: 0 },
    );
    assert.equal(ordinaryProviderCalls, 1);
    assert.equal(ordinary[0]?.code, "ordinary provider output");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
