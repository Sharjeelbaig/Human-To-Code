import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachModelSkills,
  discoverModelSkills,
  selectModelSkills,
  type ModelSkill,
} from "../src/skills/index.ts";

test("folder names route only relevant web and CSS skills", async () => {
  const skills = await discoverModelSkills();
  const portfolio = selectModelSkills(skills, {
    phase: "coding",
    languages: ["css"],
    targetPaths: ["src/styles/portfolio.css"],
    instructions: [
      "Create complete responsive portfolio styling with grids, focus states, and reduced-motion support.",
    ],
    evidence: ["TSX className project-grid about-bio hero-gradient"],
  }).map((skill) => skill.id);

  assert.deepEqual(portfolio, [
    "css-selector-contracts",
    "css-foundations",
    "css-visual-design",
    "css-accessibility",
    "css-layout",
    "css-motion",
    "css-responsive",
  ]);
  assert.match(
    skills.find((skill) => skill.id === "css-visual-design")?.guidance ?? "",
    /Use a light theme unless the user explicitly requests/u,
  );

  const python = selectModelSkills(skills, {
    phase: "coding",
    languages: ["python"],
    targetPaths: ["parser.py"],
    instructions: ["Parse CSS selector text as plain input."],
  });
  assert.deepEqual(python, []);
});

test("a new markdown skill is discovered and triggered by its folder name", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-skills-"));
  try {
    const directory = join(root, "css-tables");
    await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), "# Tables\nKeep columns readable.\n");
    await writeFile(join(directory, "examples.md"), "# Examples\nUse overflow deliberately.\n");
    await writeFile(join(directory, "ignored.txt"), "not model guidance\n");
    await symlink(directory, join(root, "css-linked"));

    const discovered = await discoverModelSkills(root);
    assert.deepEqual(discovered.map((skill) => skill.id), ["css-tables"]);
    assert.match(discovered[0]!.guidance, /css-tables\/SKILL\.md[\s\S]*css-tables\/examples\.md/u);

    const selected = selectModelSkills(discovered, {
      phase: "coding",
      languages: ["css"],
      targetPaths: ["table.css"],
      instructions: ["Style responsive tables."],
    });
    assert.deepEqual(selected.map((skill) => skill.id), ["css-tables"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected guidance is trusted, bounded prompt context and empty selection is byte-stable", () => {
  const prompt = { system: "system", user: "user" };
  assert.equal(attachModelSkills(prompt, []), prompt);

  const skills: ModelSkill[] = [{ id: "css-selector-contracts", guidance: "Copy exact class names." }];
  const attached = attachModelSkills(prompt, skills);
  assert.match(attached.system, /trusted, package-owned implementation guidance/u);
  assert.match(attached.user, /^<SELECTED_SKILLS>/u);
  assert.match(attached.user, /<SKILL name="css-selector-contracts">[\s\S]*Copy exact class names\./u);
  assert.match(attached.user, /<\/SELECTED_SKILLS>[\s\S]*user$/u);
});
