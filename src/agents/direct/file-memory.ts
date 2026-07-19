/**
 * Runs direct generation one file at a time, showing the model only bounded
 * declarations and code that has already been accepted.
 */
import { readFile } from "node:fs/promises";
import { ContextSecurityError, scanSecrets } from "../../context/context.ts";
import { extractStaticFileMemory } from "../../pipeline/file-memory.ts";
import { declaredIdentifiers } from "./declarations.ts";
import { formatInlineReplacement } from "./replacement.ts";
import {
  acceptsRefinement,
  contractRegression,
  renderTodoList,
  todoCoverage,
  unaddressedRequirements,
  type TodoCoverage,
  type UnitTodoList,
} from "./unit-todos.ts";
import type {
  ConversionUnit,
  FileMemoryEntry,
  GeneratedConversionUnit,
  GenerateUnitsOptions,
  UnitGenerationContext,
} from "./types.ts";

export class FileMemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileMemoryConflictError";
  }
}

function stripMemorySeparator(value: string): string | undefined {
  let offset = 0;
  for (;;) {
    if (value.startsWith("\r\n", offset)) offset += 2;
    else if (value.startsWith("\n", offset)) offset += 1;
    else if (value.startsWith("\\r\\n", offset)) offset += 4;
    else if (value.startsWith("\\n", offset)) offset += 2;
    else if (value[offset] === " " || value[offset] === "\t") offset += 1;
    else break;
  }
  return offset > 0 ? value.slice(offset) : undefined;
}

/** Ephemeral declaration memory shared by markers in one source file. */
export class FileMemory {
  readonly sourcePath: string;
  readonly #generatedEntries: FileMemoryEntry[] = [];
  #staticEntries: FileMemoryEntry[];
  #virtualText: string;
  #characterDelta = 0;

  constructor(sourcePath: string, sourceText: string) {
    this.sourcePath = sourcePath;
    this.#virtualText = sourceText;
    this.#staticEntries = extractStaticFileMemory(sourcePath, sourceText);
  }

