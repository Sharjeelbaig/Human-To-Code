import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnoseUnit,
  explainUnit,
  hasColor,
  hasCount,
  hasUnitValue,
  REQUIREMENT_RULES,
  type ConversionUnit,
} from "../src/index.ts";

function unit(prompt: string): ConversionUnit {
  return {
    kind: "inline",
    sourcePath: "website/styles.css",
    absoluteSource: "/workspace/website/styles.css",
    prompt,
    line: 14,
    describe: prompt,
  };
}

test("gradient diagnostics are deterministic and disappear when fully specified", () => {
  const vague = diagnoseUnit(unit("add a gradient"));
  assert.equal(vague.length, 1);
  assert.equal(vague[0]?.rule, "gradient");
  assert.deepEqual(
    vague[0]?.facets.map((facet) => facet.id),
    ["colors", "direction", "target"],
  );

  const specific = diagnoseUnit(
    unit(
      "add a linear gradient from #0A84FF to #30D158 at 135deg on the hero",
    ),
  );
  assert.deepEqual(specific, []);
});

test("facet near-misses remain unresolved", () => {
  const context = { vocabulary: new Set<string>() };
  assert.equal(hasColor("make it blue-ish", context), false);
  assert.equal(hasColor("use some colors", context), false);
  assert.equal(hasCount("add a few columns", context), false);
  assert.equal(hasUnitValue("make it faster", context), false);
  assert.deepEqual(
    diagnoseUnit(unit("add a gradient from #fff to #000 at 45deg"))[0]
      ?.facets.map((facet) => facet.id),
    ["target"],
  );
});

test("compiler vocabulary resolves named project colors without treating values as instructions", () => {
  const prompt = unit(
    "add a gradient from brand blue to white, to bottom, on the hero",
  );
  assert.deepEqual(
    diagnoseUnit(prompt, {
      vocabulary: { "brand blue": "#0A84FF" },
    }),
    [],
  );
  const explanation = explainUnit(prompt, {
    vocabulary: { "brand blue": "#0A84FF" },
  });
  assert.ok(explanation[0]?.facets.every((facet) => facet.satisfied));
});

test("requirement table has stable unique ids and complete facet prose", () => {
  assert.equal(
    new Set(REQUIREMENT_RULES.map((rule) => rule.id)).size,
    REQUIREMENT_RULES.length,
  );
  for (const rule of REQUIREMENT_RULES) {
    assert.ok(rule.id.length > 0);
    assert.equal(
      new Set(rule.facets.map((facet) => facet.id)).size,
      rule.facets.length,
    );
    for (const facet of rule.facets) {
      assert.ok(facet.question.length > 0);
      assert.ok(facet.example.length > 0);
    }
  }
});

test("every starter rule blocks its vague form and accepts a fully specified form", () => {
  const cases: Array<[string, string, string]> = [
    ["table", "add a table", "add a table with columns named name, email, and role, rows from the users API, where each row shows name, email, and role"],
    ["chart", "add a chart", "add a line chart using data from the monthlyRevenue array with labels Month, Revenue, and Goal"],
    ["button", "add a button", 'add a button labelled "Save" in the header; when clicked save changes'],
    ["animation", "add an animation", "animate the panel opacity for 200ms with ease-out when opening"],
    ["form", "add a form", "add a form with fields name, email, and phone; email is required; submit the form to /api/contact"],
    ["endpoint", "add an endpoint", "add a POST endpoint /api/orders with request body containing sku; return 201 with an order; handle 400 invalid errors"],
    ["list", "add cards", "add 6 cards where each card shows title, image, and summary"],
    ["sort", "sort the results", "sort the results by createdAt, newest first"],
    ["responsive", "make the navigation responsive", "make the navigation responsive below 768px by stacking it"],
    ["color", "change the color", "change the color to #0A84FF on the header"],
    ["spacing", "add padding", "set padding to 16px on the header"],
    ["font", "change the font", "set font-family: Inter, font size 16px, weight 600"],
    ["limit", "add a timeout", "add a timeout of 5 seconds"],
    ["subjective", "make it modern", "make it modern with #0A84FF"],
  ];
  for (const [rule, vague, specific] of cases) {
    assert.ok(
      diagnoseUnit(unit(vague)).some((diagnostic) => diagnostic.rule === rule),
      `${rule} should diagnose its vague form`,
    );
    assert.ok(
      !diagnoseUnit(unit(specific)).some((diagnostic) => diagnostic.rule === rule),
      `${rule} should accept its fully specified form`,
    );
  }
});

test("algorithm and pseudocode terms do not activate unrelated UI requirement rules", () => {
  const scenarios = [
    "Implement BFS for an undirected graph represented by an adjacency list. Given start vertex s, return vertices in visitation order.",
    "Implement a hash table with string keys using separate chaining; expose insert, get, and remove.",
    "Implement a singly linked list with push, pop, and reverse operations.",
    "Given input array arr and integer k, return the number of pairs whose sum is divisible by k.",
    "Color an undirected graph with at most k colors using backtracking; return the assigned color for each vertex or null.",
    "Compute the height of a binary tree recursively; an empty tree has height zero.",
    "Find the shortest route between two vertices with Dijkstra's algorithm and return the path plus total distance.",
    "In Rust, sort the vector values in ascending order using merge sort and return a new Vec<i32>.",
  ];
  for (const prompt of scenarios) {
    assert.deepEqual(
      diagnoseUnit(unit(prompt)),
      [],
      `algorithm prompt should not be treated as an underspecified UI request: ${prompt}`,
    );
  }
});
