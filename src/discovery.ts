/**
 * Fail-closed, deterministic discovery of `.human` inputs.
 *
 * The scanner never imports project code, follows symlinks, or silently turns
 * an unreadable/partial scan into an empty successful result. Security files
 * are enumerated even below configured or git ignore boundaries.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILENAME } from "./config.ts";
import type { DiscoveryResult, SourceFile, SourceKind } from "./types.ts";

const SECRETS_FILENAME = "secrets.human";
const HUMAN_CONFIG_FILENAME = "config.human";
const STRICT_SUFFIX = ".strict.human";
const HUMAN_SUFFIX = ".human";
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Names skipped for normal source discovery regardless of configuration. */
const ALWAYS_IGNORE = new Set([".git", "node_modules", CONFIG_FILENAME]);

export type DiscoveryErrorCode =
  | "ROOT_NOT_FOUND"
  | "ROOT_NOT_DIRECTORY"
  | "ROOT_SYMLINK"
  | "ROOT_UNREADABLE"
  | "PARTIAL_SCAN"
  | "GIT_UNAVAILABLE"
  | "GIT_ERROR"
  | "SOURCE_UNREADABLE";

/** A non-success result for any scan whose completeness cannot be guaranteed. */
export class DiscoveryError extends Error {
  override readonly name = "DiscoveryError";
  readonly code: DiscoveryErrorCode;

