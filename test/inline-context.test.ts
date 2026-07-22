/** Regression coverage for grammar-aware and atomic inline feature generation. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyInlineFileBatch,
  candidateTextsForGenerated,
  discoverDirectUnits,
  generateConversionUnits,
  normalizeGeneratedUnitCode,
  validateGeneratedUnit,
  withholdIncompleteRelatedTargets,
  type ConversionUnit,
  type GeneratedConversionUnit,
  type ProjectMemoryProvider,
} from "../src/index.ts";
import { buildDirectConversionPrompt } from "../src/prompts/direct-conversion.ts";
import {
  buildDirectTurnClassificationPrompt,
  parseDirectTurnClassification,
} from "../src/prompts/direct-turn-classification.ts";

async function put(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

test("inline discovery records JSX and CSS grammar positions with bounded source", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-context-"));
  try {
    await put(root, "Hero.tsx", "export function Hero() { return <section>{/* @human add glow */}</section>; }\n");
    await put(root, "hero.css", ".hero {\n  /* @human position this container */\n}\n/* @human add the glow rule */\n");
    const { units } = await discoverDirectUnits(root, ["typescript", "css"]);
    assert.deepEqual(units.map((unit) => unit.insertionContext), ["jsx-child", "css-declarations", "css-rule-list"]);
    assert.ok(units.every((unit) => unit.surroundingSource?.includes("<CURRENT_MARKER>")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline prompts state the exact insertion grammar", () => {
  const prompt = buildDirectConversionPrompt({
    languageLabel: "CSS",
    instruction: "position the hero",
    inline: true,
    insertionContext: "css-declarations",
    surroundingSource: ".hero { <CURRENT_MARKER> }",
  });
  assert.match(prompt.system, /declarations only/u);
  assert.match(prompt.system, /Do not output a selector, nested rule, braces/u);
  assert.match(prompt.user, /<INSERTION_CONTEXT>/u);
});

test("every earlier @human message becomes ordered session memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-session-memory-"));
  try {
    const source = [
      "/* @human This is context:",
      "Return the 256th day under the historical Russian calendar.",
      "*/",
      "function dayOfProgrammer(year: number): string {",
      "  // @human Write your code here",
      "}",
      "",
    ].join("\n");
    await put(root, "main.ts", source);

    const { units } = await discoverDirectUnits(root, ["typescript"]);
    assert.equal(units.length, 2);
    const classifiedMemory: Array<string | undefined> = [];
    const generated = await generateConversionUnits(units, async () => {
      return 'return `13.09.${year}`;';
    }, {
      classify: async (unit, context) => {
        classifiedMemory.push(context.sessionMemory);
        return unit === units[0] ? "context" : "edit";
      },
    });
    assert.equal(classifiedMemory[0], undefined);
    assert.match(classifiedMemory[1] ?? "", /historical Russian calendar/u);
    assert.equal(generated[0]!.contextOnly, true);

    const candidate = (await candidateTextsForGenerated(generated)).get("main.ts");
    assert.match(candidate ?? "", /@human This is context:/u);
    assert.match(candidate ?? "", /return `13\.09\.\$\{year\}`;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a strict classifier handles arbitrary conversational turns, not named directives", () => {
  const prompt = buildDirectTurnClassificationPrompt({
    targetPath: "main.ts",
    instruction: "Write your code here",
    sessionMemory: '- main.ts:1: "Hi"',
  });
  assert.match(prompt.system, /greeting, background\/reference information/u);
  assert.match(prompt.system, /exactly \{"action":"context"\}/u);
  assert.match(prompt.user, /<SESSION_MEMORY>\n- main\.ts:1: "Hi"/u);
  assert.equal(parseDirectTurnClassification('{"action":"context"}'), "context");
  assert.equal(parseDirectTurnClassification('{"action":"edit"}'), "edit");
  assert.throws(() => parseDirectTurnClassification('{"action":"context","code":"oops"}'));
});

