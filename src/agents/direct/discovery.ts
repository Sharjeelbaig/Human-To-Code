import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { inferUnitLanguage } from "./language-inference.ts";
import { languageForExtension, languageProfile } from "./languages.ts";
import { extractInlineMarkers } from "./marker-parser.ts";
import type { ConversionUnit, DirectDiscoveryResult } from "./types.ts";

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

/** Bounded direct-path file walk, shared with combined project validation. */
export async function walkDirectFiles(root: string): Promise<string[]> {
  return walk(resolve(root), DEFAULT_IGNORES);
}

/** Discover units plus actionable notices for marker text that cannot run safely. */
export async function discoverDirectUnits(
  root: string,
  language: string | readonly string[],
): Promise<DirectDiscoveryResult> {
  const absoluteRoot = resolve(root);
  const languages = (typeof language === "string" ? [language] : [...language])
    .map((entry) => entry.trim().toLowerCase());
  const primary = languages[0] ?? "typescript";
  const configured = new Set(languages);
  const files = await walk(absoluteRoot, DEFAULT_IGNORES);
  const units: ConversionUnit[] = [];
  const notices: DirectDiscoveryResult["notices"] = [];

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
      // An explicit inner extension is authoritative: `index.html.human` ->
      // `index.html`. Otherwise, a multi-language configuration infers the
      // target from the request text and filename before falling back to the
      // primary language, so `styles.human` is not written as `styles.ts`.
      const stem = rel.slice(0, -".human".length);
      const innerLanguage = languageForExtension(extname(stem));
      const routed = innerLanguage !== undefined && configured.has(innerLanguage);
      const unitLanguage = routed
        ? innerLanguage
        : inferUnitLanguage(basename(stem), prompt, languages);
      const outputPath = routed
        ? stem
        : `${stem}.${languageProfile(unitLanguage).ext}`;
      try {
        await stat(join(absoluteRoot, ...outputPath.split("/")));
        notices.push({
          code: "TARGET_EXISTS",
          sourcePath: rel,
          message: `${rel} was skipped because ${outputPath} already exists; existing files are never overwritten.`,
        });
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      units.push({
        kind: "file",
        sourcePath: rel,
        absoluteSource: absolute,
        prompt,
        outputPath,
        language: unitLanguage,
        describe: `${rel}  ->  ${outputPath}`,
      });
      continue;
    }

    if (!SCANNED_EXTENSIONS.has(extname(absolute).toLowerCase())) {
      let info;
      try {
        info = await stat(absolute);
      } catch {
        continue;
      }
      if (info.size > 1024 * 1024) continue;
      let unsupportedContent: string;
      try {
        unsupportedContent = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      if (unsupportedContent.includes("@human")) {
        notices.push({
          code: "UNSUPPORTED_MARKER_FILE",
          sourcePath: rel,
          message: `${rel} contains @human text but ${extname(absolute) || "extensionless files"} is not supported for inline conversion.`,
        });
      }
      continue;
    }
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
        language: languageForExtension(extname(absolute)) ?? primary,
        range: { start: marker.start, end: marker.end },
        expectedMarker: content.slice(marker.start, marker.end),
        line,
        describe: `${rel}  (inline @human, line ${line})  ->  ${rel}`,
      });
    }
  }
  return { units, notices };
}

/** Compatibility helper returning only runnable units. */
export async function discoverUnits(
  root: string,
  language: string | readonly string[],
): Promise<ConversionUnit[]> {
  return (await discoverDirectUnits(root, language)).units;
}
