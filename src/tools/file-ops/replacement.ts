/** Stale-safe inline replacement formatting shared by validation, memory, and apply. */
export function formatInlineReplacement(
  source: string,
  range: { start: number; end: number },
  code: string,
): string {
  const normalized = code.trim();
  if (normalized.length === 0) return "";
  const lineStart = source.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
  const prefix = source.slice(lineStart, range.start);
  const indentation = /^[ \t]*$/u.test(prefix) ? prefix : "";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return normalized.split(/\r?\n/u).join(`${newline}${indentation}`);
}

export function replaceInlineMarker(
  source: string,
  range: { start: number; end: number },
  expectedMarker: string | undefined,
  code: string,
): string {
  if (expectedMarker === undefined || source.slice(range.start, range.end) !== expectedMarker) {
    throw new Error("Inline marker changed after discovery; re-run conversion on the current file.");
  }
  const replacement = formatInlineReplacement(source, range, code);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

export interface ScopedInlineReplacement {
  range: { start: number; end: number };
  expectedMarker?: string;
  selectedRange?: { start: number; end: number };
  expectedSelectedSource?: string;
}

/** Delete the marker and, when planned, replace a separate host-validated range. */
export function replaceScopedInlineUnit(
  source: string,
  unit: ScopedInlineReplacement,
  code: string,
): string {
  if (unit.selectedRange === undefined) {
    return replaceInlineMarker(source, unit.range, unit.expectedMarker, code);
  }
  if (
    unit.expectedMarker === undefined
    || source.slice(unit.range.start, unit.range.end) !== unit.expectedMarker
  ) {
    throw new Error("Inline marker changed after discovery; re-run conversion on the current file.");
  }
  if (
    unit.expectedSelectedSource === undefined
    || source.slice(unit.selectedRange.start, unit.selectedRange.end)
      !== unit.expectedSelectedSource
  ) {
    throw new Error("Selected source changed after planning; re-run conversion on the current file.");
  }
  const rangesOverlap = unit.selectedRange.start < unit.range.end
    && unit.selectedRange.end > unit.range.start;
  if (rangesOverlap) throw new Error("Selected source overlaps its @human marker.");

  const operations = [
    { ...unit.range, replacement: "" },
    {
      ...unit.selectedRange,
      replacement: formatInlineReplacement(source, unit.selectedRange, code),
    },
  ].sort((left, right) => right.start - left.start);
  let result = source;
  for (const operation of operations) {
    result = `${result.slice(0, operation.start)}${operation.replacement}${result.slice(operation.end)}`;
  }
  return result;
}
