/**
 * The shared contract agreed once per run, before any file is generated.
 *
 * Every target is generated in its own request and those requests cannot see
 * each other, so without a vocabulary fixed up front the markup invents one set
 * of class names and the stylesheet invents another. This module holds the
 * strict parser for that agreement and renders it back into prompts.
 *
 * The blueprint is model output, so it is untrusted evidence throughout: every
 * path is checked against the real planned targets, every free-text field is
 * bounded, and any parse failure discards the blueprint rather than failing the
 * run.
 */
import { scanSecrets } from "../memory/context.ts";

export const BLUEPRINT_VOCABULARY_KINDS: readonly string[] = Object.freeze([
  "class", "id", "attribute", "selector", "cssVariable", "symbol", "route", "event", "dataKey",
]);

export type BlueprintVocabularyKind = (typeof BLUEPRINT_VOCABULARY_KINDS)[number];

export interface BlueprintFile {
  path: string;
  responsibility: string;
}

export interface BlueprintVocabularyEntry {
  name: string;
  kind: BlueprintVocabularyKind;
  definedIn: string;
  usedIn: string[];
  note?: string;
}

export interface ProjectBlueprint {
  files: BlueprintFile[];
  vocabulary: BlueprintVocabularyEntry[];
}

const MAX_BLUEPRINT_FILES = 64;
const MAX_VOCABULARY_ENTRIES = 200;
const MAX_USED_IN = 16;
const MAX_RESPONSIBILITY_CHARS = 280;
const MAX_NOTE_CHARS = 180;
/** Deliberately narrow: a name that can hold a newline can smuggle an instruction. */
const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$:.\-/]{0,119}$/u;

function oneLine(value: string, limit: number): string {
  const clean = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

function ownKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly validate the planning JSON against the exact set of planned targets. */
export function parseProjectBlueprint(
  output: string,
  allowedPaths: ReadonlySet<string>,
): ProjectBlueprint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Project blueprint is not valid JSON.");
  }
  if (!object(parsed) || !ownKeys(parsed, ["files", "vocabulary"])) {
    throw new Error("Project blueprint must contain exactly files and vocabulary.");
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > MAX_BLUEPRINT_FILES) {
    throw new Error(`Project blueprint files must be an array with 1-${MAX_BLUEPRINT_FILES} entries.`);
  }
  if (!Array.isArray(parsed.vocabulary) || parsed.vocabulary.length > MAX_VOCABULARY_ENTRIES) {
    throw new Error(`Project blueprint vocabulary must be an array with at most ${MAX_VOCABULARY_ENTRIES} entries.`);
  }

  const seenPaths = new Set<string>();
  const files: BlueprintFile[] = parsed.files.map((value, index) => {
    if (!object(value) || !ownKeys(value, ["path", "responsibility"])) {
      throw new Error(`Project blueprint file ${index} has unknown or missing fields.`);
    }
    if (typeof value.path !== "string" || !allowedPaths.has(value.path)) {
      throw new Error(`Project blueprint file ${index} names a path that is not a planned target.`);
    }
    if (seenPaths.has(value.path)) throw new Error(`Project blueprint repeats the path ${value.path}.`);
    seenPaths.add(value.path);
    if (typeof value.responsibility !== "string") {
      throw new Error(`Project blueprint file ${index} has an invalid responsibility.`);
    }
    const responsibility = oneLine(value.responsibility, MAX_RESPONSIBILITY_CHARS);
    if (responsibility.length === 0) {
      throw new Error(`Project blueprint file ${index} has an empty responsibility.`);
    }
    return { path: value.path, responsibility };
  });

  const seenNames = new Set<string>();
  const vocabulary: BlueprintVocabularyEntry[] = parsed.vocabulary.map((value, index) => {
    if (!object(value) || (!ownKeys(value, ["definedIn", "kind", "name", "usedIn"])
      && !ownKeys(value, ["definedIn", "kind", "name", "note", "usedIn"]))) {
      throw new Error(`Project blueprint vocabulary ${index} has unknown or missing fields.`);
    }
    if (typeof value.name !== "string" || !NAME_PATTERN.test(value.name)) {
      throw new Error(`Project blueprint vocabulary ${index} has an invalid name.`);
    }
    if (typeof value.kind !== "string" || !BLUEPRINT_VOCABULARY_KINDS.includes(value.kind)) {
      throw new Error(`Project blueprint vocabulary ${index} has an unknown kind.`);
    }
    const key = `${value.kind}:${value.name}`;
    if (seenNames.has(key)) {
      throw new Error(`Project blueprint vocabulary repeats ${value.kind} ${value.name}.`);
    }
    seenNames.add(key);
    if (typeof value.definedIn !== "string" || !allowedPaths.has(value.definedIn)) {
      throw new Error(`Project blueprint vocabulary ${index} names an unknown definedIn path.`);
    }
    if (!Array.isArray(value.usedIn) || value.usedIn.length > MAX_USED_IN) {
      throw new Error(`Project blueprint vocabulary ${index} must list 0-${MAX_USED_IN} usedIn paths.`);
    }
    const usedIn = value.usedIn.map((path) => {
      if (typeof path !== "string" || !allowedPaths.has(path) || path === value.definedIn) {
        throw new Error(`Project blueprint vocabulary ${index} names an unknown or self-referential usedIn path.`);
      }
      return path;
    });
    if (new Set(usedIn).size !== usedIn.length) {
      throw new Error(`Project blueprint vocabulary ${index} repeats a usedIn path.`);
    }
    const note = typeof value.note === "string" ? oneLine(value.note, MAX_NOTE_CHARS) : undefined;
    return {
      name: value.name,
      kind: value.kind,
      definedIn: value.definedIn,
      usedIn,
      ...(note !== undefined && note.length > 0 ? { note } : {}),
    };
  });

  const blueprint: ProjectBlueprint = { files, vocabulary };
  if (scanSecrets(renderBlueprint(blueprint)).length > 0) {
    throw new Error("Project blueprint contains credential-like content and was discarded.");
  }
  return blueprint;
}

