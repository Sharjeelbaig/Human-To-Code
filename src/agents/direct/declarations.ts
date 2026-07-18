/** Language-aware declaration names used by the direct FileMemory conflict guard. */
import { extname } from "node:path";

const TYPED_C_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".java"]);
const CONTROL_WORDS = new Set(["if", "for", "foreach", "while", "switch", "catch", "return", "throw", "new"]);

/** Extract declared names for FileMemory conflict detection across supported languages. */
export function declaredIdentifiers(sourcePath: string, code: string): Set<string> {
  const identifiers = new Set<string>();
  const keywordDeclaration = /^[ \t]*(?:(?:export|default|declare|public|private|protected|async|pub)\s+)*(?:const|let|var|function|class|interface|enum|struct|trait|fn|def|static|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gmu;
  for (const match of code.matchAll(keywordDeclaration)) {
    if (match[1]) identifiers.add(match[1]);
  }

  if (!TYPED_C_EXTENSIONS.has(extname(sourcePath).toLowerCase())) return identifiers;
  for (const rawLine of code.split(/\r?\n/u)) {
    const line = rawLine
      .trim()
      .replace(/^(?:\[[^\]]+\]\s*)+/u, "")
      .replace(/^(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|extern|async|inline|constexpr|consteval|constinit|volatile|mutable|friend|typedef|partial|unsafe|readonly)\s+)*/u, "");
    const namedType = /^(?:class|interface|enum|record|struct|union|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/u.exec(line);
    if (namedType?.[1]) {
      identifiers.add(namedType[1]);
      continue;
    }
    const functionName = /^[A-Za-z_][A-Za-z0-9_:<>,.?*\[\]&\s]+\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u.exec(line)?.[1];
    if (functionName && !CONTROL_WORDS.has(functionName)) {
      identifiers.add(functionName);
      continue;
    }
    const variableName = /^[A-Za-z_][A-Za-z0-9_:<>,.?*\[\]&\s]+\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|;|\{)/u.exec(line)?.[1];
    if (variableName && !CONTROL_WORDS.has(variableName)) identifiers.add(variableName);
  }
  return identifiers;
}
