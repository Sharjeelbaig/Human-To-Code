/**
 * Reading a JSON value out of model text.
 *
 * A provider that enforces a JSON schema returns JSON and nothing else. Every
 * other path — Ollama Cloud, any local model asked for JSON in the prompt —
 * returns whatever the model felt like emitting: a fenced block, a sentence of
 * preamble, or both. Discarding a correct answer over its wrapping is a defect,
 * so extraction lives here once and is shared by every consumer rather than
 * being re-invented per call site.
 *
 * Extraction only ever *narrows* text to a span that already parses as JSON. It
 * never repairs, completes, or rewrites a value, so nothing here can invent a
 * field the model did not send.
 */

function fencedBlocks(text: string): string[] {
  return [
    ...text.matchAll(/```(?:[\w.+-]+)?[ \t]*\r?\n([\s\S]*?)```/gu),
  ].map((match) => (match[1] ?? "").trim());
}

/** The widest brace- or bracket-delimited span, which is the outermost value. */
function delimitedSpan(text: string, open: string, close: string): string | undefined {
  const first = text.indexOf(open);
  const last = text.lastIndexOf(close);
  return first === -1 || last <= first ? undefined : text.slice(first, last + 1);
}

/**
 * Parse `text` as JSON, tolerating fences and surrounding prose. Returns
 * `undefined` when no candidate span parses — the caller decides what a missing
 * value means.
 */
export function parseJsonFromModelText(text: string): unknown | undefined {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    ...fencedBlocks(trimmed),
    delimitedSpan(trimmed, "{", "}"),
    delimitedSpan(trimmed, "[", "]"),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}
