import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderInlineDiff,
  syntaxLanguageForPath,
  syntaxSpansForLine,
  type SyntaxStyle,
} from "../src/index.ts";

function styledText(
  path: string,
  source: string,
  style: SyntaxStyle,
): string[] {
  return syntaxSpansForLine(path, source)
    .filter((span) => span.style === style)
    .map((span) => source.slice(span.start, span.end));
}

test("inline diff shows bounded context with add/remove gutters", () => {
  const rendered = renderInlineDiff(
    "src/example.ts",
    "const before = 1;\nconst value = 1;\nconst after = 1;\n",
    "const before = 1;\nconst value = 2;\nconst added = true;\nconst after = 1;\n",
    { contextLines: 1 },
  );
  assert.match(rendered, /diff --human-to-code a\/src\/example\.ts b\/src\/example\.ts/u);
  assert.match(rendered, /- const value = 1;/u);
  assert.match(rendered, /\+ const value = 2;/u);
  assert.match(rendered, /\+ const added = true;/u);
  assert.doesNotMatch(rendered, /\x1b\[/u);
});

test("inline diff uses red and green backgrounds when color is enabled", () => {
  const rendered = renderInlineDiff(
    "example.py",
    "value = 1\n",
    "value = 2\n",
    { color: true },
  );
  assert.match(rendered, /\x1b\[31;48;5;52m- /u);
  assert.match(rendered, /\x1b\[32;48;5;22m\+ /u);
  assert.match(rendered, /\x1b\[38;5;117;48;5;88;1;4m1/u);
  assert.match(rendered, /\x1b\[38;5;117;48;5;28;1;4m2/u);
  assert.match(rendered, /\x1b\[0m/u);
});

test("inline diff combines language syntax colors with character-level edits", () => {
  const rendered = renderInlineDiff(
    "api.py",
    'async def load(value: Request):\n    return "old"\n',
    'async def load(value: Request):\n    return "new"\n',
    { color: true },
  );
  assert.match(rendered, /\x1b\[38;5;177;22;24masync/u);
  assert.match(rendered, /\x1b\[38;5;75;22;24mload/u);
  assert.match(rendered, /\x1b\[38;5;81;22;24mRequest/u);
  assert.match(rendered, /\x1b\[38;5;222;48;5;88;1;4mold/u);
  assert.match(rendered, /\x1b\[38;5;222;48;5;28;1;4mnew/u);
});

test("syntax language routing covers every supported source extension", () => {
  const routes = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    cs: "csharp", cpp: "cpp", cc: "cpp", hpp: "cpp", c: "c", h: "c",
    html: "html", htm: "html", css: "css",
  } as const;
  for (const [extension, language] of Object.entries(routes)) {
    assert.equal(syntaxLanguageForPath(`nested/example.${extension}`), language);
  }
  assert.equal(syntaxLanguageForPath("README.md"), "plain");
});

test("language lexers recognize ecosystem-specific syntax", () => {
  const cases: Array<{
    path: string;
    source: string;
    style: SyntaxStyle;
    expected: string;
  }> = [
    { path: "a.ts", source: "interface User {}", style: "keyword", expected: "interface" },
    { path: "a.js", source: "const ready = true;", style: "keyword", expected: "true" },
    { path: "a.py", source: "from fastapi import Request", style: "keyword", expected: "from" },
    { path: "a.rs", source: "pub fn main() {}", style: "keyword", expected: "pub" },
    { path: "a.go", source: "func main() {}", style: "keyword", expected: "func" },
    { path: "A.java", source: "public record User() {}", style: "keyword", expected: "record" },
    { path: "a.rb", source: "def call; end", style: "keyword", expected: "def" },
    { path: "A.cs", source: "public record User;", style: "keyword", expected: "record" },
    { path: "a.cpp", source: "#include <vector>", style: "decorator", expected: "#include <vector>" },
    { path: "a.c", source: "typedef struct Item Item;", style: "keyword", expected: "typedef" },
    { path: "a.html", source: '<button aria-label="Save">', style: "tag", expected: "button" },
    { path: "a.css", source: "color: #fff;", style: "property", expected: "color" },
  ];
  for (const item of cases) {
    assert.ok(
      styledText(item.path, item.source, item.style).includes(item.expected),
      `${item.path} did not style ${item.expected} as ${item.style}`,
    );
  }
});

test("plain diffs preserve text while neutralizing terminal control injection", () => {
  const rendered = renderInlineDiff(
    "unsafe.js",
    "",
    "const value = '\x1b[31m';\n",
    { color: false },
  );
  assert.doesNotMatch(rendered, /\x1b/u);
  assert.match(rendered, /\+ const value = '�\[31m';/u);
  assert.match(rendered, /@@ -0,0 \+1,1 @@/u);
});

test("inline diff returns nothing when candidate bytes are unchanged", () => {
  assert.equal(renderInlineDiff("same.ts", "same\n", "same\n"), "");
});
