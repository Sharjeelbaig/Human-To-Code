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
