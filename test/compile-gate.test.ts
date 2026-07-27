import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("compile gate rejects unresolved imports requested in natural-language comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-compile-import-"));
  try {
    const compiler = validateConfig({
      schemaVersion: 1,
      compiler: { enabled: true, onUnderspecified: "warn" },
    }).compiler;
    const sourcePath = "src/app.ts";
    const importUnit: ConversionUnit = {
      kind: "inline",
      sourcePath,
      absoluteSource: join(root, sourcePath),
      prompt: 'Import { formatUser } from "./missing/format.js" and use it here.',
      range: { start: 0, end: 1 },
      describe: "import a formatter",
      line: 7,
    };

    const result = await runCompileGate([importUnit], compiler);

    assert.equal(result.blocked, true);
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(result.diagnostics[0], {
      code: "E-IMPORT-UNRESOLVED",
      rule: "import",
      severity: "error",
      sourcePath,
      line: 7,
      targetPath: sourcePath,
      message:
        'The requested import "./missing/format.js" cannot be resolved from src/app.ts.',
      facets: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compile gate accepts existing, package, builtin, and planned imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-compile-import-valid-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "existing.ts"), "export const value = 1;\n");
    await mkdir(join(root, "node_modules", "example-package"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules", "example-package", "package.json"),
      JSON.stringify({ main: "index.js" }),
    );
    await writeFile(
      join(root, "node_modules", "example-package", "index.js"),
      "export default true;\n",
    );
    const compiler = validateConfig({
      schemaVersion: 1,
      compiler: { enabled: true },
    }).compiler;
    const importing: ConversionUnit = {
      kind: "file",
      sourcePath: "src/app.human",
      absoluteSource: join(root, "src", "app.human"),
      outputPath: "src/app.ts",
      language: "typescript",
      prompt: [
        'import { value } from "./existing.js"',
        'import { join } from "node:path"',
        'import { helper } from "./planned.js"',
        'import example from "example-package"',
      ].join("\n"),
      describe: "generate app.ts",
    };
    const planned: ConversionUnit = {
      kind: "file",
      sourcePath: "src/planned.human",
      absoluteSource: join(root, "src", "planned.human"),
      outputPath: "src/planned.ts",
      language: "typescript",
      prompt: "Export a helper function.",
      describe: "generate planned.ts",
    };

    const result = await runCompileGate([importing, planned], compiler);

    assert.equal(result.blocked, false);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
