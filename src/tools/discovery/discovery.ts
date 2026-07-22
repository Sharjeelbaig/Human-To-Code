/**
 * Turns discovered `.human` files and `@human` comments into bounded conversion
 * units, each with an explicit target path and language.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { inferUnitLanguage } from "./language-inference.ts";
import {
  languageForExtension,
  languageProfile,
  resolveLanguageDeclaration,
} from "./languages.ts";
import { extractInlineMarkers } from "./marker-parser.ts";
import type { HumanFileExtensionConfig } from "../../core/types.ts";
import type { ConversionUnit, DirectDiscoveryResult } from "../../workflows/types.ts";

const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".html", ".htm", ".css",
  ".py", ".rs", ".go", ".java", ".rb", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
]);

const DEFAULT_IGNORES = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv",
  "coverage", ".human-to-code",
]);

function cssInsertionDetails(source: string, markerStart: number): {
  context: "css-declarations" | "css-rule-list";
  owner?: string;
} {
  const prefix = source.slice(0, markerStart).replace(/\/\*[\s\S]*?\*\//gu, " ");
  const stack: string[] = [];
  let prelude = "";
  for (const char of prefix) {
    if (char === "{") {
      stack.push(prelude.trim());
      prelude = "";
    } else if (char === "}") {
      stack.pop();
      prelude = "";
    } else if (char === ";") {
      prelude = "";
    } else {
      prelude += char;
      if (prelude.length > 300) prelude = prelude.slice(-300);
    }
  }
  const owner = stack[stack.length - 1] ?? "";
  return owner.length > 0 && !/^@(media|supports|layer|container|document|scope)\b/iu.test(owner)
    ? { context: "css-declarations", owner }
    : { context: "css-rule-list" };
}

function insertionContextFor(path: string, source: string, start: number, marker: string): ConversionUnit["insertionContext"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".css") return cssInsertionDetails(source, start).context;
  if (
    [".tsx", ".jsx"].includes(extension)
    && source.slice(Math.max(0, start - 1), start) === "{"
    && source.slice(start + marker.length, start + marker.length + 1) === "}"
  ) return "jsx-child";
  if ([".html", ".htm"].includes(extension)) return "html-content";
  return "statement";
}

function surroundingSource(source: string, start: number, end: number): string {
  const before = source.slice(Math.max(0, start - 700), start);
  const after = source.slice(end, Math.min(source.length, end + 700));
  return `${before}<CURRENT_MARKER>${after}`;
}

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
  humanFileExtensions: readonly HumanFileExtensionConfig[] = [],
): Promise<DirectDiscoveryResult> {
  const absoluteRoot = resolve(root);
  const languages = (typeof language === "string" ? [language] : [...language])
    .map((entry) => entry.trim().toLowerCase());
  const primary = languages[0] ?? "typescript";
  const configured = new Set(languages);
  const configuredExtensionByPath = new Map<string, string>();
  for (const mapping of humanFileExtensions) {
    if (configuredExtensionByPath.has(mapping.path)) {
      throw new Error(`Duplicate configured .human path: ${mapping.path}`);
    }
    const extension = mapping.extension.replace(/^\./u, "").toLowerCase();
    const mappedLanguage = languageForExtension(extension);
    if (mappedLanguage === undefined || !configured.has(mappedLanguage)) {
      throw new Error(`Configured extension .${extension} for ${mapping.path} does not select an enabled language.`);
    }
    configuredExtensionByPath.set(mapping.path, extension);
  }
  const files = await walk(absoluteRoot, DEFAULT_IGNORES);
  const scannedPaths = files.map((absolute) => relative(absoluteRoot, absolute).split(sep).join("/"));
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
      const rawPrompt = content.trim();
      if (rawPrompt.length === 0) continue;
      const lines = rawPrompt.split(/\r?\n/u);
      const declaredToken = lines[0]?.trim() ?? "";
      const declaration = resolveLanguageDeclaration(declaredToken);
      const declaredExtension = declaration?.extension;
      const declaredLanguage = declaration?.language;
      const configuredExtension = configuredExtensionByPath.get(rel);
      const configuredLanguage = configuredExtension === undefined
        ? undefined
        : languageForExtension(configuredExtension)!;
      if (
        configuredLanguage !== undefined
        && declaredLanguage !== undefined
        && configuredLanguage !== declaredLanguage
      ) {
        notices.push({
          code: "EXTENSION_CONFLICT",
          sourcePath: rel,
          message: `${rel} was skipped because config selects .${configuredExtension} but its first line declares ${declaredToken} (.${declaredExtension}).`,
        });
        continue;
      }
      if (
        configuredLanguage === undefined
        && declaredLanguage !== undefined
        && !configured.has(declaredLanguage)
      ) {
        notices.push({
          code: "UNCONFIGURED_EXTENSION",
          sourcePath: rel,
          message: `${rel} was skipped because its first line declares ${declaredToken} (.${declaredExtension}), whose language is not enabled in config.languages.`,
        });
        continue;
      }
      const prompt = declaredLanguage === undefined
        ? rawPrompt
        : lines.slice(1).join("\n").trim();
      if (prompt.length === 0) continue;

      // Explicit config and first-line declarations outrank filename and text
      // inference. A recognized inner extension remains authoritative when
      // neither higher-priority route is present.
      const stem = rel.slice(0, -".human".length);
      const innerExtension = extname(stem);
      const innerLanguage = languageForExtension(innerExtension);
      const routed = innerLanguage !== undefined && configured.has(innerLanguage);
      const unitLanguage = configuredLanguage
        ?? declaredLanguage
        ?? (routed ? innerLanguage : inferUnitLanguage(basename(stem), prompt, languages));
      const explicitExtension = configuredExtension
        ?? declaredExtension;
      const outputBase = explicitExtension !== undefined && innerLanguage !== undefined
        ? stem.slice(0, -innerExtension.length)
        : stem;
      const outputPath = explicitExtension !== undefined
        ? `${outputBase}.${explicitExtension}`
        : routed
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
    const markers = extractInlineMarkers(content, rel);
    for (const marker of markers) {
      const line = content.slice(0, marker.start).split("\n").length;
      const expectedMarker = content.slice(marker.start, marker.end);
      const cssDetails = extname(rel).toLowerCase() === ".css"
        ? cssInsertionDetails(content, marker.start)
        : undefined;
      const ownsWholeFile = markers.length === 1 &&
        content.slice(0, marker.start).trim().length === 0 &&
        content.slice(marker.end).trim().length === 0;
      units.push({
        kind: "inline",
        sourcePath: rel,
        absoluteSource: absolute,
        prompt: marker.prompt,
        language: languageForExtension(extname(absolute)) ?? primary,
        range: { start: marker.start, end: marker.end },
        expectedMarker,
        ...(ownsWholeFile ? { ownsWholeFile: true } : {}),
        insertionContext: insertionContextFor(rel, content, marker.start, expectedMarker),
        ...(cssDetails?.owner ? { insertionOwner: cssDetails.owner } : {}),
        surroundingSource: surroundingSource(content, marker.start, marker.end),
        line,
        describe: `${rel}  (inline @human, line ${line})  ->  ${rel}`,
      });
    }
  }
  return { units, notices, scannedPaths };
}

/** Returns only the conversion units that are actually runnable. */
export async function discoverUnits(
  root: string,
  language: string | readonly string[],
  humanFileExtensions: readonly HumanFileExtensionConfig[] = [],
): Promise<ConversionUnit[]> {
  return (await discoverDirectUnits(root, language, humanFileExtensions)).units;
}
