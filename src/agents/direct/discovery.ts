import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { languageProfile } from "./languages.ts";
import { extractInlineMarkers } from "./marker-parser.ts";
import type { ConversionUnit } from "./types.ts";

const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".rb", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
]);

const DEFAULT_IGNORES = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv",
  "coverage", ".human-to-code",
]);

async function walk(root: string, ignores: ReadonlySet<string>): Promise<string[]> {
  const results: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 40) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".human-to-code" && entry.isDirectory()) continue;
      if (ignores.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) results.push(full);
    }
  };
  await visit(root, 0);
  return results.sort();
}

/** Discover whole-file and inline direct-conversion units. */
export async function discoverUnits(root: string, language: string): Promise<ConversionUnit[]> {
  const absoluteRoot = resolve(root);
  const profile = languageProfile(language);
  const files = await walk(absoluteRoot, DEFAULT_IGNORES);
  const units: ConversionUnit[] = [];

  for (const absolute of files) {
    const rel = relative(absoluteRoot, absolute).split(sep).join("/");
    const name = basename(absolute);
    if (name.endsWith(".strict.human")) continue;
    if (name.endsWith(".human")) {
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      const prompt = content.trim();
      if (prompt.length === 0) continue;
      const outputPath = `${rel.slice(0, -".human".length)}.${profile.ext}`;
      units.push({
        kind: "file",
        sourcePath: rel,
        absoluteSource: absolute,
        prompt,
        outputPath,
        describe: `${rel}  ->  ${outputPath}`,
      });
      continue;
    }

    if (!SCANNED_EXTENSIONS.has(extname(absolute).toLowerCase())) continue;
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (!content.includes("@human")) continue;
    for (const marker of extractInlineMarkers(content)) {
      const line = content.slice(0, marker.start).split("\n").length;
      units.push({
        kind: "inline",
        sourcePath: rel,
        absoluteSource: absolute,
        prompt: marker.prompt,
        range: { start: marker.start, end: marker.end },
        line,
        describe: `${rel}  (inline @human, line ${line})  ->  ${rel}`,
      });
    }
  }
  return units;
}
