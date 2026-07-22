/**
 * Runs after TypeScript compilation (`npm run build`). It copies only reviewed
 * markdown into `dist/skills`, which is where an installed
 * `npx human-to-code .` process resolves package-owned skills.
 *
 * Reproduce a missing-package-skill error with:
 *   npm run clean && npx tsc -p tsconfig.json && node dist/cli.js --help
 * The command intentionally skips this script; `dist/skills` will be absent.
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src", "skills");
const outputRoot = join(projectRoot, "dist", "skills");
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * This block runs once per build. TypeScript has already emitted
 * `dist/skills/index.js`, so it removes only generated child directories. That
 * prevents stale renamed markdown skills without deleting the compiled loader.
 */
await mkdir(outputRoot, { recursive: true });
for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && !entry.isSymbolicLink() && skillName.test(entry.name)) {
    await rm(join(outputRoot, entry.name), { recursive: true, force: true });
  }
}

for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.isSymbolicLink() || !skillName.test(entry.name)) continue;
  const sourceDirectory = join(sourceRoot, entry.name);
  const markdown = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((file) => file.isFile() && !file.isSymbolicLink() && file.name.toLowerCase().endsWith(".md"));
  if (!markdown.some((file) => file.name === "SKILL.md")) continue;
  const outputDirectory = join(outputRoot, entry.name);
  await mkdir(outputDirectory, { recursive: true });
  for (const file of markdown) {
    await copyFile(join(sourceDirectory, file.name), join(outputDirectory, file.name));
  }
}
