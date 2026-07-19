import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const GUIDE_PATH = fileURLToPath(new URL("../docs/CODEBASE_TOUR.md", import.meta.url));

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

test("the newcomer codebase tour represents every source file and both product journeys", async () => {
  const guide = await readFile(GUIDE_PATH, "utf8");
  const missingFiles = (await sourceFiles(SOURCE_ROOT))
    .map((path) => `src/${relative(SOURCE_ROOT, path).split("\\").join("/")}`)
    .filter((sourcePath) => !guide.includes(`../${sourcePath}`));
  assert.deepEqual(missingFiles, [], `Source files missing from CODEBASE_TOUR.md:\n${missingFiles.join("\n")}`);

  const requiredIdeas = [
    "Direct mode: `npx human-to-code .`",
    "Guided mode: `npx human-to-code guided .`",
    "The culture of this project",
    "Where should you make a change?",
  ];
  const missingIdeas = requiredIdeas.filter((idea) => !guide.includes(idea));
  assert.deepEqual(missingIdeas, [], `Newcomer guidance is missing: ${missingIdeas.join(", ")}`);
});
