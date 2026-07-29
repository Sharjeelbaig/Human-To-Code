/**
 * Bounded, terminal-friendly unified diffs for reviewing generated candidates
 * before the application layer is allowed to write them.
 */
import {
  syntaxSpansForLine,
  type SyntaxStyle,
} from "./syntax-highlighting.ts";

export interface InlineDiffOptions {
  color?: boolean;
  contextLines?: number;
}

type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

const ANSI = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  remove: "\x1b[31;48;5;52m",
  add: "\x1b[32;48;5;22m",
} as const;
const FOREGROUND: Readonly<Record<SyntaxStyle, number>> = Object.freeze({
  keyword: 177,
  type: 81,
  function: 75,
  string: 222,
  number: 117,
  comment: 244,
  decorator: 215,
  builtin: 44,
  property: 80,
  tag: 75,
});
const MAX_DYNAMIC_CELLS = 4_000_000;

function lines(value: string): string[] {
  if (value.length === 0) return [];
  const result = value.split(/\r?\n/u);
  if (result.at(-1) === "") result.pop();
  return result;
}

/**
 * LCS gives readable line-level diffs for ordinary source files. When a
 * generated region is too large for a bounded matrix, the middle is shown as
 * one remove/add block instead of risking unbounded CPU or memory.
 */
function changedLines(before: string[], after: string[]): DiffLine[] {
  let prefix = 0;
  while (
    prefix < before.length
    && prefix < after.length
    && before[prefix] === after[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const result: DiffLine[] = before.slice(0, prefix)
    .map((text) => ({ kind: "same", text }));

  if (oldMiddle.length * newMiddle.length > MAX_DYNAMIC_CELLS) {
    result.push(
      ...oldMiddle.map((text): DiffLine => ({ kind: "remove", text })),
      ...newMiddle.map((text): DiffLine => ({ kind: "add", text })),
    );
  } else {
    const width = newMiddle.length + 1;
    const table = new Uint32Array((oldMiddle.length + 1) * width);
    for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
        const offset = oldIndex * width + newIndex;
        table[offset] = oldMiddle[oldIndex] === newMiddle[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1]! + 1
          : Math.max(
              table[(oldIndex + 1) * width + newIndex]!,
              table[oldIndex * width + newIndex + 1]!,
            );
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
      if (
        oldIndex < oldMiddle.length
        && newIndex < newMiddle.length
        && oldMiddle[oldIndex] === newMiddle[newIndex]
      ) {
        result.push({ kind: "same", text: oldMiddle[oldIndex]! });
        oldIndex += 1;
        newIndex += 1;
      } else if (
        newIndex < newMiddle.length
        && (
          oldIndex === oldMiddle.length
          || table[oldIndex * width + newIndex + 1]!
            > table[(oldIndex + 1) * width + newIndex]!
        )
      ) {
        result.push({ kind: "add", text: newMiddle[newIndex]! });
        newIndex += 1;
      } else {
        result.push({ kind: "remove", text: oldMiddle[oldIndex]! });
        oldIndex += 1;
      }
    }
  }

  result.push(
    ...before.slice(before.length - suffix)
      .map((text): DiffLine => ({ kind: "same", text })),
  );
  return result;
}

function colorize(value: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
}

interface ChangedRange {
  start: number;
  end: number;
}

/** Pair adjacent delete/add lines and emphasize only their changed characters. */
function intralineChanges(diff: readonly DiffLine[]): Map<number, ChangedRange> {
  const ranges = new Map<number, ChangedRange>();
  let cursor = 0;
  while (cursor < diff.length) {
    if (diff[cursor]?.kind !== "remove") {
      cursor += 1;
      continue;
    }
    const removedStart = cursor;
    while (diff[cursor]?.kind === "remove") cursor += 1;
    const addedStart = cursor;
    while (diff[cursor]?.kind === "add") cursor += 1;
    const pairs = Math.min(addedStart - removedStart, cursor - addedStart);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removedIndex = removedStart + pair;
      const addedIndex = addedStart + pair;
      const before = diff[removedIndex]!.text;
      const after = diff[addedIndex]!.text;
      let prefix = 0;
      while (
        prefix < before.length
        && prefix < after.length
        && before[prefix] === after[prefix]
      ) prefix += 1;
      let suffix = 0;
      while (
        suffix < before.length - prefix
        && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
      ) suffix += 1;
      ranges.set(removedIndex, {
        start: prefix,
        end: Math.max(prefix, before.length - suffix),
      });
      ranges.set(addedIndex, {
        start: prefix,
        end: Math.max(prefix, after.length - suffix),
      });
    }
  }
  return ranges;
}

