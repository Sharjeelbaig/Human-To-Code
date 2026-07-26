import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

/**
 * Every regular expression in the codebase must stay roughly linear.
 *
 * Model output, generated candidates, and analyzed repository files are all
 * untrusted input that reaches these patterns at arbitrary size. One greedy,
 * unbounded pattern in the CSS nesting scan
 * (`([^{};]+)\{[^{}]*?(&[^{}]+)\{`) retried every start position at every
 * length, so a multi-megabyte candidate turned a conversion into an hours-long
 * CPU spin with no output and no timeout. Reviewing patterns by eye does not
 * catch that, so this measures it instead.
 *
 * The test is deliberately generous: a linear pattern finishes these inputs in
 * single-digit milliseconds, so the thresholds below sit orders of magnitude
 * above normal while still catching quadratic blow-up.
 */

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/** A 4x size step, so quadratic behavior shows up as roughly 16x the time. */
const SMALL = 8 * 1024;
const LARGE = 32 * 1024;

/** Absolute floor before a ratio is even considered; avoids timing noise. */
const SLOW_ENOUGH_TO_JUDGE_MS = 250;
/** A linear pattern lands near 4x across this size step. */
const MAX_GROWTH_RATIO = 8;

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

interface FoundPattern {
  file: string;
  line: number;
  source: string;
  flags: string;
}

/** Collect every regular-expression literal, with its location for reporting. */
function patternsIn(file: string, text: string): FoundPattern[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: FoundPattern[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      const raw = node.getText();
      const end = raw.lastIndexOf("/");
      if (end > 0) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          source: raw.slice(1, end),
          flags: raw.slice(end + 1),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Inputs chosen to starve a pattern of the literal it needs: long runs with no
 * terminator are what force a greedy quantifier to backtrack.
 */
function pathologicalInputs(size: number): string[] {
  const unit = (piece: string): string => piece.repeat(Math.ceil(size / piece.length)).slice(0, size);
  return [
    unit("x"),
    unit("a "),
    unit("{"),
    unit("("),
    unit('"'),
    unit("a=b;"),
    unit(".a-b "),
    unit("@human "),
  ];
}

function timeOnce(pattern: FoundPattern, input: string): number {
  // A fresh instance per run so `g`/`y` lastIndex never carries over.
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern.source, flags);
  } catch {
    return 0;
  }
  const started = performance.now();
  // matchAll-style consumption is how the codebase drives these patterns.
  let guard = 0;
  while (regex.exec(input) !== null && guard < 100_000) {
    guard += 1;
    if (regex.lastIndex === 0) break;
  }
  return performance.now() - started;
}

test("no regular expression in src degrades superlinearly on hostile input", async () => {
  const files = await sourceFiles(SOURCE_ROOT);
  const patterns: FoundPattern[] = [];
  for (const file of files) {
    patterns.push(...patternsIn(file, await readFile(file, "utf8")));
  }
  assert.ok(patterns.length > 50, `expected to find many patterns, found ${patterns.length}`);

  const offenders: string[] = [];
  const smallInputs = pathologicalInputs(SMALL);
  const largeInputs = pathologicalInputs(LARGE);

  for (const pattern of patterns) {
    for (let index = 0; index < smallInputs.length; index += 1) {
      const small = timeOnce(pattern, smallInputs[index]!);
      const large = timeOnce(pattern, largeInputs[index]!);
      if (large < SLOW_ENOUGH_TO_JUDGE_MS) continue;
      const ratio = large / Math.max(small, 0.001);
      if (ratio > MAX_GROWTH_RATIO) {
        offenders.push(
          `${relative(SOURCE_ROOT, pattern.file)}:${pattern.line} /${pattern.source}/${pattern.flags}`
          + ` grew ${ratio.toFixed(1)}x (${small.toFixed(0)}ms -> ${large.toFixed(0)}ms)`
          + ` on a ${LARGE}-byte input`,
        );
      }
    }
  }

  assert.deepEqual(offenders, [], `superlinear regular expressions:\n${offenders.join("\n")}`);
});
