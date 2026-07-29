/**
 * Bounded, terminal-friendly unified diffs for reviewing generated candidates
 * before the application layer is allowed to write them.
 */

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
            >= table[(oldIndex + 1) * width + newIndex]!
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
    colorize(`diff --human-to-code a/${path} b/${path}`, "bold", color),
    colorize(`--- a/${path}`, "remove", color),
    colorize(`+++ b/${path}`, "add", color),
  ];
  let previous = -2;
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < diff.length; index += 1) {
    const line = diff[index]!;
    if (line.kind !== "add") oldLine += 1;
    if (line.kind !== "remove") newLine += 1;
    if (!shown.has(index)) continue;
    if (index !== previous + 1) {
      output.push(colorize(`@@ around -${oldLine} +${newLine} @@`, "cyan", color));
    }
    const gutter = line.kind === "same" ? " " : line.kind === "remove" ? "-" : "+";
    const rendered = `${gutter} ${line.text}`;
    output.push(
      line.kind === "remove"
        ? colorize(rendered, "remove", color)
        : line.kind === "add"
          ? colorize(rendered, "add", color)
          : rendered,
    );
    previous = index;
  }
  return output.join("\n");
}