function highlightedLine(
  path: string,
  rawText: string,
  kind: DiffLine["kind"],
  emphasis: ChangedRange | undefined,
): string {
  const text = safeTerminalText(rawText);
  const spans = syntaxSpansForLine(path, text);
  const boundaries = new Set([0, text.length]);
  for (const span of spans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  if (emphasis !== undefined) {
    boundaries.add(emphasis.start);
    boundaries.add(emphasis.end);
  }
  const ordered = [...boundaries]
    .filter((offset) => offset >= 0 && offset <= text.length)
    .sort((left, right) => left - right);
  const baseBackground = kind === "remove"
    ? 52
    : kind === "add"
      ? 22
      : undefined;
  const emphasisBackground = kind === "remove" ? 88 : kind === "add" ? 28 : undefined;
  let output = "";
  let spanCursor = 0;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    if (end <= start) continue;
    while (spans[spanCursor] !== undefined && spans[spanCursor]!.end <= start) {
      spanCursor += 1;
    }
    const candidateSpan = spans[spanCursor];
    const syntax =
      candidateSpan !== undefined
      && candidateSpan.start <= start
      && candidateSpan.end >= end
        ? candidateSpan
        : undefined;
    const emphasized =
      emphasis !== undefined
      && emphasis.end > emphasis.start
      && start >= emphasis.start
      && end <= emphasis.end;
    const codes = [
      `38;5;${syntax === undefined ? 252 : FOREGROUND[syntax.style]}`,
      ...(emphasized && emphasisBackground !== undefined
        ? [`48;5;${emphasisBackground}`]
        : baseBackground === undefined
          ? []
          : [`48;5;${baseBackground}`]),
      emphasized ? "1" : "22",
      emphasized ? "4" : syntax?.style === "comment" ? "3" : "24",
    ];
    output += `\x1b[${codes.join(";")}m${text.slice(start, end)}`;
  }
  return `${output}${ANSI.reset}`;
}

function hunkHeader(
  diff: readonly DiffLine[],
  start: number,
  end: number,
  color: boolean,
): string {
  let oldBefore = 0;
  let newBefore = 0;
  for (let index = 0; index < start; index += 1) {
    if (diff[index]!.kind !== "add") oldBefore += 1;
    if (diff[index]!.kind !== "remove") newBefore += 1;
  }
  let oldCount = 0;
  let newCount = 0;
  for (let index = start; index <= end; index += 1) {
    if (diff[index]!.kind !== "add") oldCount += 1;
    if (diff[index]!.kind !== "remove") newCount += 1;
  }
  const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
  const newStart = newCount === 0 ? newBefore : newBefore + 1;
  return colorize(
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    "cyan",
    color,
  );
}

/** Render one complete candidate against the exact pre-run target bytes. */
export function renderInlineDiff(
  path: string,
  before: string,
  after: string,
  options: InlineDiffOptions = {},
): string {
  if (before === after) return "";
  const color = options.color ?? false;
  const context = Math.max(0, Math.min(20, options.contextLines ?? 3));
  const diff = changedLines(lines(before), lines(after));
  const intraline = intralineChanges(diff);
  const changed = diff
    .map((line, index) => line.kind === "same" ? undefined : index)
    .filter((index): index is number => index !== undefined);
  const shown = new Set<number>();
  for (const index of changed) {
    for (
      let cursor = Math.max(0, index - context);
      cursor <= Math.min(diff.length - 1, index + context);
      cursor += 1
    ) shown.add(cursor);
  }

  const output = [
    colorize(
      `diff --human-to-code a/${safeTerminalText(path)} b/${safeTerminalText(path)}`,
      "bold",
      color,
    ),
    colorize(`--- a/${safeTerminalText(path)}`, "remove", color),
    colorize(`+++ b/${safeTerminalText(path)}`, "add", color),
  ];
  const shownIndexes = [...shown].sort((left, right) => left - right);
  let cursor = 0;
  while (cursor < shownIndexes.length) {
    const start = shownIndexes[cursor]!;
    let end = start;
    while (
      cursor + 1 < shownIndexes.length
      && shownIndexes[cursor + 1] === end + 1
    ) {
      cursor += 1;
      end += 1;
    }
    output.push(hunkHeader(diff, start, end, color));
    for (let index = start; index <= end; index += 1) {
      const line = diff[index]!;
      const gutter = line.kind === "same" ? " " : line.kind === "remove" ? "-" : "+";
      if (!color) {
        output.push(`${gutter} ${safeTerminalText(line.text)}`);
        continue;
      }
      const gutterStyle = line.kind === "remove"
        ? "\x1b[31;48;5;52m"
        : line.kind === "add"
          ? "\x1b[32;48;5;22m"
          : "\x1b[38;5;244m";
      output.push(
        `${gutterStyle}${gutter} ${ANSI.reset}`
        + highlightedLine(path, line.text, line.kind, intraline.get(index)),
      );
    }
    cursor += 1;
  }
  return output.join("\n");
}
