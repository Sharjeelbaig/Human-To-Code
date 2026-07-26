/**
 * TypeScript evaluation corpus: what this project is actually asked to do.
 *
 * Unlike the stress corpus, which scripts a fake endpoint and measures whether
 * the CLI stays inside its contract, this corpus talks to a *real* model and
 * measures whether the code that comes out is correct. Correctness is decided by
 * running it, never by inspecting it: each task ships a `check` module that
 * imports the generated target and asserts real behavior.
 *
 * Rules every task follows, so a score means something:
 *  - The instruction fully determines the answer. If a competent developer could
 *    read it two ways, the task is wrong, not the model.
 *  - The target exports what `check` imports, so the oracle can reach it.
 *  - `check` asserts behavior, not formatting, naming style, or implementation.
 */

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: ".",
      allowImportingTsExtensions: false,
    },
    include: ["src/**/*.ts", "check.ts"],
  },
  null,
  2,
);

/** Every task compiles against the same strict configuration. */
export const EVAL_TSCONFIG = TSCONFIG;

export const TASKS = [
  {
    id: "params-and-body",
    summary: "parameter list and function body markers in one file",
    files: {
      "src/math.ts":
        "export function add(\n"
        + "    // @human add the parameters x and y with number types\n"
        + ") {\n"
        + "    // @human return the sum of x and y\n"
        + "}\n",
    },
    target: "src/math.ts",
    check:
      'import { add } from "./src/math.js";\n'
      + "if (add(1, 2) !== 3) throw new Error(`add(1,2) === ${add(1, 2)}`);\n"
      + "if (add(-4, 4) !== 0) throw new Error(`add(-4,4) === ${add(-4, 4)}`);\n",
  },
  {
    id: "body-only-multiply",
    summary: "function body marker with existing typed parameters",
    files: {
      "src/mul.ts":
        "export function multiply(a: number, b: number): number {\n"
        + "    // @human return a multiplied by b\n"
        + "}\n",
    },
    target: "src/mul.ts",
    check:
      'import { multiply } from "./src/mul.js";\n'
      + "if (multiply(3, 4) !== 12) throw new Error(`multiply(3,4) === ${multiply(3, 4)}`);\n"
      + "if (multiply(0, 9) !== 0) throw new Error('multiply(0,9) must be 0');\n",
  },
  {
    id: "interdependent-three-markers",
    summary: "the reported case: parameters, body, and a dependent statement",
    files: {
      "src/calc.ts":
        "export function add(\n"
        + "    // @human add the parameters that are x and y with number types\n"
        + ") {\n"
        + "    // @human add the logic of adding x and y\n"
        + "}\n"
        + "\n"
        + "// @human export a constant named sample set to the result of calling add with 1 and 2\n",
    },
    target: "src/calc.ts",
    check:
      'import { add, sample } from "./src/calc.js";\n'
      + "if (add(2, 5) !== 7) throw new Error('add(2,5) must be 7');\n"
      + "if (sample !== 3) throw new Error(`sample === ${sample}`);\n",
  },
  {
    id: "human-file-stack",
    summary: "a whole .human file describing a class",
    files: {
      "src/stack.ts.human":
        "export a class named Stack with a private array of numbers.\n"
        + "It has a push method taking a number and returning void,\n"
        + "a pop method returning number or undefined,\n"
        + "and a size method returning the number of stored items.\n",
    },
    target: "src/stack.ts",
    check:
      'import { Stack } from "./src/stack.js";\n'
      + "const s = new Stack();\n"
      + "if (s.size() !== 0) throw new Error('new stack must be empty');\n"
      + "s.push(1); s.push(2);\n"
      + "if (s.size() !== 2) throw new Error('size must be 2');\n"
      + "if (s.pop() !== 2) throw new Error('pop must return the last pushed value');\n"
      + "if (s.size() !== 1) throw new Error('size must drop after pop');\n",
  },
  {
    id: "human-file-clamp",
    summary: "a whole .human file describing a pure function with edge cases",
    files: {
      "src/clamp.ts.human":
        "export a function named clamp that takes value, minimum and maximum as numbers\n"
        + "and returns the value limited to the inclusive range.\n"
        + "If value is below minimum return minimum, if above maximum return maximum.\n",
    },
    target: "src/clamp.ts",
    check:
      'import { clamp } from "./src/clamp.js";\n'
      + "if (clamp(5, 0, 10) !== 5) throw new Error('inside range must pass through');\n"
      + "if (clamp(-3, 0, 10) !== 0) throw new Error('below minimum must clamp up');\n"
      + "if (clamp(42, 0, 10) !== 10) throw new Error('above maximum must clamp down');\n",
  },
  {
    id: "statement-append",
    summary: "a statement marker that must mutate existing state",
    files: {
      "src/log.ts":
        "export const entries: string[] = [];\n"
        + "\n"
        + "export function record(message: string): void {\n"
        + "    // @human push the message onto the entries array\n"
        + "}\n",
    },
    target: "src/log.ts",
    check:
      'import { entries, record } from "./src/log.js";\n'
      + "record('one'); record('two');\n"
      + "if (entries.length !== 2) throw new Error(`entries.length === ${entries.length}`);\n"
      + "if (entries[0] !== 'one' || entries[1] !== 'two') throw new Error('wrong order or contents');\n",
  },
  {
    id: "array-filter-evens",
    summary: "array transformation with a precise contract",
    files: {
      "src/evens.ts":
        "export function evens(values: number[]): number[] {\n"
        + "    // @human return only the even numbers, preserving their original order\n"
        + "}\n",
    },
    target: "src/evens.ts",
    check:
      'import { evens } from "./src/evens.js";\n'
      + "const out = evens([1, 2, 3, 4, 6, 7]);\n"
      + "if (JSON.stringify(out) !== JSON.stringify([2, 4, 6])) throw new Error(JSON.stringify(out));\n"
      + "if (evens([]).length !== 0) throw new Error('empty input must give empty output');\n",
  },
  {
    id: "reduce-sum",
    summary: "aggregation over an array",
    files: {
      "src/total.ts":
        "export function total(values: number[]): number {\n"
        + "    // @human return the sum of every value, and 0 for an empty array\n"
        + "}\n",
    },
    target: "src/total.ts",
    check:
      'import { total } from "./src/total.js";\n'
      + "if (total([1, 2, 3, 4]) !== 10) throw new Error('sum must be 10');\n"
      + "if (total([]) !== 0) throw new Error('empty must be 0');\n"
      + "if (total([-5, 5]) !== 0) throw new Error('negatives must sum');\n",
  },
  {
    id: "string-reverse-words",
    summary: "string manipulation with an exact expected result",
    files: {
      "src/words.ts":
        "export function reverseWords(sentence: string): string {\n"
        + "    // @human return the words in reverse order, separated by single spaces\n"
        + "}\n",
    },
    target: "src/words.ts",
    check:
      'import { reverseWords } from "./src/words.js";\n'
      + "const out = reverseWords('one two three');\n"
      + "if (out !== 'three two one') throw new Error(JSON.stringify(out));\n",
  },
  {
    id: "throws-on-invalid",
    summary: "error handling as an explicit requirement",
    files: {
      "src/divide.ts":
        "export function divide(numerator: number, denominator: number): number {\n"
        + "    // @human throw an Error when denominator is 0, otherwise return the division result\n"
        + "}\n",
    },
    target: "src/divide.ts",
    check:
      'import { divide } from "./src/divide.js";\n'
      + "if (divide(10, 2) !== 5) throw new Error('10/2 must be 5');\n"
      + "let threw = false;\n"
      + "try { divide(1, 0); } catch { threw = true; }\n"
      + "if (!threw) throw new Error('division by zero must throw');\n",
  },
  {
    id: "async-resolve",
    summary: "an async function with a typed promise result",
    files: {
      "src/later.ts":
        "export async function doubled(value: number): Promise<number> {\n"
        + "    // @human return the value multiplied by two\n"
        + "}\n",
    },
    target: "src/later.ts",
    check:
      'import { doubled } from "./src/later.js";\n'
      + "const value = await doubled(21);\n"
      + "if (value !== 42) throw new Error(`doubled(21) === ${value}`);\n",
  },
  {
    id: "map-counter",
    summary: "Map usage with a precise counting contract",
    files: {
      "src/counts.ts":
        "export function countWords(words: string[]): Map<string, number> {\n"
        + "    // @human return a Map from each word to how many times it appears\n"
        + "}\n",
    },
    target: "src/counts.ts",
    check:
      'import { countWords } from "./src/counts.js";\n'
      + "const counts = countWords(['a', 'b', 'a']);\n"
      + "if (counts.get('a') !== 2) throw new Error('a must appear twice');\n"
      + "if (counts.get('b') !== 1) throw new Error('b must appear once');\n",
  },
  {
    id: "recursion-factorial",
    summary: "recursion with a defined base case",
    files: {
      "src/factorial.ts":
        "export function factorial(n: number): number {\n"
        + "    // @human return the factorial of n, where the factorial of 0 is 1\n"
        + "}\n",
    },
    target: "src/factorial.ts",
    check:
      'import { factorial } from "./src/factorial.js";\n'
      + "if (factorial(0) !== 1) throw new Error('0! must be 1');\n"
      + "if (factorial(5) !== 120) throw new Error(`5! === ${factorial(5)}`);\n",
  },
  {
    id: "sort-descending",
    summary: "sorting without mutating the caller's array",
    files: {
      "src/sorted.ts":
        "export function sortedDescending(values: number[]): number[] {\n"
        + "    // @human return a new array sorted from highest to lowest, leaving the input unchanged\n"
        + "}\n",
    },
    target: "src/sorted.ts",
    check:
      'import { sortedDescending } from "./src/sorted.js";\n'
      + "const input = [3, 1, 2];\n"
      + "const out = sortedDescending(input);\n"
      + "if (JSON.stringify(out) !== JSON.stringify([3, 2, 1])) throw new Error(JSON.stringify(out));\n"
      + "if (JSON.stringify(input) !== JSON.stringify([3, 1, 2])) throw new Error('input was mutated');\n",
  },
  {
    id: "interface-and-factory",
    summary: "a type declaration plus a function that satisfies it",
    files: {
      "src/user.ts.human":
        "export an interface named User with an id of type string, a name of type string,\n"
        + "and an active flag of type boolean.\n"
        + "Also export a function named createUser taking id and name\n"
        + "that returns a User with active set to true.\n",
    },
    target: "src/user.ts",
    check:
      'import { createUser } from "./src/user.js";\n'
      + "const user = createUser('u1', 'Ada');\n"
      + "if (user.id !== 'u1' || user.name !== 'Ada') throw new Error('fields not carried through');\n"
      + "if (user.active !== true) throw new Error('active must default to true');\n",
  },
  {
    id: "generic-identity-pair",
    summary: "generics with a precise return shape",
    files: {
      "src/pair.ts":
        "export function pair<T>(value: T): [T, T] {\n"
        + "    // @human return a tuple containing the value twice\n"
        + "}\n",
    },
    target: "src/pair.ts",
    check:
      'import { pair } from "./src/pair.js";\n'
      + "const out = pair('x');\n"
      + "if (out.length !== 2 || out[0] !== 'x' || out[1] !== 'x') throw new Error(JSON.stringify(out));\n",
  },
  {
    id: "null-safe-lookup",
    summary: "optional handling with a defined fallback",
    files: {
      "src/lookup.ts":
        "export function nameOf(users: Record<string, string>, id: string): string {\n"
        + "    // @human return the user name for the id, or the string unknown when it is missing\n"
        + "}\n",
    },
    target: "src/lookup.ts",
    check:
      'import { nameOf } from "./src/lookup.js";\n'
      + "if (nameOf({ a: 'Ada' }, 'a') !== 'Ada') throw new Error('present key must return its value');\n"
      + "if (nameOf({}, 'zz') !== 'unknown') throw new Error('missing key must return unknown');\n",
  },
  {
    id: "class-method-marker",
    summary: "a marker inside an existing class body",
    files: {
      "src/counter.ts":
        "export class Counter {\n"
        + "    private value = 0;\n"
        + "\n"
        + "    increment(): void {\n"
        + "        // @human add one to the value field\n"
        + "    }\n"
        + "\n"
        + "    current(): number {\n"
        + "        return this.value;\n"
        + "    }\n"
        + "}\n",
    },
    target: "src/counter.ts",
    check:
      'import { Counter } from "./src/counter.js";\n'
      + "const c = new Counter();\n"
      + "c.increment(); c.increment();\n"
      + "if (c.current() !== 2) throw new Error(`current === ${c.current()}`);\n",
  },
  {
    id: "two-files-import",
    summary: "two generated files where one imports the other",
    files: {
      "src/constants.ts.human": "export a constant named BASE with the number value 10.\n",
      "src/scaled.ts.human":
        "import BASE from the constants module in the same folder\n"
        + "and export a function named scale that takes a factor number\n"
        + "and returns BASE multiplied by the factor.\n",
    },
    target: "src/scaled.ts",
    check:
      'import { scale } from "./src/scaled.js";\n'
      + "if (scale(3) !== 30) throw new Error(`scale(3) === ${scale(3)}`);\n",
  },
  {
    id: "union-narrowing",
    summary: "a discriminated union handled exhaustively",
    files: {
      "src/shape.ts.human":
        "export a type named Shape that is either { kind: 'circle', radius: number }\n"
        + "or { kind: 'square', side: number }.\n"
        + "Export a function named area taking a Shape and returning its area as a number.\n"
        + "Use Math.PI times radius squared for a circle, and side times side for a square.\n",
    },
    target: "src/shape.ts",
    check:
      'import { area } from "./src/shape.js";\n'
      + "if (area({ kind: 'square', side: 3 }) !== 9) throw new Error('square area must be 9');\n"
      + "const circle = area({ kind: 'circle', radius: 2 });\n"
      + "if (Math.abs(circle - Math.PI * 4) > 1e-9) throw new Error(`circle area === ${circle}`);\n",
  },
  {
    id: "default-parameter",
    summary: "a default parameter value stated in the instruction",
    files: {
      "src/greet.ts":
        "export function greet(\n"
        + "    // @human add the parameters name with string type and greeting with string type defaulting to Hello\n"
        + "): string {\n"
        + "    // @human return the greeting followed by a space and the name\n"
        + "}\n",
    },
    target: "src/greet.ts",
    check:
      'import { greet } from "./src/greet.js";\n'
      + "if (greet('Ada') !== 'Hello Ada') throw new Error(JSON.stringify(greet('Ada')));\n"
      + "if (greet('Ada', 'Hi') !== 'Hi Ada') throw new Error(JSON.stringify(greet('Ada', 'Hi')));\n",
  },
  {
    id: "dedupe-preserve-order",
    summary: "deduplication with an explicit ordering requirement",
    files: {
      "src/unique.ts":
        "export function unique(values: string[]): string[] {\n"
        + "    // @human return the values without duplicates, keeping the first occurrence order\n"
        + "}\n",
    },
    target: "src/unique.ts",
    check:
      'import { unique } from "./src/unique.js";\n'
      + "const out = unique(['b', 'a', 'b', 'c', 'a']);\n"
      + "if (JSON.stringify(out) !== JSON.stringify(['b', 'a', 'c'])) throw new Error(JSON.stringify(out));\n",
  },
  {
    id: "chunk-array",
    summary: "a stated algorithm with an exact expected partition",
    files: {
      "src/chunk.ts":
        "export function chunk(values: number[], size: number): number[][] {\n"
        + "    // @human split the values into consecutive arrays of at most size items\n"
        + "}\n",
    },
    target: "src/chunk.ts",
    check:
      'import { chunk } from "./src/chunk.js";\n'
      + "const out = chunk([1, 2, 3, 4, 5], 2);\n"
      + "if (JSON.stringify(out) !== JSON.stringify([[1, 2], [3, 4], [5]])) throw new Error(JSON.stringify(out));\n",
  },
  {
    id: "validate-and-return-union",
    summary: "a small result type with both branches exercised",
    files: {
      "src/parse.ts.human":
        "export a function named parsePort taking a string.\n"
        + "When the string is a whole number between 1 and 65535 return that number.\n"
        + "Otherwise return null.\n",
    },
    target: "src/parse.ts",
    check:
      'import { parsePort } from "./src/parse.js";\n'
      + "if (parsePort('8080') !== 8080) throw new Error('valid port must parse');\n"
      + "if (parsePort('0') !== null) throw new Error('0 is out of range');\n"
      + "if (parsePort('abc') !== null) throw new Error('non numeric must be null');\n"
      + "if (parsePort('70000') !== null) throw new Error('above range must be null');\n",
  },
  {
    id: "group-by-key",
    summary: "grouping records by a field, with an exact expected shape",
    files: {
      "src/group.ts":
        "export function groupByFirstLetter(words: string[]): Record<string, string[]> {\n"
        + "    // @human return an object mapping each first letter to the words starting with it, in input order\n"
        + "}\n",
    },
    target: "src/group.ts",
    check:
      'import { groupByFirstLetter } from "./src/group.js";\n'
      + "const out = groupByFirstLetter(['ant', 'bee', 'ape']);\n"
      + "if (JSON.stringify(out.a) !== JSON.stringify(['ant', 'ape'])) throw new Error(JSON.stringify(out));\n"
      + "if (JSON.stringify(out.b) !== JSON.stringify(['bee'])) throw new Error(JSON.stringify(out));\n",
  },
  {
    id: "range-inclusive",
    summary: "a generator-style helper with stated inclusivity",
    files: {
      "src/range.ts":
        "export function range(start: number, end: number): number[] {\n"
        + "    // @human return every whole number from start to end inclusive, or an empty array when start is above end\n"
        + "}\n",
    },
    target: "src/range.ts",
    check:
      'import { range } from "./src/range.js";\n'
      + "if (JSON.stringify(range(1, 4)) !== JSON.stringify([1, 2, 3, 4])) throw new Error(JSON.stringify(range(1, 4)));\n"
      + "if (range(5, 2).length !== 0) throw new Error('descending range must be empty');\n"
      + "if (JSON.stringify(range(3, 3)) !== JSON.stringify([3])) throw new Error('single point range');\n",
  },
  {
    id: "memoize-calls",
    summary: "a higher-order function whose caching is observable",
    files: {
      "src/memo.ts.human":
        "export a function named memoize that takes a function from number to number\n"
        + "and returns a function with the same signature.\n"
        + "The returned function caches each result by its argument\n"
        + "so the wrapped function runs only once per distinct argument.\n",
    },
    target: "src/memo.ts",
    check:
      'import { memoize } from "./src/memo.js";\n'
      + "let calls = 0;\n"
      + "const slow = (n: number): number => { calls += 1; return n * 2; };\n"
      + "const fast = memoize(slow);\n"
      + "if (fast(4) !== 8 || fast(4) !== 8) throw new Error('memoized result must stay correct');\n"
      + "if (calls !== 1) throw new Error(`wrapped function ran ${calls} times, expected 1`);\n"
      + "if (fast(5) !== 10 || calls !== 2) throw new Error('a new argument must reach the wrapped function');\n",
  },
];

/**
 * The certification contract in `src/llms/certification.ts` requires at least 25
 * tasks per ecosystem before any evidence can score as certified, so this corpus
 * is sized to clear that floor rather than merely to sample behavior.
 */
export const TASK_COUNT = TASKS.length;
