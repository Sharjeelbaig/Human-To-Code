import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedCodeFromLanguageRules,
  type ConversionUnit,
} from "../src/index.ts";
import { normalizeRuleInstruction } from "../src/tools/compiler/language-rules.ts";

/**
 * The deterministic language rules are validation expectations only. Every
 * instruction is model-generated first; these cases pin when the validator can
 * safely check a precise fragment and when it must remain silent.
 *
 * This corpus pins the supported phrasing families. A phrasing listed under
 * `compiles` must yield an expectation; one listed under `defers` must return
 * undefined so the general validators decide. Both directions matter: silently
 * widening this layer risks rejecting valid model-generated code.
 */

function unit(
  insertionContext: ConversionUnit["insertionContext"],
  prompt: string,
  language = "typescript",
  ext = "ts",
): ConversionUnit {
  return {
    kind: "inline",
    sourcePath: `sample.${ext}`,
    absoluteSource: `/tmp/sample.${ext}`,
    language,
    insertionContext,
    prompt,
    describe: prompt,
  };
}

interface RuleFamily {
  name: string;
  context: ConversionUnit["insertionContext"];
  compiles: ReadonlyArray<readonly [instruction: string, expected: string]>;
  defers: readonly string[];
}

const FAMILIES: readonly RuleFamily[] = [
  {
    name: "typed parameter lists",
    context: "parameter-list",
    compiles: [
      ["add the parameters x and y with number types", "x: number, y: number"],
      // The phrasing that regressed in 1.0.0 and every neighbour of it.
      ["add the parameters that are x and y with number types", "x: number, y: number"],
      ["add the parameters which are x and y with number types", "x: number, y: number"],
      ["add the parameters that is x and y with number types", "x: number, y: number"],
      ["add the parameters named x and y with number types", "x: number, y: number"],
      ["add the parameters called x and y with number types", "x: number, y: number"],
      ["add the parameters labelled x and y with number types", "x: number, y: number"],
      ["add the parameters consisting of x and y with number types", "x: number, y: number"],
      ["add the parameters: x and y with number types", "x: number, y: number"],
      ["add the parameters x, y with number types", "x: number, y: number"],
      ["add the parameters both x and y with number types", "x: number, y: number"],
      ["please add the parameters x and y with number types", "x: number, y: number"],
      ["add two number parameters x and y", "x: number, y: number"],
      ["add x and y as number parameters", "x: number, y: number"],
      ["add x and y as parameters with number types", "x: number, y: number"],
      ["add the parameter total with number type", "total: number"],
      ["add the parameters x number, y number", "x: number, y: number"],
      ["add the parameters x and y with string types", "x: string, y: string"],
      ["add the parameters x and y with boolean types", "x: boolean, y: boolean"],
      ["add the parameters x and y with integer types", "x: number, y: number"],
      ["add the parameters a, b and c with number types", "a: number, b: number, c: number"],
    ],
    defers: [
      // No names at all.
      "add the parameters",
      "add the parameters with number types",
      // `and totals` leaves no valid two-name list once the connective is
      // rejected as an identifier; guessing here would emit a parameter
      // literally called `and`.
      "add the parameters and totals with number types",
      // No type anywhere, so there is nothing to lower deterministically.
      "add the parameters x and y",
      // A repeated name is a contradiction, not a list.
      "add the parameters x and x with number types",
      // Open-ended shapes the rules deliberately do not model.
      "add whatever parameters the caller needs",
      "add the parameters described in the design document",
    ],
  },
  {
    name: "arithmetic function bodies",
    context: "function-body",
    compiles: [
      ["add the logic of adding x and y", "return x + y;"],
      ["add the logic for adding x and y", "return x + y;"],
      ["add the logic that is adding x and y", "return x + y;"],
      ["return the sum of x and y", "return x + y;"],
      ["return the total of x and y", "return x + y;"],
      ["return the product of x and y", "return x * y;"],
      ["return the quotient of x by y", "return x / y;"],
      ["return x plus y", "return x + y;"],
      ["return x minus y", "return x - y;"],
      ["return x times y", "return x * y;"],
      ["return x multiplied by y", "return x * y;"],
      ["return x divided by y", "return x / y;"],
      ["return x + y", "return x + y;"],
      ["compute x minus y", "return x - y;"],
      ["multiply x and y", "return x * y;"],
      ["divide x by y", "return x / y;"],
      // `from` reverses the operands, and must.
      ["subtract y from x", "return x - y;"],
      ["return the difference of y from x", "return x - y;"],
    ],
    defers: [
      "do something clever",
      "add the logic",
      // Connective incoherent with the operator: refusing beats guessing an order.
      "add x by y",
      "divide x and y",
      "return the sum of all the values",
      "increment the counter by one",
      "handle the error case appropriately",
    ],
  },
  {
    name: "call output statements",
    context: "statement",
    compiles: [
      [
        "console log the result of calling the add function with 1,2 parameters",
        "console.log(add(1, 2));",
      ],
      [
        "console log the result of calling add with 1, 2 arguments",
        "console.log(add(1, 2));",
      ],
      ["print add(1, 2)", "console.log(add(1, 2));"],
      ["log the result of add(1,2)", "console.log(add(1, 2));"],
      ["console log add(1, 2)", "console.log(add(1, 2));"],
      ["display total(3.5, -2)", "console.log(total(3.5, -2));"],
      ['print greet("world")', 'console.log(greet("world"));'],
      ["output ready(true)", "console.log(ready(true));"],
    ],
    defers: [
      "console log the result",
      // No output verb, so this is not an output statement.
      "call add with 1 and 2",
      // Non-literal arguments get no exact expectation; their values are not knowable here.
      "console log the result of calling add with x, y arguments",
      "log everything that happened",
    ],
  },
];

