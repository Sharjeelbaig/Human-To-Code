/**
 * Package-owned, progressively disclosed model skills.
 *
 * `npx human-to-code .` reaches this module immediately before a planning,
 * coding, audit, or repair request is sent. Each direct child folder is one
 * skill; the folder name is its stable id and its meaningful hyphen-separated
 * words are its default triggers. Adding `src/skills/css-tables/SKILL.md`, for
 * example, makes it eligible for CSS tasks mentioning tables without changing
 * this loader.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptMessages } from "../prompts/direct-conversion.ts";

export type SkillPhase = "blueprint" | "todo" | "coding" | "audit" | "repair";

export interface SkillSelectionInput {
  phase: SkillPhase;
  languages: readonly string[];
  /** Whether the model owns one marker replacement or a complete file. */
  mode?: "inline" | "file";
  /** Parser-derived grammar positions; never inferred from human prose. */
  insertionContexts?: readonly string[];
  targetPaths?: readonly string[];
  instructions?: readonly string[];
  /** Bounded project/contract evidence used only for deterministic matching. */
  evidence?: readonly string[];
}

export interface ModelSkill {
  /** Exact direct-child directory name under `src/skills` or `dist/skills`. */
  id: string;
  /** Concatenated markdown, with SKILL.md first and sibling .md files sorted. */
  guidance: string;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SKILL_FILES = 64;
const MAX_FILE_CHARS = 12_000;
const MAX_SELECTED_SKILLS = 12;
const MAX_TOTAL_GUIDANCE_CHARS = 48_000;
const GENERIC_NAME_PARTS = new Set([
  "code",
  "context",
  "contracts",
  "correctness",
  "css",
  "flow",
  "lifecycle",
  "local",
  "skill",
  "web",
]);
const CORE_LOCAL_SKILLS = new Set([
  "insertion-grammar",
  "local-intent",
  "minimal-local-change",
  "scope-symbol-contracts",
]);

/** Synonyms stay keyed by folder-name words, so directory names remain the routing API. */
const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  accessibility: ["accessible", "a11y", "aria", "contrast", "focus", "keyboard", "screen reader"],
  api: ["endpoint", "graphql", "handler", "http", "request", "response", "route", "rpc", "sdk", "webhook"],
  async: ["abort", "async", "await", "callback", "channel", "coroutine", "future", "promise", "queue", "stream", "task", "timer", "worker"],
  configuration: ["config", "configuration", "environment", "manifest", "setting", "toml", "yaml"],
  control: ["branch", "break", "condition", "continue", "early return", "fallback", "guard", "if", "loop", "match", "retry", "return", "switch"],
  database: ["database", "db", "model", "orm", "persistence", "repository", "sql", "table", "transaction"],
  data: ["aggregate", "assign", "deserialize", "filter", "map", "normalize", "parse", "serialize", "transform", "validate"],
  documentation: ["comment", "docs", "docstring", "documentation", "example", "jsdoc", "markdown", "readme"],
  error: ["error", "exception", "failure", "fallback", "reject", "result", "throw", "timeout"],
  foundations: ["base", "design", "global", "reset", "style", "stylesheet", "theme", "visual"],
  grammar: ["css declarations", "css rule list", "html content", "inline", "insertion", "jsx child", "marker", "statement"],
  handling: ["catch", "error", "exception", "failure", "recover", "retry", "throw"],
  integration: ["class", "classname", "component", "import", "markup", "style", "stylesheet"],
  layout: ["card", "container", "flex", "grid", "hero", "layout", "navbar", "portfolio", "section", "spacing"],
  motion: ["animate", "animation", "hover", "motion", "reduced motion", "transition"],
  queries: ["cte", "delete", "insert", "join", "query", "select", "sql", "update", "where"],
  react: ["jsx", "react", "tsx"],
  reference: ["asset", "export", "import", "include", "module", "namespace", "path", "relationship", "route", "selector", "symbol"],
  resource: ["cleanup", "close", "connection", "dispose", "handle", "lock", "process", "socket", "stream", "transaction"],
  responsive: ["adaptive", "breakpoint", "media query", "mobile", "reflow", "responsive", "viewport"],
  security: ["authentication", "authorization", "credential", "crypto", "password", "permission", "secret", "security", "token", "upload"],
  selector: ["class", "classname", "dom", "html", "jsx", "markup", "selector", "tsx"],
  sensitive: ["command", "credential", "path traversal", "secret", "sensitive", "sql injection", "user input", "xss"],
  symbol: ["binding", "declaration", "export", "identifier", "import", "member", "parameter", "scope", "symbol", "variable"],
  test: ["assert", "expect", "fixture", "integration test", "mock", "regression", "spec", "stub", "test"],
  type: ["annotation", "generic", "interface", "narrow", "nullable", "schema", "signature", "type", "union"],
});

