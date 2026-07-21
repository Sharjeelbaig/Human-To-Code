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
} from "../src/agents/direct/index.ts";
import { buildDirectConversionPrompt } from "../src/prompts/direct-conversion.ts";

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
  assert.match(prompt.system, /Do not repeat the current selector/u);
  assert.match(prompt.user, /<INSERTION_CONTEXT>/u);
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
