/**
 * File discovery for the deterministic core.
 *
 * Responsibilities (plan §3.3–3.4):
 *  - Walk the project, classifying .human / .strict.human / config / secrets.
 *  - Apply a name-based ignore denylist + best-effort .gitignore.
 *  - Never follow symlinks (traversal safety).
 *  - Provide a git-tracked-secrets check so the CLI can refuse to run.
 *
 * Discovery is side-effect free; the CLI decides what to do with the result.
 */

import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { CONFIG_FILENAME } from "./config.ts";
import type { DiscoveryResult, SourceFile, SourceKind } from "./types.ts";

const SECRETS_FILENAME = "secrets.human";
const HUMAN_CONFIG_FILENAME = "config.human";
const STRICT_SUFFIX = ".strict.human";
const HUMAN_SUFFIX = ".human";

/** Names always skipped regardless of config. */
const ALWAYS_IGNORE = new Set([".git", "node_modules", CONFIG_FILENAME]);

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function classify(basename: string): SourceKind | null {
  if (basename === SECRETS_FILENAME) return "secrets";
  if (basename === HUMAN_CONFIG_FILENAME) return "config";
  if (basename.endsWith(STRICT_SUFFIX)) return "strict";
  // A plain .human file that is not one of the special files above.
  if (basename.endsWith(HUMAN_SUFFIX)) return "human";
  return null;
}

function strictSiblingOf(relPath: string): string {
  // foo.human -> foo.strict.human
  return relPath.slice(0, -HUMAN_SUFFIX.length) + STRICT_SUFFIX;
}

/**
 * Recursively collect candidate files. Directories/files whose basename is in
 * `ignore` are skipped. Symlinks are never followed.
 */
async function walk(
  root: string,
  dir: string,
  ignore: Set<string>,
  out: SourceFile[],
  counters: { ignored: number },
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = resolve(dir, entry.name);

    if (entry.isSymbolicLink()) {
      counters.ignored++;
      continue; // traversal safety — never follow symlinks
    }

    if (ignore.has(entry.name)) {
      counters.ignored++;
      continue;
    }

    if (entry.isDirectory()) {
      await walk(root, abs, ignore, out, counters);
      continue;
    }

    if (!entry.isFile()) continue;

    const kind = classify(entry.name);
    if (kind === null) {
      // Not a file we track; not counted as "ignored" for reporting.
      continue;
    }

    const relPath = toPosix(relative(root, abs));
    const file: SourceFile = { absPath: abs, relPath, kind };
    if (kind === "human") {
      file.strictSibling = strictSiblingOf(relPath);
    }
    out.push(file);
  }
}

/** Return the subset of relPaths that git considers ignored (best effort). */
function gitIgnored(root: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0) return new Set();
  const inRepo = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") return new Set();

  const res = spawnSync("git", ["-C", root, "check-ignore", "--stdin"], {
    input: relPaths.join("\n"),
    encoding: "utf8",
  });
  // Exit 0 => some ignored, 1 => none ignored, other => error (treat as none).
  if (res.status !== 0 && res.status !== 1) return new Set();
  return new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Discover and classify all source files under `rootInput`.
 *
 * @param rootInput  directory to scan
 * @param extraIgnore  config.filesToIgnore (name-based denylist)
 */
export async function discover(
  rootInput: string,
  extraIgnore: string[] = [],
): Promise<DiscoveryResult> {
  const root = resolve(rootInput);
  const ignore = new Set<string>([...ALWAYS_IGNORE, ...extraIgnore]);

  const found: SourceFile[] = [];
  const counters = { ignored: 0 };
  await walk(root, root, ignore, found, counters);

  // Best-effort .gitignore filtering on top of the name denylist.
  const ignored = gitIgnored(
    root,
    found.map((f) => f.relPath),
  );
  const kept = found.filter((f) => {
    // Secrets are always surfaced (so we can enforce safety), even if ignored.
    if (f.kind === "secrets") return true;
    if (ignored.has(f.relPath)) {
      counters.ignored++;
      return false;
    }
    return true;
  });

  const result: DiscoveryResult = {
    root,
    human: kept.filter((f) => f.kind === "human"),
    strict: kept.filter((f) => f.kind === "strict"),
    ignoredCount: counters.ignored,
  };
  const secrets = kept.find((f) => f.kind === "secrets");
  if (secrets) result.secrets = secrets;
  return result;
}

/**
 * Refuse to run if `secrets.human` is tracked by git — a committed secrets file
 * is the mistake we most want to prevent (plan §3.3). No-op outside a git repo.
 * @returns an error message if unsafe, otherwise null.
 */
export function secretsTrackedError(secret: SourceFile): string | null {
  if (secret.kind !== "secrets") return null;
  const root = resolve(secret.absPath, "..");
  const res = spawnSync(
    "git",
    ["-C", root, "ls-files", "--error-unmatch", secret.relPath],
    { encoding: "utf8" },
  );
  if (res.status === 0) {
    return (
      `Refusing to run: ${secret.relPath} is tracked by git. ` +
      `Remove it with \`git rm --cached ${secret.relPath}\` and add it to .gitignore. ` +
      `Prefer environment variables or your OS keychain for provider credentials.`
    );
  }
  return null;
}
