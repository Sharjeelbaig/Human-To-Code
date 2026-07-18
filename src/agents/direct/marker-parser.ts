export interface InlineMarker {
  prompt: string;
  start: number;
  end: number;
}

/** Advance past a quoted region so comment-shaped text inside it stays inert. */
function endOfQuotedRegion(text: string, start: number): number {
  const quote = text[start]!;
  const triple = quote !== "`" && text.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  let offset = start + delimiter.length;

  while (offset < text.length) {
    if (text[offset] === "\\") {
      offset = Math.min(offset + 2, text.length);
      continue;
    }
    if (text.startsWith(delimiter, offset)) return offset + delimiter.length;
    if (!triple && quote !== "`" && (text[offset] === "\n" || text[offset] === "\r")) return offset;
    offset += 1;
  }
  return text.length;
}

function lineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

/** Find every lexical `@human` comment marker with its exact character range. */
export function extractInlineMarkers(text: string): InlineMarker[] {
  const markers: InlineMarker[] = [];
  let offset = 0;

  while (offset < text.length) {
    const character = text[offset]!;

    if (character === "'" || character === '"' || character === "`") {
      offset = endOfQuotedRegion(text, offset);
      continue;
    }

    if (text.startsWith("//", offset)) {
      const end = lineEnd(text, offset);
      const match = /^[ \t]*@human\b[ \t]*([^\r]*)$/u.exec(text.slice(offset + 2, end));
      const prompt = (match?.[1] ?? "").trim();
      if (match && prompt.length > 0) markers.push({ prompt, start: offset, end });
      offset = end;
      continue;
    }

    if (text.startsWith("/*", offset)) {
      const close = text.indexOf("*/", offset + 2);
      const end = close === -1 ? text.length : close + 2;
      if (close !== -1) {
        const match = /^\s*@human\b[ \t]*([\s\S]*)$/u.exec(text.slice(offset + 2, close));
        const prompt = (match?.[1] ?? "").trim();
        if (match && prompt.length > 0) markers.push({ prompt, start: offset, end });
      }
      offset = end;
      continue;
    }

    if (character === "#") {
      const end = lineEnd(text, offset);
      const match = /^[ \t]*@human\b[ \t]*([^\r]*)$/u.exec(text.slice(offset + 1, end));
      const prompt = (match?.[1] ?? "").trim();
      if (match && prompt.length > 0) markers.push({ prompt, start: offset, end });
      offset = end;
      continue;
    }

    offset += 1;
  }

  return markers;
}
