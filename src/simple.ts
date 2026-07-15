/**
 * Simple `.human` -> code generator.
 *
 * This is the lightweight, direct path: discover human-language units, show a
 * receipt (requests / provider / model), and on confirmation write real code.
 * Two unit kinds are supported:
 *
 *   1. A whole `*.human` file (not `*.strict.human`) -> sibling `<base>.<ext>`.
 *   2. An inline `@human` marker inside an existing source file -> the marker
 *      region is replaced in place with generated code.
 *
 * It talks to a local Ollama endpoint directly (no extra dependency) so it works
 * out of the box; the `generateCode` seam can be swapped for another provider.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export interface LanguageProfile {
  /** Output file extension without a dot. */
  ext: string;
  /** Human label used in prompts. */
  label: string;
}

/** Operator-declared config language -> output extension and label. */
export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  typescript: { ext: "ts", label: "TypeScript" },
  javascript: { ext: "js", label: "JavaScript" },
  python: { ext: "py", label: "Python" },
  rust: { ext: "rs", label: "Rust" },
  go: { ext: "go", label: "Go" },
  java: { ext: "java", label: "Java" },
  ruby: { ext: "rb", label: "Ruby" },
  csharp: { ext: "cs", label: "C#" },
  cpp: { ext: "cpp", label: "C++" },
  c: { ext: "c", label: "C" },
};

export function languageProfile(language: string): LanguageProfile {
  return LANGUAGE_PROFILES[language.trim().toLowerCase()] ?? { ext: "txt", label: language };
}

/** Source extensions scanned for inline `@human` markers. */
const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".rb", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
]);

const DEFAULT_IGNORES = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".venv", "venv",
  "coverage", ".human-to-code",
]);

export interface ConversionUnit {
  kind: "file" | "inline";
  /** Project-relative source path. */
  sourcePath: string;
  /** Absolute source path. */
  absoluteSource: string;
  /** The extracted human-language instruction. */
  prompt: string;
  /** For `file` units, the project-relative output path to write. */
  outputPath?: string;
  /** For `inline` units, the character range of the marker to replace. */
  range?: { start: number; end: number };
  /** Short human-readable description for the receipt. */
  describe: string;
}

interface InlineMarker {
  prompt: string;
  start: number;
  end: number;
}

/** Find every `@human` marker in a source text with its exact character range. */
export function extractInlineMarkers(text: string): InlineMarker[] {
  const markers: InlineMarker[] = [];
  const patterns: RegExp[] = [
    /\/\*\s*@human\b[ \t]*([\s\S]*?)\*\//g, // /* @human ... */
    /"""\s*@human\b[ \t]*([\s\S]*?)"""/g, //   """ @human ... """
    /(?:\/\/|#)\s*@human\b[ \t]*([^\n\r]*)/g, // // @human ...  or  # @human ...
  ];
  const claimed: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some((range) => start < range.end && end > range.start);
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      const prompt = (match[1] ?? "").trim();
      if (prompt.length === 0) continue;
      claimed.push({ start, end });
      markers.push({ prompt, start, end });
    }
  }
  return markers.sort((left, right) => left.start - right.start);
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
      if (entry.name.startsWith(".") && entry.name !== ".human-to-code") {
        if (entry.isDirectory()) continue;
      }
      if (ignores.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  await visit(root, 0);
  return results.sort();
}

/**
 * Discover all conversion units under `root`: whole `.human` files plus inline
 * `@human` markers in recognized source files. Deterministic and bounded.
 */
export async function discoverUnits(root: string, language: string): Promise<ConversionUnit[]> {
  const absoluteRoot = resolve(root);
  const ignores = new Set([...DEFAULT_IGNORES]);
  const profile = languageProfile(language);
  const files = await walk(absoluteRoot, ignores);
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
    if (SCANNED_EXTENSIONS.has(extname(absolute).toLowerCase())) {
      let content: string;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      if (!content.includes("@human")) continue;
      for (const marker of extractInlineMarkers(content)) {
        units.push({
          kind: "inline",
          sourcePath: rel,
          absoluteSource: absolute,
          prompt: marker.prompt,
          range: { start: marker.start, end: marker.end },
          describe: `${rel}  (inline @human)  ->  ${rel}`,
        });
      }
    }
  }
  return units;
}

/** Render the invoice/receipt shown before any code is written. */
export function renderReceipt(
  units: readonly ConversionUnit[],
  provider: string,
  model: string,
  language: string,
): string {
  const profile = languageProfile(language);
  const lines: string[] = [];
  lines.push("human-to-code — conversion receipt");
  lines.push("");
  lines.push(`  Language : ${profile.label} (.${profile.ext})`);
  lines.push(`  Provider : ${provider}`);
  lines.push(`  Model    : ${model}`);
  lines.push(`  Requests : ${units.length} (one model request per prompt)`);
  lines.push("");
  if (units.length === 0) {
    lines.push("  No .human files or @human markers were found.");
  } else {
    lines.push("  The following will be generated:");
    for (const unit of units) lines.push(`    • ${unit.describe}`);
  }
  return lines.join("\n");
}

/** Remove a single fenced code block wrapper if the model added one. */
export function stripCodeFence(output: string): string {
  const trimmed = output.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  if (fenced) return fenced[1]!.trim();
  return trimmed;
}

export interface GenerateOptions {
  language: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * Generate raw code for one prompt. Talks to a local Ollama `/api/chat`
 * endpoint by default; an OpenAI-compatible chat endpoint is used when the
 * configured provider is `openai`.
 */
export async function generateCode(prompt: string, options: GenerateOptions): Promise<string> {
  const profile = languageProfile(options.language);
  const system = [
    `You are a precise ${profile.label} code generator.`,
    `Convert the user's instruction into correct, self-contained ${profile.label} code.`,
    "Output ONLY code. No explanations, no comments describing what you did, no markdown fences.",
  ].join(" ");

  if (options.provider === "openai") {
    const base = options.baseUrl ?? "https://api.openai.com/v1";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0,
      }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return stripCodeFence(data.choices?.[0]?.message?.content ?? "");
  }

  const base = options.baseUrl ?? "http://localhost:11434";
  const response = await fetch(`${base.replace(/\/api\/?$/u, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return stripCodeFence(data.message?.content ?? "");
}

export interface AppliedUnit {
  unit: ConversionUnit;
  writtenPath: string;
}

/** Write generated code for one unit and return the path that changed. */
export async function applyUnit(root: string, unit: ConversionUnit, code: string): Promise<string> {
  const absoluteRoot = resolve(root);
  if (unit.kind === "file") {
    const target = resolve(absoluteRoot, unit.outputPath!);
    if (!target.startsWith(absoluteRoot + sep)) throw new Error(`Refusing to write outside the project root: ${unit.outputPath}`);
    await writeFile(target, code.endsWith("\n") ? code : `${code}\n`);
    return unit.outputPath!;
  }
  // Inline: replace the exact marker range with the generated code.
  const original = await readFile(unit.absoluteSource, "utf8");
  const { start, end } = unit.range!;
  const replaced = `${original.slice(0, start)}${code.trim()}${original.slice(end)}`;
  await writeFile(unit.absoluteSource, replaced);
  return unit.sourcePath;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export { dirname };
