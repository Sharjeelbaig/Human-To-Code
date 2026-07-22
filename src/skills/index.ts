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
const MAX_SKILL_FILES = 32;
const MAX_FILE_CHARS = 12_000;
const MAX_SELECTED_SKILLS = 8;
const MAX_TOTAL_GUIDANCE_CHARS = 36_000;
const GENERIC_NAME_PARTS = new Set(["css", "web", "skill"]);

/** Synonyms stay keyed by folder-name words, so directory names remain the routing API. */
const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  accessibility: ["accessible", "a11y", "aria", "contrast", "focus", "keyboard", "screen reader"],
  contracts: ["contract", "class", "classname", "id", "markup", "selector"],
  foundations: ["base", "design", "global", "reset", "style", "stylesheet", "theme", "visual"],
  integration: ["class", "classname", "component", "import", "markup", "style", "stylesheet"],
  layout: ["card", "container", "flex", "grid", "hero", "layout", "navbar", "portfolio", "section", "spacing"],
  motion: ["animate", "animation", "hover", "motion", "reduced motion", "transition"],
  react: ["jsx", "react", "tsx"],
  responsive: ["adaptive", "breakpoint", "media query", "mobile", "reflow", "responsive", "viewport"],
  selector: ["class", "classname", "dom", "html", "jsx", "markup", "selector", "tsx"],
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
  return [part, ...(TOKEN_ALIASES[part] ?? [])];
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
  const taskText = words([
    ...(input.instructions ?? []),
    ...(input.evidence ?? []),
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

  return skills
    .map((skill) => {
      const parts = skill.id.split("-").filter((part) => !GENERIC_NAME_PARTS.has(part));
      let score = parts.reduce((total, part) =>
        total + (triggerWords(part).some((term) => containsWord(allText, term)) ? 1 : 0), 0);

      // These are the only baseline skills. Domain skills still require a
      // meaningful folder-name word to match the current request or evidence.
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
