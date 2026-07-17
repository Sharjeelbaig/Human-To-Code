import { extname } from "node:path";

export interface StaticFileMemoryEntry {
  startLine: number;
  endLine: number;
  code: string;
}

type LanguageFamily = "javascript" | "python" | "rust" | "go" | "ruby" | "typed-c";
type SpanMode = "statement" | "header";

interface DeclarationCandidate {
  mode: SpanMode;
  semicolon: boolean;
}

const EXTENSION_FAMILY: Readonly<Record<string, LanguageFamily>> = Object.freeze({
  ".ts": "javascript",
  ".tsx": "javascript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "typed-c",
  ".cs": "typed-c",
  ".c": "typed-c",
  ".h": "typed-c",
  ".cpp": "typed-c",
  ".cc": "typed-c",
  ".hpp": "typed-c",
});

const CONTROL_WORDS = new Set([
  "break", "case", "catch", "continue", "do", "else", "finally", "for", "foreach",
  "if", "new", "return", "switch", "throw", "try", "while", "yield",
]);

function languageFamily(sourcePath: string): LanguageFamily | undefined {
  return EXTENSION_FAMILY[extname(sourcePath).toLowerCase()];
}

function ignoredLine(trimmed: string, family: LanguageFamily): boolean {
  if (trimmed.length === 0 || trimmed.includes("@human")) return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  return (family === "python" || family === "ruby") && trimmed.startsWith("#");
}