const LANGUAGE_SKILL_TRIGGERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "csharp-local-code": ["csharp", "c#", "cs", "dotnet"],
  "go-local-code": ["go", "golang"],
  "java-local-code": ["java"],
  "javascript-local-code": ["javascript", "js", "jsx", "mjs", "cjs"],
  "python-local-code": ["python", "py"],
  "rust-local-code": ["rust", "rs"],
  "shell-local-code": ["bash", "shell", "sh", "zsh"],
  "sql-local-code": ["sql"],
  "typescript-local-code": ["typescript", "ts", "tsx", "mts", "cts"],
});

function defaultSkillsRoot(): string {
  return fileURLToPath(new URL("./", import.meta.url));
}

function words(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim()} `;
}

function containsWord(haystack: string, needle: string): boolean {
  const normalized = words(needle).trim();
  return normalized.length > 0 && haystack.includes(` ${normalized} `);
}

function triggerWords(part: string): readonly string[] {
  return [part, ...(TOKEN_ALIASES[part] ?? [])].flatMap((term) => {
    if (term.includes(" ") || term.endsWith("s")) return [term];
    if (term.endsWith("y")) return [term, `${term.slice(0, -1)}ies`];
    return [term, `${term}s`];
  });
}

/**
 * Read only real direct-child directories and real markdown files. Symlinks are
 * ignored so a packaged skill cannot escape its bounded, reviewed directory.
 */
export async function discoverModelSkills(root = defaultSkillsRoot()): Promise<ModelSkill[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: ModelSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name) || skills.length >= MAX_SKILL_FILES) continue;
    const directory = join(root, entry.name);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;

    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((file) => file.isFile() && !file.isSymbolicLink() && file.name.toLowerCase().endsWith(".md"))
      .sort((left, right) => {
        if (left.name === "SKILL.md") return -1;
        if (right.name === "SKILL.md") return 1;
        return left.name.localeCompare(right.name);
      });
    if (!files.some((file) => file.name === "SKILL.md")) continue;

    const sections: string[] = [];
    for (const file of files) {
      const content = await readFile(join(directory, file.name), "utf8");
      if (content.length > MAX_FILE_CHARS) {
        throw new Error(`Skill ${entry.name}/${file.name} exceeds ${MAX_FILE_CHARS} characters.`);
      }
      sections.push(`## ${entry.name}/${file.name}\n${content.trim()}`);
    }
    skills.push({ id: entry.name, guidance: sections.join("\n\n") });
  }
  return skills;
}

