import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runCompileGate,
  validateConfig,
  type ConversionUnit,
} from "../src/index.ts";

function unit(sourcePath: string, prompt: string): ConversionUnit {
  return {
    kind: "file",
    sourcePath,
    absoluteSource: `/workspace/${sourcePath}`,
    outputPath: sourcePath.replace(/\.human$/u, ".css"),
    language: "css",
    prompt,
    describe: prompt,
  };
}

test("compile gate blocks errors, warns on request, and never calls semantic diagnostics by default", async () => {
  const compiler = validateConfig({
    schemaVersion: 1,
    compiler: { enabled: true },
  }).compiler;
  let semanticCalls = 0;
  const blocked = await runCompileGate(
    [unit("a.human", "add a gradient")],
    compiler,
    {
      diagnose: async () => {
        semanticCalls += 1;
        return [];
      },
    },
  );
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.semanticRequests, 0);
  assert.equal(semanticCalls, 0);

  const warned = await runCompileGate(
    [unit("a.human", "add a gradient")],
    { ...compiler, onUnderspecified: "warn" },
  );
  assert.equal(warned.blocked, false);
  assert.equal(warned.diagnostics.length, 1);
});

test("semantic diagnostics can only append and fail open", async () => {
  const compiler = validateConfig({
    schemaVersion: 1,
    compiler: {
      enabled: true,
      semanticDiagnostics: true,
    },
  }).compiler;
  const failed = await runCompileGate(
    [unit("a.human", "write a stylesheet")],
    compiler,
    { diagnose: async () => { throw new Error("offline"); } },
  );
  assert.equal(failed.blocked, false);
  assert.equal(failed.semanticRequests, 1);
  assert.equal(failed.warnings.length, 1);
});

