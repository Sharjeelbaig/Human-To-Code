/**
 * Per-unit planning and the guard that makes a second coding pass safe.
 *
 * A todo list is agreed for one target before it is written, then a
 * deterministic coverage check looks for the artifacts that list promised. Only
 * a real coverage gap triggers a refinement request, and the refinement is
 * accepted only if it keeps everything the previous pass produced — the
 * regression ratchet. That inverts the usual risk of re-emitting a whole file:
 * a model that drops most of a stylesheet loses its own output, not the run's.
 *
 * Coverage means "the named artifact appears in the output", never "the
 * requirement is implemented" and never verification.
 */
import { extname } from "node:path";
import { extractStaticFileMemory } from "../../pipeline/file-memory.ts";
import { BLUEPRINT_VOCABULARY_KINDS, type BlueprintVocabularyKind } from "./project-blueprint.ts";
import { cssFacts, htmlFacts, javaScriptFacts } from "./project-contracts.ts";

export interface UnitTodoExpectation {
  kind: BlueprintVocabularyKind;
  names: string[];
}

export interface UnitTodo {
  id: string;
  requirement: string;
  expects?: UnitTodoExpectation;
}

export interface UnitTodoList {
  todos: UnitTodo[];
}

export interface TodoCoverage {
  /** Todo ids whose expected artifacts were all found in the candidate. */
  addressed: string[];
  /** Todo ids that promised artifacts the candidate does not contain. */
  unaddressed: string[];
  /** Todo ids with nothing statically checkable; disclosed, never gating. */
  unverifiable: string[];
}

const MAX_TODOS = 24;
const MAX_EXPECTED_NAMES = 8;
const MAX_REQUIREMENT_CHARS = 240;
const ID_PATTERN = /^T[0-9]{1,2}$/u;
const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$:.\-/]{0,119}$/u;
/** A refinement may not shrink a file below this fraction of the previous pass. */
export const MIN_REFINEMENT_LENGTH_RATIO = 0.6;

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

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

/**
 * Strictly validate a todo list. When `allowedNames` is supplied, an expectation
 * naming something outside the agreed vocabulary is dropped rather than
 * rejected: the requirement text is still useful, and a stray name must never
 * become a new instruction.
 */
export function parseUnitTodoList(output: string, allowedNames?: ReadonlySet<string>): UnitTodoList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Todo list is not valid JSON.");
  }
  if (!object(parsed) || !ownKeys(parsed, ["todos"])) {
    throw new Error("Todo list must contain exactly todos.");
  }
  if (!Array.isArray(parsed.todos) || parsed.todos.length === 0 || parsed.todos.length > MAX_TODOS) {
    throw new Error(`Todo list must be an array with 1-${MAX_TODOS} entries.`);
  }
  const seen = new Set<string>();
  const todos: UnitTodo[] = parsed.todos.map((value, index) => {
    if (!object(value) || (!ownKeys(value, ["id", "requirement"]) && !ownKeys(value, ["expects", "id", "requirement"]))) {
      throw new Error(`Todo ${index} has unknown or missing fields.`);
    }
    if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
      throw new Error(`Todo ${index} has an invalid id.`);
    }
    if (seen.has(value.id)) throw new Error(`Todo list repeats the id ${value.id}.`);
    seen.add(value.id);
    if (typeof value.requirement !== "string") throw new Error(`Todo ${index} has an invalid requirement.`);
    const requirement = oneLine(value.requirement, MAX_REQUIREMENT_CHARS);
    if (requirement.length === 0) throw new Error(`Todo ${index} has an empty requirement.`);

    if (value.expects === undefined) return { id: value.id, requirement };
    if (!object(value.expects) || !ownKeys(value.expects, ["kind", "names"])) {
      throw new Error(`Todo ${index} has an invalid expects object.`);
    }
    const { kind, names } = value.expects;
    if (typeof kind !== "string" || !BLUEPRINT_VOCABULARY_KINDS.includes(kind)) {
      throw new Error(`Todo ${index} expects an unknown kind.`);
    }
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_EXPECTED_NAMES) {
      throw new Error(`Todo ${index} must expect 1-${MAX_EXPECTED_NAMES} names.`);
    }
    const cleaned = names.filter((name): name is string =>
      typeof name === "string" && NAME_PATTERN.test(name) && (allowedNames === undefined || allowedNames.has(name)));
    if (cleaned.length === 0) return { id: value.id, requirement };
    return { id: value.id, requirement, expects: { kind, names: [...new Set(cleaned)] } };
  });
  return { todos };
}