function vocabularyLine(entry: BlueprintVocabularyEntry): string {
  const used = entry.usedIn.length > 0 ? `; used by ${entry.usedIn.join(", ")}` : "";
  const note = entry.note === undefined ? "" : ` — ${entry.note}`;
  return `${entry.kind} "${entry.name}" defined in ${entry.definedIn}${used}${note}`;
}

/** Render the whole agreement, used for secret scanning and for the todo pass. */
export function renderBlueprint(blueprint: ProjectBlueprint): string {
  return [
    "FILE ROSTER:",
    ...blueprint.files.map((file) => `- ${file.path} — ${file.responsibility}`),
    ...(blueprint.vocabulary.length > 0
      ? ["SHARED NAMES (use these exact spellings):", ...blueprint.vocabulary.map((entry) => `- ${vocabularyLine(entry)}`)]
      : []),
  ].join("\n");
}

/**
 * Render the agreement for one target: entries that target owns or must consume
 * first, then a bounded tail so it still sees the wider vocabulary.
 */
export function renderBlueprintFor(
  blueprint: ProjectBlueprint,
  targetPath: string,
  maxEntries = 40,
): string {
  const relevant = blueprint.vocabulary.filter((entry) =>
    entry.definedIn === targetPath || entry.usedIn.includes(targetPath));
  const rest = blueprint.vocabulary.filter((entry) => !relevant.includes(entry));
  const selected = [...relevant, ...rest].slice(0, Math.max(0, maxEntries));
  const owned = selected.filter((entry) => entry.definedIn === targetPath);
  const consumed = selected.filter((entry) => entry.usedIn.includes(targetPath));
  const other = selected.filter((entry) => !owned.includes(entry) && !consumed.includes(entry));
  return [
    "FILE ROSTER:",
    ...blueprint.files.map((file) =>
      `- ${file.path}${file.path === targetPath ? " [THIS TARGET]" : ""} — ${file.responsibility}`),
    ...(owned.length > 0
      ? ["NAMES THIS TARGET DEFINES (other files depend on these exact spellings):",
        ...owned.map((entry) => `- ${vocabularyLine(entry)}`)]
      : []),
    ...(consumed.length > 0
      ? ["NAMES THIS TARGET MUST USE VERBATIM:", ...consumed.map((entry) => `- ${vocabularyLine(entry)}`)]
      : []),
    ...(other.length > 0
      ? ["OTHER AGREED NAMES IN THIS RUN:", ...other.map((entry) => `- ${vocabularyLine(entry)}`)]
      : []),
  ].join("\n");
}

/** Every agreed name, used to constrain what a todo list may claim to produce. */
export function blueprintNames(blueprint: ProjectBlueprint): Set<string> {
  return new Set(blueprint.vocabulary.map((entry) => entry.name));
}
