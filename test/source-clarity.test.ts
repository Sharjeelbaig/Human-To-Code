import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const AMBIGUOUS_EXPORT_NAMES = new Set([
  "build",
  "create",
  "data",
  "discover",
  "execute",
  "generate",
  "handle",
  "load",
  "process",
  "read",
  "result",
  "run",
  "save",
  "unique",
  "validate",
  "write",
]);

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

function afterOptionalShebang(sourceText: string): string {
  return sourceText.replace(/^#![^\n]*\n/u, "").trimStart();
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function exportedNames(node: ts.Node): string[] {
  if (!isExported(node)) return [];
  if (
    ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
  ) return node.name ? [node.name.text] : [];
  if (!ts.isVariableStatement(node)) return [];
  return node.declarationList.declarations.flatMap((declaration) =>
    ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
}

test("every source module starts by explaining its responsibility", async () => {
  const missingHeaders: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const sourceText = await readFile(path, "utf8");
    if (!afterOptionalShebang(sourceText).startsWith("/**")) {
      missingHeaders.push(path.slice(dirname(SOURCE_ROOT).length + 1));
    }
  }
  assert.deepEqual(missingHeaders, [], `Missing module responsibility headers:\n${missingHeaders.join("\n")}`);
});

test("exported code avoids context-free names unless it is a documented compatibility alias", async () => {
  const ambiguousExports: string[] = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const sourceText = await readFile(path, "utf8");
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      for (const name of exportedNames(statement)) {
        if (!AMBIGUOUS_EXPORT_NAMES.has(name)) continue;
        const leadingComment = sourceText.slice(statement.getFullStart(), statement.getStart(sourceFile));
        if (!leadingComment.includes("@deprecated")) {
          ambiguousExports.push(`${path.slice(dirname(SOURCE_ROOT).length + 1)}: ${name}`);
        }
      }
    }
  }
  assert.deepEqual(
    ambiguousExports,
    [],
    `Use an action + domain object + lifecycle qualifier, or document a compatibility alias:\n${ambiguousExports.join("\n")}`,
  );
});