test("a greeting is retained without blocking the next edit in the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-greeting-memory-"));
  try {
    await put(root, "example.ts", [
      "// @human Hi",
      "// @human declare a result constant",
      "",
    ].join("\n"));

    const { units } = await discoverDirectUnits(root, ["typescript"]);
    const generated = await generateConversionUnits(units, async (_unit, context) => {
      assert.match(context.sessionMemory ?? "", /"Hi"/u);
      return "const result = true;";
    }, {
      classify: async (unit) => unit.prompt === "Hi" ? "context" : "edit",
    });
    assert.equal(generated[0]!.contextOnly, true);
    assert.equal(generated[1]!.code, "const result = true;");
    assert.match((await candidateTextsForGenerated(generated)).get("example.ts") ?? "", /@human Hi[\s\S]*const result = true;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a selector cannot be inserted into a CSS declaration body", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-css-context-"));
  try {
    const source = ".hero {\n  /* @human add layout */\n}\n";
    await put(root, "hero.css", source);
    const unit = (await discoverDirectUnits(root, ["css"])).units[0]!;
    assert.equal(unit.insertionOwner, ".hero");
    assert.equal(
      normalizeGeneratedUnitCode(unit, ".hero { position: relative; overflow: hidden; }"),
      "position: relative; overflow: hidden;",
    );
    await assert.rejects(
      validateGeneratedUnit(unit, ".hero { position: relative; }"),
      /repeated or introduced a non-relative selector/u,
    );
    await validateGeneratedUnit(unit, "position: relative;\noverflow: hidden;");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete candidates combine markers and one atomic write applies them", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-inline-batch-"));
  try {
    const source = ".hero {\n  /* @human layout */\n}\n/* @human gradient */\n";
    await put(root, "hero.css", source);
    const units = (await discoverDirectUnits(root, ["css"])).units;
    const generated: GeneratedConversionUnit[] = [
      { unit: units[0]!, code: "position: relative;" },
      { unit: units[1]!, code: ".hero-bg { position: absolute; background: linear-gradient(red, blue); }" },
    ];
    const candidates = await candidateTextsForGenerated(generated);
    assert.match(candidates.get("hero.css") ?? "", /\.hero \{\s+position: relative;/u);
    assert.match(candidates.get("hero.css") ?? "", /\.hero-bg \{/u);
    assert.equal(await applyInlineFileBatch(generated), "hero.css");
    const written = await readFile(join(root, "hero.css"), "utf8");
    assert.equal(written, candidates.get("hero.css"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one failed marker withholds its file and evidenced companion targets", () => {
  const css: ConversionUnit = { kind: "inline", sourcePath: "hero.css", absoluteSource: "/tmp/hero.css", prompt: "style", describe: "css" };
  const tsx: ConversionUnit = { kind: "inline", sourcePath: "Hero.tsx", absoluteSource: "/tmp/Hero.tsx", prompt: "markup", describe: "tsx" };
  const memory: ProjectMemoryProvider = {
    renderFor: () => "",
    remember: () => undefined,
    relationsFor: (unit) => unit === css
      ? [{ path: "Hero.tsx", state: "planned", role: "stylesheet companion", reference: "./Hero" }]
      : [{ path: "hero.css", state: "planned", role: "imported stylesheet", reference: "./hero.css" }],
  };
  const result = withholdIncompleteRelatedTargets([
    { unit: css, code: "position: relative;" },
    { unit: tsx, code: "", error: "invalid JSX" },
  ], memory);
  assert.match(result[0]!.error ?? "", /related conversion group was withheld/u);
  assert.equal(result[0]!.code, "");
});

test("a deterministic retry receives the rejected draft and validator diagnostic", async () => {
  const unit: ConversionUnit = {
    kind: "file",
    sourcePath: "feature.human",
    absoluteSource: "/tmp/feature.human",
    outputPath: "feature.ts",
    prompt: "add feature",
    describe: "feature",
  };
  const contexts: Array<{ rejectedDraft?: string; validationFailure?: string }> = [];
  const result = await generateConversionUnits([unit], async (_unit, context) => {
    contexts.push(context);
    return contexts.length === 1 ? "invalid" : "export const valid = true;";
  }, {
    retries: 1,
    validate: async (_candidateUnit, code) => {
      if (code === "invalid") throw new Error("syntax diagnostic");
    },
  });
  assert.equal(result[0]!.code, "export const valid = true;");
  assert.equal(contexts[1]!.rejectedDraft, "invalid");
  assert.equal(contexts[1]!.validationFailure, "syntax diagnostic");
});