/** Names a candidate demonstrably contains, by the file's own syntax. */
function presentNames(targetPath: string, code: string): Set<string> {
  const extension = extname(targetPath).toLowerCase();
  const present = new Set<string>();
  const add = (values: Iterable<string>): void => {
    for (const value of values) if (value.length > 0) present.add(value);
  };
  if (HTML_EXTENSIONS.has(extension)) {
    const facts = htmlFacts(code);
    add(facts.classes);
    add(facts.ids);
    add(facts.handlerCalls);
    add(facts.elements);
  } else if (extension === ".css") {
    const facts = cssFacts(code);
    add(facts.customProperties);
    add(facts.selectors.map((selector) => selector.trim()));
    for (const selector of facts.selectors) {
      add((selector.match(/[.#][A-Za-z0-9_-]+/gu) ?? []).map((token) => token.slice(1)));
    }
  } else if (SCRIPT_EXTENSIONS.has(extension)) {
    const facts = javaScriptFacts(code);
    add(facts.toggledClasses);
    add(facts.selectors);
    for (const selector of facts.selectors) {
      add((selector.match(/[.#][A-Za-z0-9_-]+/gu) ?? []).map((token) => token.slice(1)));
    }
  }
  for (const entry of extractStaticFileMemory(targetPath, code)) {
    add((entry.code.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? []).slice(0, 8));
  }
  return present;
}

function mentionsName(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$-])${escaped}(?:[^A-Za-z0-9_$-]|$)`, "u").test(code);
}

/**
 * Deterministically check which todos left a trace in the candidate. No model
 * request, no execution. Generous on purpose: a false "addressed" only skips a
 * refinement, while a false "unaddressed" would spend a request for nothing.
 */
export function todoCoverage(
  todos: readonly UnitTodo[],
  targetPath: string,
  code: string,
): TodoCoverage {
  const present = presentNames(targetPath, code);
  const coverage: TodoCoverage = { addressed: [], unaddressed: [], unverifiable: [] };
  for (const todo of todos) {
    if (todo.expects === undefined) {
      coverage.unverifiable.push(todo.id);
      continue;
    }
    const missing = todo.expects.names.filter((name) => !present.has(name) && !mentionsName(code, name));
    if (missing.length === 0) coverage.addressed.push(todo.id);
    else coverage.unaddressed.push(todo.id);
  }
  return coverage;
}

/** Render unaddressed todos for a refinement request. */
export function unaddressedRequirements(
  todos: readonly UnitTodo[],
  coverage: TodoCoverage,
): string[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  return coverage.unaddressed.flatMap((id) => {
    const todo = byId.get(id);
    if (todo === undefined) return [];
    const names = todo.expects === undefined ? "" : ` (expected ${todo.expects.kind}: ${todo.expects.names.join(", ")})`;
    return [`${todo.id}: ${todo.requirement}${names}`];
  });
}

/** Render a todo list into the block the coding prompt receives. */
export function renderTodoList(todos: readonly UnitTodo[]): string {
  return todos.map((todo) => {
    const names = todo.expects === undefined
      ? ""
      : ` [must produce ${todo.expects.kind}: ${todo.expects.names.join(", ")}]`;
    return `${todo.id}. ${todo.requirement}${names}`;
  }).join("\n");
}

/** Countable artifacts a refinement is not allowed to lose. */
function ratchetSet(targetPath: string, code: string): Set<string> {
  const extension = extname(targetPath).toLowerCase();
  const values = new Set<string>();
  if (HTML_EXTENSIONS.has(extension)) {
    const facts = htmlFacts(code);
    for (const value of facts.ids) values.add(`id:${value}`);
    for (const value of facts.classes) values.add(`class:${value}`);
  } else if (extension === ".css") {
    const facts = cssFacts(code);
    for (const value of facts.selectors) values.add(`selector:${value.trim()}`);
    for (const value of facts.customProperties) values.add(`var:${value}`);
  } else if (SCRIPT_EXTENSIONS.has(extension)) {
    const facts = javaScriptFacts(code);
    for (const value of facts.selectors) values.add(`selector:${value}`);
    for (const value of facts.modules) values.add(`module:${value}`);
  }
  for (const entry of extractStaticFileMemory(targetPath, code)) {
    values.add(`declaration:${entry.code.trim()}`);
  }
  values.delete("");
  return values;
}

export interface ContractRegression {
  /** Artifacts present in the previous pass and absent from the next one. */
  lost: string[];
  /** Next length divided by previous length. */
  shrinkRatio: number;
}

/** Compare two passes over the same target. Empty `lost` plus an acceptable ratio means the refinement kept everything. */
export function contractRegression(
  targetPath: string,
  previous: string,
  next: string,
): ContractRegression {
  const before = ratchetSet(targetPath, previous);
  const after = ratchetSet(targetPath, next);
  const lost = [...before].filter((value) => !after.has(value));
  const previousLength = previous.trim().length;
  const shrinkRatio = previousLength === 0 ? 1 : next.trim().length / previousLength;
  return { lost, shrinkRatio };
}

/** The ratchet: a refinement is only accepted when it is a strict improvement in coverage terms. */
export function acceptsRefinement(regression: ContractRegression): boolean {
  return regression.lost.length === 0 && regression.shrinkRatio >= MIN_REFINEMENT_LENGTH_RATIO;
}