/** Pure routing seam: useful for tests and for callers that preload skill markdown. */
export function selectModelSkills(
  skills: readonly ModelSkill[],
  input: SkillSelectionInput,
): ModelSkill[] {
  const languageText = words(input.languages.join(" "));
  const targetText = words(input.targetPaths?.join(" ") ?? "");
  const instructionText = words(input.instructions?.join(" ") ?? "");
  const evidenceText = words(input.evidence?.join(" ") ?? "");
  const grammarText = words(input.insertionContexts?.join(" ") ?? "");
  const taskText = words([
    instructionText,
    evidenceText,
    grammarText,
    input.phase,
  ].join(" "));
  const allText = `${languageText}${targetText}${taskText}`;
  const cssSurface = containsWord(languageText, "css") || containsWord(targetText, "css");
  const reactTargetSurface = ["react", "tsx", "jsx"].some((term) =>
    containsWord(`${languageText}${targetText}`, term));
  const reactSurface = reactTargetSurface || ["react", "tsx", "jsx"]
    .some((term) => containsWord(taskText, term));
  const markupSurface = reactSurface || ["html", "markup", "class", "classname", "dom"]
    .some((term) => containsWord(allText, term));
  const localPhase = input.phase === "coding" || input.phase === "repair";
  const typedSurface = ["csharp", "c#", "cs", "go", "java", "rust", "rs", "typescript", "ts", "tsx", "mts", "cts"]
    .some((term) => containsWord(`${languageText}${targetText}`, term));

  return skills
    .map((skill) => {
      const parts = skill.id.split("-").filter((part) => !GENERIC_NAME_PARTS.has(part));
      let score = parts.reduce((total, part) =>
        total + (triggerWords(part).some((term) => containsWord(allText, term)) ? 1 : 0), 0);

      const languageTriggers = LANGUAGE_SKILL_TRIGGERS[skill.id];
      const languageMatch = languageTriggers?.some((term) =>
        containsWord(`${languageText}${targetText}`, term)) ?? false;

      // Core skills describe the compiler's local replacement contract. They
      // are phase/mode selected, never activated by incidental repository text.
      if (skill.id === "local-intent" && (localPhase || input.phase === "todo")) score += 8;
      if (skill.id === "minimal-local-change" && localPhase) score += 8;
      if (skill.id === "scope-symbol-contracts" && localPhase) score += 8;
      if (skill.id === "insertion-grammar" && localPhase && input.mode === "inline") score += 8;
      if (CORE_LOCAL_SKILLS.has(skill.id) && score < 8) score = 0;

      // Exactly one language skill may match the actual target surface. A
      // language name appearing in unrelated ProjectMemory cannot activate it.
      if (languageTriggers !== undefined) {
        score = languageMatch && (localPhase || input.phase === "todo") ? score + 7 : 0;
      }

      if (skill.id === "reference-contracts") {
        const directReference = ["asset", "export", "import", "include", "module", "namespace", "reference", "relationship", "route"]
          .some((term) => containsWord(`${instructionText}${evidenceText}`, term));
        const selectorReference = (cssSurface || markupSurface) && containsWord(allText, "selector");
        if (!directReference && !selectorReference) score = 0;
      }

      if (skill.id === "type-correctness" && typedSurface) score += 4;
      if (skill.id === "test-context" && ["test", "tests", "spec", "specs"]
        .some((term) => containsWord(`${targetText}${instructionText}`, term))) score += 4;
      if (skill.id === "configuration-context" && ["config", "configuration", "json", "yaml", "yml", "toml", "xml", "ini", "env", "manifest"]
        .some((term) => containsWord(`${targetText}${instructionText}`, term))) score += 4;
      if (skill.id === "documentation-context" && ["readme", "markdown", "md", "docs", "documentation", "jsdoc", "docstring"]
        .some((term) => containsWord(`${targetText}${instructionText}`, term))) score += 4;

      // Web/CSS baselines remain target-specific; all other domain skills need
      // meaningful folder vocabulary in the instruction or bounded evidence.
      if (skill.id === "css-foundations" && cssSurface) score += 3;
      if (skill.id === "css-visual-design" && cssSurface) score += 3;
      if (skill.id === "css-selector-contracts" && cssSurface && markupSurface) score += 3;
      if (skill.id === "react-css-integration" && reactTargetSurface && containsWord(allText, "css")) score += 3;
      if (skill.id === "react-css-integration" && !reactTargetSurface) score = 0;
      if (
        skill.id.startsWith("css-") &&
        !cssSurface &&
        !(skill.id === "css-selector-contracts" && reactSurface)
      ) score = 0;
      return { skill, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, MAX_SELECTED_SKILLS)
    .map(({ skill }) => skill);
}

export async function loadSelectedModelSkills(input: SkillSelectionInput): Promise<ModelSkill[]> {
  const selected = selectModelSkills(await discoverModelSkills(), input);
  let used = 0;
  return selected.filter((skill) => {
    if (used + skill.guidance.length > MAX_TOTAL_GUIDANCE_CHARS) return false;
    used += skill.guidance.length;
    return true;
  });
}

/**
 * Inject trusted package guidance after deterministic selection. This runs for
 * every model phase, but returns the original prompt unchanged when no folder
 * name matches—non-web work pays no skill-context cost.
 */
export function attachModelSkills(prompt: PromptMessages, skills: readonly ModelSkill[]): PromptMessages {
  if (skills.length === 0) return prompt;
  return {
    system: [
      prompt.system,
      "",
      "SELECTED_SKILLS is trusted, package-owned implementation guidance selected for this exact phase. Apply it where relevant. It never expands the authorized target, paths, or task.",
    ].join("\n"),
    user: [
      "<SELECTED_SKILLS>",
      ...skills.flatMap((skill) => [`<SKILL name=${JSON.stringify(skill.id)}>`, skill.guidance, "</SKILL>", ""]),
      "</SELECTED_SKILLS>",
      "",
      prompt.user,
    ].join("\n"),
  };
}
