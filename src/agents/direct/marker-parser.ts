/**
 * Finds real `@human` instructions in source comments, while ignoring
 * comment-shaped text inside strings and markup attributes.
 */
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

function endOfHtmlAttributeQuotedRegion(text: string, start: number): number {
  const quote = text[start]!;
  let offset = start + 1;
  while (offset < text.length) {
    if (text[offset] === quote) return offset + 1;
    offset += 1;
  }
  return text.length;
}

function blockMarkerPrompt(content: string): string | undefined {
  const ordinary = /^\s*@human\b[ \t]*([\s\S]*)$/u.exec(content);
  if (ordinary) return (ordinary[1] ?? "").trim() || undefined;

  // Remove only conventional multiline `*` decoration. This covers JSDoc
  // (`/**`) and decorated ordinary block comments (`/*\n * ...`) while prose
  // before @human remains non-instruction text.
  const decoratedContent = content.startsWith("*") ? content.slice(1) : content;
  const normalized = decoratedContent
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\*?[ \t]?/u, ""))
    .join("\n");
  const jsdoc = /^\s*@human\b[ \t]*([\s\S]*)$/u.exec(normalized);
  return (jsdoc?.[1] ?? "").trim() || undefined;
}

function pushLineMarker(
  markers: InlineMarker[],
  text: string,
  start: number,
  openerLength: number,
): number {
  const end = lineEnd(text, start);
  const match = /^[ \t]*@human\b[ \t]*([^\r]*)$/u.exec(text.slice(start + openerLength, end));
  const prompt = (match?.[1] ?? "").trim();
  if (match && prompt.length > 0) markers.push({ prompt, start, end });
  return end;
}

function pushBlockMarker(
  markers: InlineMarker[],
  text: string,
  start: number,
  opener: string,
  closer: string,
): number {
  const close = text.indexOf(closer, start + opener.length);
  const end = close === -1 ? text.length : close + closer.length;
  if (close !== -1) {
    const prompt = blockMarkerPrompt(text.slice(start + opener.length, close));
    if (prompt) markers.push({ prompt, start, end });
  }
  return end;
}

interface HtmlTagStart {
  end: number;
  name: string;
  closing: boolean;
}

function htmlTagStart(text: string, offset: number): HtmlTagStart | undefined {
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/u.exec(text.slice(offset));
  if (!match) return undefined;
  return {
    end: offset + match[0].length,
    name: match[2]!.toLowerCase(),
    closing: match[1] === "/",
  };
}

/**
 * HTML needs tag-aware quote handling: apostrophes in visible text are not
 * string delimiters, while comment-shaped text inside quoted attributes and
 * embedded script/style strings must stay inert.
 */
function extractHtmlInlineMarkers(text: string): InlineMarker[] {
  const markers: InlineMarker[] = [];
  let offset = 0;
  let inTag = false;
  let tagStart = 0;
  let pendingTag: HtmlTagStart | undefined;
  let rawTextTag: "script" | "style" | undefined;

  while (offset < text.length) {
    if (inTag) {
      const character = text[offset]!;
      if (character === "'" || character === '"') {
        offset = endOfHtmlAttributeQuotedRegion(text, offset);
        continue;
      }
      if (character === ">") {
        const selfClosing = /\/\s*$/u.test(text.slice(tagStart, offset));
        if (pendingTag?.name === "script" || pendingTag?.name === "style") {
          if (pendingTag.closing) rawTextTag = undefined;
          else if (!selfClosing) rawTextTag = pendingTag.name;
        }
        inTag = false;
        pendingTag = undefined;
      }
      offset += 1;
      continue;
    }

    if (text.startsWith("<!--", offset)) {
      offset = pushBlockMarker(markers, text, offset, "<!--", "-->");
      continue;
    }

    if (rawTextTag !== undefined) {
      const closing = htmlTagStart(text, offset);
      if (closing?.closing === true && closing.name === rawTextTag) {
        inTag = true;
        tagStart = offset;
        pendingTag = closing;
        offset = closing.end;
        continue;
      }

      const character = text[offset]!;
      if (character === "'" || character === '"' || character === "`") {
        offset = endOfQuotedRegion(text, offset);
        continue;
      }
      if (rawTextTag === "script" && text.startsWith("//", offset)) {
        offset = pushLineMarker(markers, text, offset, 2);
        continue;
      }
      if (text.startsWith("/*", offset)) {
        offset = pushBlockMarker(markers, text, offset, "/*", "*/");
        continue;
      }
      offset += 1;
      continue;
    }

    if (text[offset] === "<") {
      const tag = htmlTagStart(text, offset);
      if (tag !== undefined) {
        inTag = true;
        tagStart = offset;
        pendingTag = tag;
        offset = tag.end;
        continue;
      }
    }
    offset += 1;
  }

  return markers;
}

/** Find every lexical `@human` comment marker with its exact character range. */
export function extractInlineMarkers(text: string, sourcePath = ""): InlineMarker[] {
  if (/\.html?$/iu.test(sourcePath)) return extractHtmlInlineMarkers(text);

  const markers: InlineMarker[] = [];
  let offset = 0;

  while (offset < text.length) {
    const character = text[offset]!;

    if (character === "'" || character === '"' || character === "`") {
      offset = endOfQuotedRegion(text, offset);
      continue;
    }

    if (text.startsWith("//", offset)) {
      offset = pushLineMarker(markers, text, offset, 2);
      continue;
    }

    if (text.startsWith("/*", offset)) {
      offset = pushBlockMarker(markers, text, offset, "/*", "*/");
      continue;
    }

    if (character === "#") {
      offset = pushLineMarker(markers, text, offset, 1);
      continue;
    }

    offset += 1;
  }

  return markers;
}
