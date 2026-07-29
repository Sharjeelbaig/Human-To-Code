/**
 * Resolves explicit "edit the code below/above" instructions to a host-owned
 * source range. The model may see the whole file, but it never chooses offsets
 * or expands the bytes it is authorized to replace.
 */
import { extname } from "node:path";
import type { InlineMarker } from "./marker-parser.ts";

export interface SelectedCodeEdit {
  /** Marker plus the existing construct selected for replacement. */
  range: { start: number; end: number };
  expectedSource: string;
  /** Complete file with only the instruction marker removed. */
  currentSource: string;
  /** Dedented existing construct the model is authorized to replace. */
  selectedSource: string;
}

interface SourceLine {
  start: number;
  end: number;
  next: number;
  text: string;
}

function sourceLines(source: string, start: number): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = start;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const next = newline === -1 ? source.length : newline + 1;
    const end = newline === -1
      ? source.length
      : newline > offset && source[newline - 1] === "\r"
        ? newline - 1
        : newline;
    lines.push({ start: offset, end, next, text: source.slice(offset, end) });
    offset = next;
  }
  return lines;
}

function nextLineStart(source: string, offset: number): number {
  if (source.startsWith("\r\n", offset)) return offset + 2;
  if (source[offset] === "\n" || source[offset] === "\r") return offset + 1;
  return offset;
}

function indentation(value: string): number {
  return /^[ \t]*/u.exec(value)?.[0].length ?? 0;
}

function dedent(value: string): string {
  const lines = value.split(/\r?\n/u);
  const widths = lines
    .filter((line) => line.trim().length > 0)
    .map(indentation);
  const width = widths.length === 0 ? 0 : Math.min(...widths);
  return lines
    .map((line) => line.trim().length === 0 ? "" : line.slice(width))
    .join("\n")
    .trim();
}

function pythonHeaderBalance(value: string): number {
  let balance = 0;
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of value) {
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(" || character === "[" || character === "{") balance += 1;
    else if (character === ")" || character === "]" || character === "}") balance -= 1;
    else if (character === "#") break;
  }
  return balance;
}

function pythonConstructEnd(lines: readonly SourceLine[], first: number): number | undefined {
  let declaration = first;
  while (declaration < lines.length && /^\s*@/u.test(lines[declaration]!.text)) {
    declaration += 1;
  }
  const declarationLine = lines[declaration];
  if (declarationLine === undefined) return undefined;
  if (!/^\s*(?:(?:async\s+)?def|class)\s+[A-Za-z_]\w*/u.test(declarationLine.text)) {
    return lines[first]?.end;
  }

  const baseIndent = indentation(declarationLine.text);
  let headerBalance = 0;
  let headerComplete = false;
  let lastEnd = declarationLine.end;
  let bodySeen = /:\s*\S+/u.test(declarationLine.text);

  for (let index = declaration; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    if (!headerComplete) {
      headerBalance += pythonHeaderBalance(line.text);
      lastEnd = line.end;
      if (headerBalance <= 0 && /:\s*(?:#.*)?$/u.test(line.text)) {
        headerComplete = true;
        if (/:\s*\S+/u.test(line.text)) bodySeen = true;
      }
      continue;
    }
    if (trimmed.length === 0) continue;
    if (indentation(line.text) <= baseIndent) break;
    bodySeen = true;
    lastEnd = line.end;
  }
  return headerComplete && bodySeen ? lastEnd : declarationLine.end;
}

function braceConstructEnd(source: string, start: number): number | undefined {
  const open = source.indexOf("{", start);
  const firstLineEnd = source.indexOf("\n", start);
  if (open === -1 || (firstLineEnd !== -1 && open > firstLineEnd + 2_000)) {
    return firstLineEnd === -1 ? source.length : firstLineEnd;
  }
  let depth = 0;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let offset = open; offset < source.length; offset += 1) {
    const character = source[offset]!;
    const next = source[offset + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        offset += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      offset += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      offset += 1;
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return offset + 1;
    }
  }
  return undefined;
}

/** Conservative, language-agnostic routing for explicit existing-code edits. */
export function requestsSelectedCodeEdit(instruction: string): boolean {
  const mutation =
    /\b(?:change|complete|correct|debug|delete|fix|implement|modify|refactor|remove|rename|repair|replace|rewrite|update)\b/iu;
  const existingTarget =
    /\b(?:above|below|current|existing|following|next|preceding|previous)\b/iu;
  const namedTarget =
    /\b(?:the|this)\s+(?:existing\s+)?(?:class|code|component|endpoint|function|handler|implementation|method|query|route)\b/iu;
  return mutation.test(instruction)
    && (existingTarget.test(instruction) || namedTarget.test(instruction));
}

/**
 * Select the next source construct after a marker. Python uses indentation and
 * decorator-aware declaration ownership; brace languages use a balanced block.
 */
export function resolveSelectedCodeEdit(
  sourcePath: string,
  source: string,
  marker: InlineMarker,
  instruction: string,
): SelectedCodeEdit | undefined {
  if (!requestsSelectedCodeEdit(instruction)) return undefined;
  const afterMarker = nextLineStart(source, marker.end);
  const lines = sourceLines(source, afterMarker);
  const first = lines.findIndex((line) => line.text.trim().length > 0);
  if (first < 0) return undefined;
  const targetStart = lines[first]!.start;
  const extension = extname(sourcePath).toLowerCase();
  const targetEnd = extension === ".py"
    ? pythonConstructEnd(lines, first)
    : braceConstructEnd(source, targetStart) ?? lines[first]!.end;
  if (targetEnd === undefined || targetEnd <= targetStart) return undefined;
  const selectedSource = source.slice(targetStart, targetEnd);
  return {
    range: { start: marker.start, end: targetEnd },
    expectedSource: source.slice(marker.start, targetEnd),
    currentSource: `${source.slice(0, marker.start)}${source.slice(marker.end)}`,
    selectedSource: dedent(selectedSource),
  };
}
