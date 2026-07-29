import assert from "node:assert/strict";
import { test } from "node:test";
import { renderInlineDiff } from "../src/index.ts";

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
  assert.match(rendered, /\x1b\[31;48;5;52m- value = 1/u);
  assert.match(rendered, /\x1b\[32;48;5;22m\+ value = 2/u);
  assert.match(rendered, /\x1b\[0m/u);
});

test("inline diff returns nothing when candidate bytes are unchanged", () => {
  assert.equal(renderInlineDiff("same.ts", "same\n", "same\n"), "");
});
