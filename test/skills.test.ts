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
    mode: "file",
    targetPaths: ["src/styles/portfolio.css"],
    instructions: [
      "Create complete responsive portfolio styling with grids, focus states, and reduced-motion support.",
    ],
    evidence: ["TSX className project-grid about-bio hero-gradient"],
  }).map((skill) => skill.id);

  assert.deepEqual(portfolio, [
    "local-intent",
    "minimal-local-change",
    "scope-symbol-contracts",
    "css-foundations",
    "css-selector-contracts",
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
    mode: "file",
    targetPaths: ["parser.py"],
    instructions: ["Parse CSS selector text as plain input."],
  });
  assert.deepEqual(python.map((skill) => skill.id), [
    "local-intent",
    "minimal-local-change",
    "python-local-code",
    "scope-symbol-contracts",
    "data-flow",
  ]);
  assert.equal(python.some((skill) => skill.id.startsWith("css-")), false);
});

test("inline marker grammar and semantic evidence select only applicable skills", async () => {
  const skills = await discoverModelSkills();
  const selected = selectModelSkills(skills, {
    phase: "coding",
    languages: ["typescript", "TypeScript"],
    mode: "inline",
    insertionContexts: ["statement"],
    targetPaths: ["src/service.ts"],
    instructions: ["Return early when result is undefined."],
    evidence: ["function load(): Result { const result = read(); <CURRENT_MARKER> return result; }"],
  }).map((skill) => skill.id);

  for (const expected of [
    "insertion-grammar",
    "local-intent",
    "minimal-local-change",
    "scope-symbol-contracts",
    "typescript-local-code",
    "type-correctness",
    "control-flow",
  ]) assert.ok(selected.includes(expected), `${expected} was not selected: ${selected.join(", ")}`);
  assert.equal(selected.includes("javascript-local-code"), false);
  assert.equal(selected.includes("python-local-code"), false);
  assert.equal(selected.some((skill) => skill.startsWith("css-")), false);
});

test("conditional lifecycle and domain skills require matching local evidence", async () => {
  const skills = await discoverModelSkills();
  const database = selectModelSkills(skills, {
    phase: "coding",
    languages: ["python"],
    mode: "file",
    targetPaths: ["repository.py"],
    instructions: ["Query the database asynchronously and handle connection errors."],
    evidence: ["async await repository database connection"],
  }).map((skill) => skill.id);

  for (const expected of [
    "python-local-code",
    "database-queries",
    "async-lifecycle",
    "error-handling",
    "resource-lifecycle",
  ]) assert.ok(database.includes(expected), `${expected} was not selected: ${database.join(", ")}`);
  assert.equal(database.includes("api-contracts"), false);
  assert.equal(database.includes("security-sensitive-code"), false);

  const config = selectModelSkills(skills, {
    phase: "coding",
    languages: ["json"],
    mode: "inline",
    insertionContexts: ["statement"],
    targetPaths: ["tsconfig.json"],
    instructions: ["Enable strict mode."],
  }).map((skill) => skill.id);
  assert.ok(config.includes("configuration-context"));
  assert.equal(config.includes("documentation-context"), false);
  assert.equal(config.some((skill) => skill.endsWith("-local-code")), false);
});

test("all requested local conversion skills are discoverable by folder name", async () => {
  const discovered = new Set((await discoverModelSkills()).map((skill) => skill.id));
  const requested = [
    "local-intent", "insertion-grammar", "scope-symbol-contracts", "minimal-local-change",
    "type-correctness", "control-flow", "data-flow", "error-handling",
    "async-lifecycle", "resource-lifecycle", "reference-contracts", "api-contracts",
    "database-queries", "security-sensitive-code", "test-context", "configuration-context",
    "documentation-context", "typescript-local-code", "javascript-local-code", "python-local-code",
    "rust-local-code", "go-local-code", "java-local-code", "csharp-local-code",
    "sql-local-code", "shell-local-code",
  ];
  for (const skill of requested) assert.ok(discovered.has(skill), `${skill} was not discovered`);
});

test("each supported target language selects exactly its own local-code skill", async () => {
  const skills = await discoverModelSkills();
  const cases = [
    ["typescript", "src/value.ts", "typescript-local-code"],
    ["javascript", "src/value.js", "javascript-local-code"],
    ["python", "value.py", "python-local-code"],
    ["rust", "src/value.rs", "rust-local-code"],
    ["go", "value.go", "go-local-code"],
    ["java", "Value.java", "java-local-code"],
    ["csharp", "Value.cs", "csharp-local-code"],
    ["sql", "query.sql", "sql-local-code"],
    ["shell", "script.sh", "shell-local-code"],
  ] as const;

  for (const [language, target, expected] of cases) {
    const selected = selectModelSkills(skills, {
      phase: "coding",
      languages: [language],
      mode: "file",
      targetPaths: [target],
      instructions: ["Implement the local behavior."],
    }).map((skill) => skill.id);
    assert.deepEqual(
      selected.filter((skill) => skill.endsWith("-local-code")),
      [expected],
      `${language} selected ${selected.join(", ")}`,
    );
  }
});

test("API, security, test, documentation, and reference skills stay evidence-gated", async () => {
  const skills = await discoverModelSkills();
  const selectedFor = (target: string, instruction: string, evidence = "") =>
    selectModelSkills(skills, {
      phase: "coding",
      languages: [target.endsWith(".ts") ? "typescript" : "markdown"],
      mode: "file",
      targetPaths: [target],
      instructions: [instruction],
      evidence: [evidence],
    }).map((skill) => skill.id);

  assert.ok(selectedFor("src/handler.ts", "Handle the HTTP request and response for this route.")
    .includes("api-contracts"));
  assert.ok(selectedFor("src/auth.ts", "Validate the authentication token and authorization permission.")
    .includes("security-sensitive-code"));
  assert.ok(selectedFor("src/user.test.ts", "Add a regression assertion using the existing fixture.")
    .includes("test-context"));
  assert.ok(selectedFor("README.md", "Document the configuration example.")
    .includes("documentation-context"));
  assert.ok(selectedFor("src/client.ts", "Import and call the exported helper.", "module relationship")
    .includes("reference-contracts"));

  const plain = selectedFor("src/math.ts", "Add two finite numbers.");
  for (const absent of [
    "api-contracts",
    "security-sensitive-code",
    "test-context",
    "documentation-context",
    "reference-contracts",
  ]) assert.equal(plain.includes(absent), false, `${absent} unexpectedly selected: ${plain.join(", ")}`);
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
