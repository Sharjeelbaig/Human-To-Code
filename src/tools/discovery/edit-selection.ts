/**
 * Converts a model-planned, 1-based line selection into exact host-owned byte
 * ranges. Language understanding chooses the semantic range; the host validates
 * it and never lets the model choose paths or raw offsets.
 */
import type { ConversionUnit } from "../../workflows/types.ts";

export interface PlannedEditSelection {
  mode: "insert" | "replace";
  startLine: number;
  endLine: number;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === "\n") starts.push(offset + 1);
  }
  return starts;
}

function lineEndWithoutNewline(source: string, starts: readonly number[], line: number): number {
  const next = starts[line];
  if (next === undefined) return source.length;
  if (next >= 2 && source.slice(next - 2, next) === "\r\n") return next - 2;
  return next - 1;
}

function dedent(value: string): string {
  const lines = value.split(/\r?\n/u);
  const widths = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const width = widths.length === 0 ? 0 : Math.min(...widths);
  return lines
    .map((line) => line.trim().length === 0 ? "" : line.slice(width))
    .join("\n")
    .trim();
}

/** Render a bounded source file with stable 1-based line numbers for planning. */
export function numberedSource(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

/**
 * Attach an independently stale-checked replacement range to an inline unit.
 * The marker remains its own deletion range and may be anywhere in the file.
 */
export function applyPlannedEditSelection(
  unit: ConversionUnit,
  source: string,
  selection: PlannedEditSelection,
): void {
  if (unit.kind !== "inline" || unit.range === undefined) {
    throw new Error("Only inline markers can receive a planned edit selection.");
  }
  if (selection.mode === "insert") return;
  const starts = lineStarts(source);
  const lineCount = starts.length;
  if (
    !Number.isSafeInteger(selection.startLine)
    || !Number.isSafeInteger(selection.endLine)
    || selection.startLine < 1
    || selection.endLine < selection.startLine
    || selection.endLine > lineCount
    || selection.endLine - selection.startLine + 1 > 400
  ) {
    throw new Error(
      `Selected edit lines must be an ordered 1-based range of at most 400 lines within ${unit.sourcePath}.`,
    );
  }
  const start = starts[selection.startLine - 1]!;
  const end = lineEndWithoutNewline(source, starts, selection.endLine);
  const marker = unit.range;
  const overlapsMarker = start < marker.end && end > marker.start;
  if (overlapsMarker) {
    throw new Error(
      `Selected edit lines overlap the @human marker in ${unit.sourcePath}; use mode=insert for the marker itself or select only the existing code to change.`,
    );
  }
  const selected = source.slice(start, end);
  if (selected.trim().length === 0) {
    throw new Error(`Selected edit lines in ${unit.sourcePath} contain no source code.`);
  }
  unit.selectedRange = { start, end };
  unit.expectedSelectedSource = selected;
  unit.selectedSource = dedent(selected);
  unit.existingSource = `${source.slice(0, marker.start)}${source.slice(marker.end)}`;
  unit.insertionContext = undefined;
  unit.insertionOwner = undefined;
  unit.describe = `selected-code edit from @human in ${unit.sourcePath}:${unit.line ?? selection.startLine}`;
}
