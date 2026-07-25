import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileKey,
  compileUnitId,
  type CompileKeyInput,
  type ConversionUnit,
} from "../src/index.ts";

const BASE: CompileKeyInput = {
  instruction: "write  a function\nthat adds",
  targetPath: "src/add.ts",
  language: "typescript",
  kind: "file",
  resolvedFacets: { "button.action": "specified" },
  promptVersion: 1,
  provider: "ollama",
  model: "fixture",
  skillsDigest: "a".repeat(64),
  renderedContextDigest: "b".repeat(64),
};

test("compile keys normalize whitespace and canonicalize facet insertion order", () => {
  const first = compileKey(BASE);
  const second = compileKey({
    ...BASE,
    instruction: "write a function that adds",
    resolvedFacets: Object.fromEntries(
      Object.entries(BASE.resolvedFacets).reverse(),
    ),
  });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("each compile-key input changes the identity", () => {
  const base = compileKey(BASE);
  const variants: CompileKeyInput[] = [
    { ...BASE, instruction: "write a subtract function" },
    { ...BASE, targetPath: "src/subtract.ts" },
    { ...BASE, language: "javascript" },
    { ...BASE, kind: "inline" },
    { ...BASE, resolvedFacets: {} },
    { ...BASE, promptVersion: 2 },
    { ...BASE, provider: "openai" },
    { ...BASE, model: "other" },
    { ...BASE, skillsDigest: "c".repeat(64) },
    { ...BASE, renderedContextDigest: "d".repeat(64) },
  ];
  for (const variant of variants) assert.notEqual(compileKey(variant), base);
});

test("same-line inline markers have distinct stable lock identities", () => {
  const inline = (start: number, prompt: string): ConversionUnit => ({
    kind: "inline",
    sourcePath: "src/app.ts",
    absoluteSource: "/workspace/src/app.ts",
    prompt,
    language: "typescript",
    range: { start, end: start + prompt.length },
    expectedMarker: prompt,
    line: 1,
    describe: prompt,
  });
  const first = compileUnitId(inline(0, "first marker"));
  const second = compileUnitId(inline(32, "second marker"));
  assert.notEqual(first, second);
  assert.equal(first, compileUnitId(inline(0, "changed instruction")));
});