for (const family of FAMILIES) {
  test(`${family.name} yield the same expectation from every supported phrasing`, () => {
    for (const [instruction, expected] of family.compiles) {
      assert.equal(
        expectedCodeFromLanguageRules(unit(family.context, instruction)),
        expected,
        `expected ${JSON.stringify(instruction)} to yield a deterministic expectation`,
      );
    }
  });

  test(`${family.name} leave ambiguous or unmodelled phrasings unchecked`, () => {
    for (const instruction of family.defers) {
      assert.equal(
        expectedCodeFromLanguageRules(unit(family.context, instruction)),
        undefined,
        `expected ${JSON.stringify(instruction)} to leave validation to the general gates`,
      );
    }
  });
}

test("normalization only ever removes words, never invents an identifier", () => {
  const samples = [
    "add the parameters that are x and y with number types",
    "add the parameters consisting of alpha, beta and gamma with string types",
    "return the difference of y from x",
    "console log the result of calling add with 1, 2 arguments",
  ];
  for (const sample of samples) {
    const normalized = normalizeRuleInstruction(sample);
    const original = new Set(sample.toLowerCase().match(/[a-z_$][\w$]*/gu) ?? []);
    for (const word of normalized.toLowerCase().match(/[a-z_$][\w$]*/gu) ?? []) {
      assert.ok(
        original.has(word),
        `normalization introduced the word ${JSON.stringify(word)}, which was not in the instruction`,
      );
    }
  }
});

test("the same phrasing yields each language's own expected syntax", () => {
  const instruction = "add the parameters that are x and y with number types";
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["typescript", "ts", "x: number, y: number"],
    ["python", "py", "x: float, y: float"],
    ["rust", "rs", "x: f64, y: f64"],
    ["go", "go", "x float64, y float64"],
    ["java", "java", "double x, double y"],
    ["csharp", "cs", "double x, double y"],
  ];
  for (const [language, ext, expected] of cases) {
    assert.equal(
      expectedCodeFromLanguageRules(
        unit("parameter-list", instruction, language, ext),
      ),
      expected,
      `${language} derived the shared expectation incorrectly`,
    );
  }
});

test("a reworded instruction never changes the validation expectation", () => {
  // Equivalent wording must receive the same optional structural check after
  // the model has generated both replacements.
  const equivalent = [
    "add the parameters x and y with number types",
    "add the parameters that are x and y with number types",
    "add the parameters which are x and y with number types",
    "add the parameters named x and y with number types",
    "add x and y as number parameters",
    "add two number parameters x and y",
  ];
  const outputs = new Set(
    equivalent.map((instruction) =>
      expectedCodeFromLanguageRules(unit("parameter-list", instruction)),
    ),
  );
  assert.equal(
    outputs.size,
    1,
    `equivalent phrasings produced divergent output: ${JSON.stringify([...outputs])}`,
  );
  assert.deepEqual([...outputs], ["x: number, y: number"]);
});