  constructor(
    message: string,
    code: DiscoveryErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/** Backwards-compatible result plus the complete security-file enumeration. */
export interface SecureDiscoveryResult extends DiscoveryResult {
  /** Every `secrets.human` below the root, including ignored locations. */
  secretsFiles: SourceFile[];
}

interface GitRepository {
  topLevel: string;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function comparePaths(left: SourceFile, right: SourceFile): number {
  return left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0;
}

function classify(name: string): SourceKind | null {
  if (name === SECRETS_FILENAME) return "secrets";
  if (name === HUMAN_CONFIG_FILENAME) return "config";
  if (name.endsWith(STRICT_SUFFIX)) return "strict";
  if (name.endsWith(HUMAN_SUFFIX)) return "human";
  return null;
}

function strictSiblingOf(relPath: string): string {
  return relPath.slice(0, -HUMAN_SUFFIX.length) + STRICT_SUFFIX;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function validateRoot(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DiscoveryError(`Discovery root does not exist: ${root}`, "ROOT_NOT_FOUND", {
        cause: error,
      });
    }
    throw new DiscoveryError(`Could not inspect discovery root ${root}: ${safeError(error)}`, "ROOT_UNREADABLE", {
      cause: error,
    });
  }

  if (metadata.isSymbolicLink()) {
    throw new DiscoveryError(`Discovery root must not be a symlink: ${root}`, "ROOT_SYMLINK");
  }
  if (!metadata.isDirectory()) {
    throw new DiscoveryError(`Discovery root is not a directory: ${root}`, "ROOT_NOT_DIRECTORY");
  }
  try {
    await access(root, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error) {
    throw new DiscoveryError(`Discovery root is not readable: ${root}`, "ROOT_UNREADABLE", {
      cause: error,
    });
  }
}

/**
 * Walk a tree. `securityOnly` is used below ignored directories: ordinary
 * inputs remain ignored, but nested `secrets.human` files cannot disappear.
 * `.git` internals are the one deliberate exception because they are repository
 * storage, not project content; tracked paths are checked independently by Git.
 */
async function walk(
  root: string,
  directory: string,
  ignore: ReadonlySet<string>,
  found: SourceFile[],
  counters: { ignored: number },
  securityOnly = false,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new DiscoveryError(
      `Discovery was incomplete because ${directory} could not be read: ${safeError(error)}`,
      "PARTIAL_SCAN",
      { cause: error },
    );
  }

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (!isWithin(root, absolutePath)) {
      throw new DiscoveryError(
        `Discovery entry escaped the root: ${absolutePath}`,
        "PARTIAL_SCAN",
      );
    }

    if (entry.isSymbolicLink()) {
      counters.ignored++;
      continue;
    }

    const ignoredByName = ignore.has(entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        counters.ignored++;
        continue;
      }
      if (ignoredByName) counters.ignored++;
      await walk(
        root,
        absolutePath,
        ignore,
        found,
        counters,
        securityOnly || ignoredByName,
      );
      continue;
    }

    if (ignoredByName) counters.ignored++;
    if (!entry.isFile()) continue;

    const kind = classify(entry.name);
    if (kind === null) continue;
    // A security file is always surfaced, even if its own basename was ignored.
    if ((securityOnly || ignoredByName) && kind !== "secrets") continue;

    const relPath = toPosix(relative(root, absolutePath));
    const source: SourceFile = { absPath: absolutePath, relPath, kind };
    if (kind === "human") source.strictSibling = strictSiblingOf(relPath);
    found.push(source);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function runGit(root: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync("git", ["--no-optional-locks", "-C", root, ...args], {
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
}

function hasGitMarker(start: string): boolean {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function gitFailure(result: SpawnSyncReturns<string>): string {
  if (result.error) return result.error.message;
  const stderr = result.stderr.trim();
  return stderr === "" ? `git exited with status ${String(result.status)}` : stderr;
}

/** Return repository metadata, null for a genuine non-Git directory. */
function gitRepository(root: string): GitRepository | null {
  const result = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (result.error) {
    if (!hasGitMarker(root) && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new DiscoveryError(`Git is unavailable: ${gitFailure(result)}`, "GIT_UNAVAILABLE", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    if (!hasGitMarker(root) && /not a git repository/i.test(result.stderr)) return null;
    throw new DiscoveryError(
      `Could not determine Git repository state: ${gitFailure(result)}`,
      "GIT_ERROR",
    );
  }

  const topLevel = result.stdout.trim();
  if (topLevel === "") {
    throw new DiscoveryError("Git returned an empty repository root.", "GIT_ERROR");
  }
  return { topLevel: resolve(topLevel) };
}

/** Return paths ignored by Git; command errors abort discovery. */
function gitIgnored(root: string, relPaths: readonly string[]): Set<string> {
  if (gitRepository(root) === null || relPaths.length === 0) return new Set();

  const result = runGit(
    root,
    ["check-ignore", "-z", "--stdin"],
    `${relPaths.join("\0")}\0`,
  );
  // check-ignore uses 0 when it found matches and 1 when none matched.
  if (result.status !== 0 && result.status !== 1) {
    throw new DiscoveryError(
      `Git ignore evaluation failed: ${gitFailure(result)}`,
      result.error ? "GIT_UNAVAILABLE" : "GIT_ERROR",
      result.error ? { cause: result.error } : undefined,
    );
  }
  return new Set(result.stdout.split("\0").filter((path) => path !== ""));
}

/**
 * Discover and classify all source files. Missing/unreadable roots, unreadable
 * descendants, and Git failures reject instead of returning partial output.
 */
export async function discover(
  rootInput: string,
  extraIgnore: string[] = [],
): Promise<SecureDiscoveryResult> {
  const root = resolve(rootInput);
  await validateRoot(root);

  const ignore = new Set<string>([...ALWAYS_IGNORE, ...extraIgnore]);
  const found: SourceFile[] = [];
  const counters = { ignored: 0 };
  await walk(root, root, ignore, found, counters);
  found.sort(comparePaths);

  const normalSources = found.filter(
    (source) => source.kind !== "secrets" && source.kind !== "config",
  );
  const ignoredByGit = gitIgnored(
    root,
    normalSources.map(({ relPath }) => relPath),
  );
  const kept = normalSources.filter((source) => {
    if (!ignoredByGit.has(source.relPath)) return true;
    counters.ignored++;
    return false;
  });
  const secretsFiles = found.filter((source) => source.kind === "secrets");

  const result: SecureDiscoveryResult = {
    root,
    human: kept.filter((source) => source.kind === "human"),
    strict: kept.filter((source) => source.kind === "strict"),
    secretsFiles,
    ignoredCount: counters.ignored,
  };
  // Deprecated compatibility field. Callers should iterate secretsFiles.
  if (secretsFiles[0] !== undefined) result.secrets = secretsFiles[0];
  return result;
}

function discoveryRootFor(source: SourceFile): string {
  const segments = source.relPath.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || source.relPath.startsWith("/") || segments.includes("..")) {
    throw new DiscoveryError("Invalid relative path on discovered source.", "PARTIAL_SCAN");
  }
  let root = resolve(source.absPath);
  for (let index = 0; index < segments.length; index++) root = dirname(root);
  if (resolve(root, ...segments) !== resolve(source.absPath)) {
    throw new DiscoveryError("Discovered source path is inconsistent with its root.", "PARTIAL_SCAN");
  }
  return root;
}

/**
 * Refuse when any nested `secrets.human` under the same discovery root is Git
 * tracked. This intentionally checks Git's index rather than only the supplied
 * file, preserving safety for legacy callers that pass `result.secrets`.
 */
export function secretsTrackedError(
  secretOrSecrets: SourceFile | readonly SourceFile[],
): string | null {
  const supplied = Array.isArray(secretOrSecrets)
    ? secretOrSecrets
    : [secretOrSecrets as SourceFile];
  if (supplied.length === 0) return null;
  if (supplied.some((source) => source.kind !== "secrets")) return null;

  const root = discoveryRootFor(supplied[0]!);
  for (const source of supplied) {
    if (discoveryRootFor(source) !== root) {
      throw new DiscoveryError(
        "Cannot check secrets from different discovery roots together.",
        "PARTIAL_SCAN",
      );
    }
  }
  if (gitRepository(root) === null) return null;

  const result = runGit(root, [
    "ls-files",
    "-z",
    "--",
    SECRETS_FILENAME,
    `:(glob)**/${SECRETS_FILENAME}`,
  ]);
  if (result.error || result.status !== 0) {
    throw new DiscoveryError(
      `Could not verify whether secrets are tracked: ${gitFailure(result)}`,
      result.error ? "GIT_UNAVAILABLE" : "GIT_ERROR",
      result.error ? { cause: result.error } : undefined,
    );
  }
  const tracked = result.stdout
    .split("\0")
    .filter((path) => path !== "" && basename(path) === SECRETS_FILENAME)
    .sort();
  if (tracked.length === 0) return null;

  const display = tracked.map((path) => JSON.stringify(path)).join(", ");
  return (
    `Refusing to run: Git tracks ${display}. ` +
    "Remove each file from the index and add it to .gitignore. " +
    "Use provider-specific environment variables or an OS keychain for credentials."
  );
}

/** SHA-256 content hash used to bind contracts to exact source bytes. */
export async function sourceContentHash(source: SourceFile | string): Promise<string> {
  const path = typeof source === "string" ? source : source.absPath;
  let metadata;
  try {
    metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("source is not a regular, non-symlink file");
    }
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    throw new DiscoveryError(
      `Could not hash source ${path}: ${safeError(error)}`,
      "SOURCE_UNREADABLE",
      { cause: error },
    );
  }
}