function javascriptCandidate(line: string): DeclarationCandidate | undefined {
  const prefix = /^(?:(?:export|default|declare|abstract|async)\s+)*/u.exec(line)?.[0] ?? "";
  const rest = line.slice(prefix.length);
  if (/^(?:import|const|let|var|type)\b/u.test(rest)) return { mode: "statement", semicolon: false };
  if (/^(?:(?:public|private|protected|static|readonly|declare|abstract)\s+)+[#A-Za-z_$][A-Za-z0-9_$#]*(?:\s*[?:]|\s*=)/u.test(rest)) {
    return { mode: "statement", semicolon: false };
  }
  if (/^(?:function|class|interface|enum|namespace|module)\b/u.test(rest)) return { mode: "header", semicolon: false };
  const method = /^(?:(?:public|private|protected|static|abstract|async|override|get|set)\s+)*(constructor|[#A-Za-z_$][A-Za-z0-9_$#]*)\s*\([^;{}]*\)\s*(?::\s*[^{}]+)?\s*\{/u.exec(rest);
  if (method && !CONTROL_WORDS.has(method[1]!)) return { mode: "header", semicolon: false };
  if (/^this\.[A-Za-z_$][A-Za-z0-9_$]*\s*=(?!=)/u.test(rest)) return { mode: "statement", semicolon: false };
  return undefined;
}

function pythonCandidate(line: string): DeclarationCandidate | undefined {
  if (/^(?:async\s+def|def|class)\b/u.test(line)) return { mode: "header", semicolon: false };
  if (/^(?:from\s+\S+\s+import|import)\b/u.test(line)) return { mode: "statement", semicolon: false };
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=(?!=)/u.test(line)) {
    return { mode: "statement", semicolon: false };
  }
  if (/^(?:self|cls)\.[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/u.test(line)) return { mode: "statement", semicolon: false };
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^=]+$/u.test(line)) return { mode: "statement", semicolon: false };
  return undefined;
}

function rustCandidate(line: string): DeclarationCandidate | undefined {
  const rest = line.replace(/^(?:(?:pub(?:\([^)]*\))?|unsafe|async|extern(?:\s+"[^"]+")?)\s+)*/u, "");
  if (/^(?:const|static|let|type|use)\b/u.test(rest)) return { mode: "statement", semicolon: true };
  if (/^(?:fn|struct|enum|trait|impl|mod|union|macro_rules!)\b/u.test(rest)) return { mode: "header", semicolon: false };
  return undefined;
}

function goCandidate(line: string): DeclarationCandidate | undefined {
  if (/^(?:const|var|type|import)\b/u.test(line) || /^[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*:=/u.test(line)) {
    return { mode: "statement", semicolon: false };
  }
  if (/^func\b/u.test(line)) return { mode: "header", semicolon: false };
  return undefined;
}

function rubyCandidate(line: string): DeclarationCandidate | undefined {
  if (/^(?:def|class|module)\b/u.test(line)) return { mode: "header", semicolon: false };
  if (/^(?:[A-Z][A-Za-z0-9_]*|@@?[A-Za-z_][A-Za-z0-9_]*|[a-z_][A-Za-z0-9_]*)\s*=(?!=)/u.test(line)) {
    return { mode: "statement", semicolon: false };
  }
  return undefined;
}

function typedCCandidate(line: string): DeclarationCandidate | undefined {
  const withoutAttributes = line.replace(/^\s*(?:\[[^\]]+\]\s*)*/u, "");
  const modifiers = /^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|extern|async|inline|constexpr|consteval|constinit|volatile|mutable|friend|typedef|partial|unsafe|readonly)\s+)*/u.exec(withoutAttributes)?.[0] ?? "";
  const rest = withoutAttributes.slice(modifiers.length);
  if (/^(?:import|using)\b/u.test(rest)) return { mode: "statement", semicolon: true };
  if (/^(?:class|interface|enum|record|struct|union|namespace)\b/u.test(rest)) {
    return { mode: "header", semicolon: false };
  }
  const firstWord = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(rest)?.[1];
  if (!firstWord || CONTROL_WORDS.has(firstWord)) return undefined;
  if (/\s(?:<<|>>)\s/u.test(rest) || /(?:\.|->)[A-Za-z_$][A-Za-z0-9_$]*\s*\(/u.test(rest)) return undefined;
  if (modifiers.length > 0 && /^[A-Za-z_$][A-Za-z0-9_$]*\s*\(/u.test(rest)) {
    return { mode: "header", semicolon: false };
  }
  if (/^[A-Za-z_][A-Za-z0-9_:<>,.?*\[\]&\s]+\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/u.test(rest)) {
    return { mode: "header", semicolon: false };
  }
  if (/^[A-Za-z_][A-Za-z0-9_:<>,.?*\[\]&\s]+\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*=|\s*;|\s*\{)/u.test(rest)) {
    return { mode: "statement", semicolon: true };
  }
  return undefined;
}

function declarationCandidate(line: string, family: LanguageFamily): DeclarationCandidate | undefined {
  switch (family) {
    case "javascript": return javascriptCandidate(line);
    case "python": return pythonCandidate(line);
    case "rust": return rustCandidate(line);
    case "go": return goCandidate(line);
    case "ruby": return rubyCandidate(line);
    case "typed-c": return typedCCandidate(line);
  }
}

interface StructureState {
  round: number;
  square: number;
  curly: number;
  quote?: "'" | "\"" | "`";
  triple?: "'''" | "\"\"\"";
  blockComment: boolean;
  escaped: boolean;
}

interface LineStructure {
  topLevelSemicolon: boolean;
  topLevelHeaderEnd: boolean;
}

function scanStructure(line: string, family: LanguageFamily, state: StructureState): LineStructure {
  let topLevelSemicolon = false;
  let topLevelHeaderEnd = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (state.blockComment) {
      if (char === "*" && next === "/") {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    if (state.triple) {
      if (line.startsWith(state.triple, index)) {
        index += 2;
        state.triple = undefined;
      }
      continue;
    }
    if (state.quote) {
      if (state.escaped) state.escaped = false;
      else if (char === "\\") state.escaped = true;
      else if (char === state.quote) state.quote = undefined;
      continue;
    }
    if (char === "/" && next === "*") {
      state.blockComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") break;
    if ((family === "python" || family === "ruby") && char === "#") break;
    if (family === "python" && (line.startsWith("'''", index) || line.startsWith("\"\"\"", index))) {
      state.triple = line.slice(index, index + 3) as StructureState["triple"];
      index += 2;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      state.quote = char;
      continue;
    }
    if (char === "(") state.round += 1;
    else if (char === ")") state.round = Math.max(0, state.round - 1);
    else if (char === "[") state.square += 1;
    else if (char === "]") state.square = Math.max(0, state.square - 1);
    else if (char === "{") {
      if (state.round === 0 && state.square === 0 && state.curly === 0) topLevelHeaderEnd = true;
      state.curly += 1;
    } else if (char === "}") state.curly = Math.max(0, state.curly - 1);
    else if (char === ";" && state.round === 0 && state.square === 0 && state.curly === 0) topLevelSemicolon = true;
    else if (char === ":" && family === "python" && state.round === 0 && state.square === 0 && state.curly === 0) {
      topLevelHeaderEnd = true;
    }
  }
  return { topLevelSemicolon, topLevelHeaderEnd };
}

function spanEnd(lines: readonly string[], start: number, family: LanguageFamily, candidate: DeclarationCandidate): number {
  const state: StructureState = { round: 0, square: 0, curly: 0, blockComment: false, escaped: false };
  for (let index = start; index < lines.length; index += 1) {
    const structure = scanStructure(lines[index]!, family, state);
    const balanced = state.round === 0 && state.square === 0 && state.curly === 0 && !state.quote && !state.triple && !state.blockComment;
    if (candidate.mode === "header" && (structure.topLevelHeaderEnd || structure.topLevelSemicolon) && !state.quote && !state.triple) {
      return index;
    }
    if (candidate.mode === "header" && family === "ruby" && balanced) return index;
    if (candidate.mode === "statement") {
      if (candidate.semicolon && structure.topLevelSemicolon && balanced) return index;
      if (!candidate.semicolon && balanced && !lines[index]!.trimEnd().endsWith("\\") && !lines[index]!.trimEnd().endsWith(",")) return index;
    }
  }
  return start;
}

/**
 * Extract declaration/signature evidence without executing code or loading a
 * language runtime. The result is deterministic and preserves exact source.
 */
export function extractStaticFileMemory(sourcePath: string, sourceText: string): StaticFileMemoryEntry[] {
  const family = languageFamily(sourcePath);
  if (!family) return [];
  const lines = sourceText.split(/\r?\n/u);
  const entries: StaticFileMemoryEntry[] = [];
  let headerContinuationThrough = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (index <= headerContinuationThrough) continue;
    const trimmed = lines[index]!.trim();
    if (ignoredLine(trimmed, family)) continue;
    const candidate = declarationCandidate(trimmed, family);
    if (!candidate) continue;
    const end = spanEnd(lines, index, family, candidate);
    const code = lines.slice(index, end + 1).join("\n").trim();
    if (code.length > 0) entries.push({ startLine: index + 1, endLine: end + 1, code });
    if (candidate.mode === "header") headerContinuationThrough = end;
  }
  return entries;
}