  get entries(): readonly FileMemoryEntry[] {
    const unique = new Map<string, FileMemoryEntry>();
    const staticEntries = this.#staticEntries.filter((entry) =>
      !this.#generatedEntries.some((generated) =>
        entry.startLine >= generated.startLine && entry.endLine <= generated.endLine));
    for (const entry of [...staticEntries, ...this.#generatedEntries]) {
      unique.set(`${entry.startLine}:${entry.endLine}:${entry.code}`, entry);
    }
    return [...unique.values()]
      .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine || left.code.localeCompare(right.code))
      .map((entry) => ({ ...entry }));
  }

  rememberReplacement(range: { start: number; end: number }, code: string): void {
    const replacement = code.trim();
    if (replacement.length === 0) return;
    const start = range.start + this.#characterDelta;
    const end = range.end + this.#characterDelta;
    if (start < 0 || end < start || end > this.#virtualText.length) {
      throw new Error(`Cannot update FileMemory for ${this.sourcePath}: marker range is stale.`);
    }
    const marker = this.#virtualText.slice(start, end);
    if (!marker.includes("@human")) {
      throw new Error(`Cannot update FileMemory for ${this.sourcePath}: expected an @human marker.`);
    }
    const startLine = 1 + (this.#virtualText.slice(0, start).match(/\n/g)?.length ?? 0);
    const endLine = startLine + (replacement.match(/\n/g)?.length ?? 0);
    const formatted = formatInlineReplacement(this.#virtualText, { start, end }, replacement);
    this.#virtualText = `${this.#virtualText.slice(0, start)}${formatted}${this.#virtualText.slice(end)}`;
    this.#characterDelta += formatted.length - (range.end - range.start);
    this.#generatedEntries.push({ startLine, endLine, code: replacement, fragment: false });
    this.#staticEntries = extractStaticFileMemory(this.sourcePath, this.#virtualText);
  }

  render(): string {
    const rendered = this.entries
      .map((entry) => `line ${entry.startLine} to line ${entry.endLine}:\n${entry.code}`)
      .join("\n\n");
    if (scanSecrets(rendered).length > 0) {
      throw new ContextSecurityError(
        "SECRET_DETECTED",
        `FileMemory for ${this.sourcePath} contains credential-like declaration content.`,
        this.sourcePath,
      );
    }
    return rendered;
  }

  normalizeReplacement(code: string): string {
    const original = code.trim();
    let normalized = original;
    let removedPrefix = false;
    const entries = [...this.entries].sort((left, right) => right.code.length - left.code.length);
    for (;;) {
      const repeated = entries.find((entry) => !entry.fragment && normalized.startsWith(entry.code));
      if (!repeated) break;
      const remainder = normalized.slice(repeated.code.length);
      if (remainder.length === 0) {
        normalized = "";
        removedPrefix = true;
        break;
      }
      const withoutSeparator = stripMemorySeparator(remainder);
      if (withoutSeparator === undefined) break;
      normalized = withoutSeparator.trimStart();
      removedPrefix = true;
    }
    if (removedPrefix && normalized.length === 0) {
      throw new FileMemoryConflictError(
        `The provider only repeated existing FileMemory for ${this.sourcePath}; the current marker was not implemented.`,
      );
    }

    const remembered = new Set(this.#generatedEntries.flatMap((entry) => [...declaredIdentifiers(this.sourcePath, entry.code)]));
    const conflicts = [...declaredIdentifiers(this.sourcePath, normalized)].filter((identifier) => remembered.has(identifier));
    if (conflicts.length > 0) {
      throw new FileMemoryConflictError(
        `The provider redeclared FileMemory identifier${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")} in ${this.sourcePath}.`,
      );
    }
    return normalized;
  }
}

/**
 * Generates one code candidate per instruction unit, without changing any
 * source file.
 */
export async function generateConversionUnits(
  units: readonly ConversionUnit[],
  generator: (unit: ConversionUnit, context: UnitGenerationContext) => Promise<string>,
  options: GenerateUnitsOptions = {},
): Promise<GeneratedConversionUnit[]> {
  const ordered = [...units].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
    const byPath = left.sourcePath.localeCompare(right.sourcePath);
    if (byPath !== 0) return byPath;
    return (left.range?.start ?? 0) - (right.range?.start ?? 0);
  });
  const memories = new Map<string, FileMemory>();
  const generated: GeneratedConversionUnit[] = [];
  const maxAttempts = 1 + Math.max(0, options.retries ?? 1);
  // Orthogonal to `retries`: retries recover from a failed request and restart
  // from pass 1 with no draft, while coding passes close a todo coverage gap.
  const maxCodingPasses = Math.max(1, options.maxCodingPasses ?? 1);
  const contextCharBudget = options.contextCharBudget ?? Number.MAX_SAFE_INTEGER;

  for (const unit of ordered) {
    let memory: FileMemory | undefined;
    if (unit.kind === "inline") {
      memory = memories.get(unit.absoluteSource);
      if (!memory) {
        memory = new FileMemory(unit.sourcePath, await readFile(unit.absoluteSource, "utf8"));
        memories.set(unit.absoluteSource, memory);
      }
    }

    let code: string | undefined;
    let failure: string | undefined;
    let todoRequests = 0;
    let codingRequests = 0;
    let refinementRejected: string | undefined;
    let coverage: TodoCoverage = { addressed: [], unaddressed: [], unverifiable: [] };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.onProgress?.({ kind: "start", unit, attempt });
      try {
        const renderedMemory = memory?.render();
        if ((renderedMemory?.length ?? 0) > contextCharBudget) {
          throw new ContextSecurityError(
            "BUDGET_EXCEEDED",
            `FileMemory for ${unit.sourcePath} exceeds the configured context budget.`,
            unit.sourcePath,
          );
        }
        const remaining = Math.max(0, contextCharBudget - (renderedMemory?.length ?? 0));
        const renderedProjectMemory = options.projectMemory?.renderFor(unit, remaining);
        const baseContext: UnitGenerationContext = {
          inline: unit.kind === "inline",
          ...(renderedMemory ? { fileMemory: renderedMemory } : {}),
          ...(renderedProjectMemory ? { projectMemory: renderedProjectMemory } : {}),
        };

        // Planning enriches context; it is never allowed to fail the unit.
        let todos: UnitTodoList | undefined;
        if (options.plan) {
          options.onProgress?.({ kind: "plan", unit });
          try {
            todos = await options.plan(unit, baseContext);
            todoRequests += 1;
          } catch {
            todos = undefined;
          }
        }
        const todoBlock = todos === undefined ? undefined : renderTodoList(todos.todos);

        const rawCode = await generator(unit, {
          ...baseContext,
          ...(todoBlock ? { todos: todoBlock } : {}),
        });
        codingRequests += 1;
        code = memory && renderedMemory ? memory.normalizeReplacement(rawCode) : rawCode;
        await options.validate?.(unit, code);

        // Refine only on a real coverage gap, and keep the refinement only if it
        // preserves everything this pass already produced.
        const target = unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
        if (todos !== undefined) coverage = todoCoverage(todos.todos, target, code);
        for (
          let pass = 2;
          todos !== undefined && pass <= maxCodingPasses && coverage.unaddressed.length > 0;
          pass += 1
        ) {
          const unaddressed = unaddressedRequirements(todos.todos, coverage);
          options.onProgress?.({ kind: "refine", unit, pass, unaddressed: unaddressed.length });
          let refined: string;
          try {
            const rawRefined = await generator(unit, {
              ...baseContext,
              ...(todoBlock ? { todos: todoBlock } : {}),
              currentDraft: code,
              unaddressedTodos: unaddressed,
            });
            codingRequests += 1;
            refined = memory && renderedMemory ? memory.normalizeReplacement(rawRefined) : rawRefined;
            await options.validate?.(unit, refined);
          } catch (error) {
            refinementRejected = error instanceof Error ? error.message : String(error);
            break;
          }
          const regression = contractRegression(target, code, refined);
          if (!acceptsRefinement(regression)) {
            refinementRejected = regression.lost.length > 0
              ? `refinement dropped ${regression.lost.length} existing item(s); previous pass kept`
              : `refinement shrank the file to ${Math.round(regression.shrinkRatio * 100)}% of the previous pass; previous pass kept`;
            break;
          }
          code = refined;
          coverage = todoCoverage(todos.todos, target, code);
        }
        failure = undefined;
        break;
      } catch (error) {
        if (error instanceof ContextSecurityError) throw error;
        failure = error instanceof Error ? error.message : String(error);
        code = undefined;
      }
    }
    options.onPlanningOutcome?.({
      unit,
      todoRequests,
      codingRequests,
      ...(refinementRejected !== undefined ? { refinementRejected } : {}),
      addressed: coverage.addressed.length,
      unaddressed: coverage.unaddressed.length,
      unverifiable: coverage.unverifiable.length,
    });

    if (failure !== undefined || code === undefined) {
      generated.push({ unit, code: "", error: failure ?? "generation produced no code" });
      options.onProgress?.({ kind: "skip", unit, reason: failure ?? "generation produced no code" });
      continue;
    }
    generated.push({ unit, code });
    if (memory && code.trim().length > 0) memory.rememberReplacement(unit.range!, code);
    if (code.trim().length > 0) options.projectMemory?.remember(unit, code);
    options.onProgress?.({ kind: "done", unit });
  }

  return generated;
}
