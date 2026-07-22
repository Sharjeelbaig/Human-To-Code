/**
 * Constrained patch validation and atomic application.
 *
 * Model output is never applied as a shell patch. Every operation is checked
 * against the repository root, its exact base hash, and an explicit scope.
 */

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { PatchOperation, PatchSetV1 } from "../../core/contracts.ts";
import { hashCanonical, sha256Text, validatePatchSetV1 } from "../../core/contracts.ts";

const DEFAULT_MAX_OPERATIONS = 200;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const HARD_PROTECTED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "secrets.human",
  "human-to-code.config.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "service-account.json",
  "kubeconfig",
]);

const HARD_PROTECTED_PREFIXES = [".human-to-code/"];

export interface PatchPolicy {
  /** POSIX relative paths or directory prefixes ending in `/`. */
  allowedPaths?: string[];
  /** Additional protected paths or directory prefixes ending in `/`. */
  protectedPaths?: string[];
  maxOperations?: number;
  maxChangedBytes?: number;
  allowDeletes?: boolean;
  allowRenames?: boolean;
  /** Full content-addressed snapshot bound into the generation request. */
  expectedSnapshotHash?: string;
}

export interface PreparedPatch {
  root: string;
  patch: PatchSetV1;
  operations: PreparedOperation[];
  changedBytes: number;
}

export type PreparedOperation =
  | { kind: "create"; path: string; absPath: string; content: string; mode: number }
  | {
      kind: "edit";
      path: string;
      absPath: string;
      before: string;
      after: string;
      mode: number;
    }
  | { kind: "delete"; path: string; absPath: string; before: string; mode: number }
  | {
      kind: "rename";
      from: string;
      absFrom: string;
      path: string;
      absPath: string;
      before: string;
      mode: number;
    };

export class PatchSafetyError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "PatchSafetyError";
    this.code = code;
    this.details = details;
  }
}

export interface ApplyResult {
  applied: string[];
  patchHash: string;
}

function toPosix(value: string): string {
  return value.split(/[\\/]/).join("/");
}

export function normalizePatchPath(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PatchSafetyError("INVALID_PATH", "Patch paths must be non-empty strings.");
  }
  if (value.includes("\0") || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new PatchSafetyError("PATH_ESCAPE", `Unsafe patch path: ${JSON.stringify(value)}.`);
  }
  const normalized = posix.normalize(toPosix(value));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("/")
  ) {
    throw new PatchSafetyError("PATH_ESCAPE", `Patch path escapes the root: ${value}.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PatchSafetyError("INVALID_PATH", `Patch path is not canonical: ${value}.`);
  }
  return normalized;
}

function isPrefixMatch(path: string, rule: string): boolean {
  const normalizedRule = normalizePatchPath(rule.endsWith("/") ? rule.slice(0, -1) : rule);
  if (normalizedRule.includes("*")) {
    const escaped = normalizedRule.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    const expression = escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
    return new RegExp(`^${expression}(?:/.*)?$`, "u").test(path);
  }
  return path === normalizedRule || path.startsWith(`${normalizedRule}/`);
}

function assertAllowedPath(path: string, policy: PatchPolicy): void {
  const parts = path.split("/");
  const sensitiveName = (part: string): boolean => {
    const lower = part.toLowerCase();
    return HARD_PROTECTED_NAMES.has(lower)
      || /^\.env(?:\..*)?$/iu.test(part)
      || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/iu.test(part)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/iu.test(part)
      || /^(?:credentials?|secrets?)(?:\..*)?$/iu.test(part);
  };
  const cargoCredential = parts.some((part, index) => part.toLowerCase() === ".cargo" && /^credentials(?:\.toml)?$/iu.test(parts[index + 1] ?? ""));
  const dockerCredential = parts.some((part, index) => part.toLowerCase() === ".docker" && (parts[index + 1] ?? "").toLowerCase() === "config.json");
  if (parts.some(sensitiveName) || cargoCredential || dockerCredential) {
    throw new PatchSafetyError("PROTECTED_PATH", `Patch targets protected path: ${path}.`);
  }
  if (HARD_PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new PatchSafetyError("PROTECTED_PATH", `Patch targets protected path: ${path}.`);
  }
  if ((policy.protectedPaths ?? []).some((rule) => isPrefixMatch(path, rule))) {
    throw new PatchSafetyError("PROTECTED_PATH", `Patch targets configured protected path: ${path}.`);
  }
  const allowed = policy.allowedPaths;
  if (allowed && allowed.length > 0 && !allowed.some((rule) => isPrefixMatch(path, rule))) {
    throw new PatchSafetyError("OUT_OF_SCOPE", `Patch path is outside the contract scope: ${path}.`);
  }
}

function resolveInside(root: string, path: string): string {
  const abs = resolve(root, ...path.split("/"));
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PatchSafetyError("PATH_ESCAPE", `Resolved path escapes the root: ${path}.`);
  }
  return abs;
}

async function assertSafeParents(root: string, absPath: string): Promise<void> {
  let cursor = dirname(absPath);
  const rootResolved = resolve(root);
  while (cursor !== rootResolved) {
    const rel = relative(rootResolved, cursor);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new PatchSafetyError("PATH_ESCAPE", `Parent directory escapes root: ${absPath}.`);
    }
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new PatchSafetyError("SYMLINK_ESCAPE", `Patch parent is a symlink: ${toPosix(rel)}.`);
      }
      if (!info.isDirectory()) {
        throw new PatchSafetyError("INVALID_PATH", `Patch parent is not a directory: ${toPosix(rel)}.`);
      }
    } catch (error) {
      if (error instanceof PatchSafetyError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
}

async function readSafeRegularFile(absPath: string, path: string): Promise<{ text: string; mode: number }> {
  let info;
  try {
    info = await lstat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PatchSafetyError("MISSING_BASE", `Patch base file does not exist: ${path}.`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new PatchSafetyError("SYMLINK_ESCAPE", `Patch target is a symlink: ${path}.`);
  }
  if (!info.isFile()) {
    throw new PatchSafetyError("INVALID_TARGET", `Patch target is not a regular file: ${path}.`);
  }
  if (info.nlink > 1) {
    throw new PatchSafetyError("HARDLINK_ESCAPE", `Patch target has multiple hard links: ${path}.`);
  }
  const bytes = await readFile(absPath);
  if (bytes.includes(0)) {
    throw new PatchSafetyError("BINARY_TARGET", `Patch target appears binary: ${path}.`);
  }
  return { text: bytes.toString("utf8"), mode: info.mode & 0o777 };
}

function assertBaseHash(path: string, text: string, expected: string): void {
  const actual = sha256Text(text);
  if (actual !== expected) {
    throw new PatchSafetyError(
      "STALE_BASE",
      `Patch base hash does not match ${path}.`,
      [`expected=${expected}`, `actual=${actual}`],
    );
  }
}

function uniqueOccurrence(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  const first = haystack.indexOf(needle);
  if (first < 0) return -1;
  return haystack.indexOf(needle, first + 1) < 0 ? first : -2;
}

export function computePatchSnapshotHash(operations: readonly PatchOperation[]): string {
  const bases = operations
    .map((operation) => {
      if (operation.kind === "create") return { path: normalizePatchPath(operation.path), hash: null };
      if (operation.kind === "rename") {
        return {
          path: normalizePatchPath(operation.from),
          destination: normalizePatchPath(operation.path),
          hash: operation.baseHash,
        };
      }
      return { path: normalizePatchPath(operation.path), hash: operation.baseHash };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return hashCanonical(bases);
}

/**
 * Rejects a model-proposed patch unless every operation stays inside reviewed
 * scope and still matches the exact snapshot it was generated against.
 */
export async function preparePatch(
  rootInput: string,
  patch: PatchSetV1,
  policy: PatchPolicy = {},
): Promise<PreparedPatch> {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    throw new PatchSafetyError("INVALID_ROOT", `Cannot inspect patch root: ${String(error)}.`);
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PatchSafetyError("INVALID_ROOT", "Patch root must be a real directory.");
  }
  if (patch.schemaVersion !== 1 || !Array.isArray(patch.operations)) {
    throw new PatchSafetyError("INVALID_PATCH", "PatchSetV1 schema is invalid.");
  }
  try {
    validatePatchSetV1(patch);
  } catch (error) {
    throw new PatchSafetyError("INVALID_PATCH", error instanceof Error ? error.message : String(error));
  }
  const maxOperations = policy.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  if (patch.operations.length === 0 || patch.operations.length > maxOperations) {
    throw new PatchSafetyError(
      "PATCH_SIZE",
      `Patch must contain between 1 and ${maxOperations} operations.`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(patch.snapshotHash)) {
    throw new PatchSafetyError("INVALID_SNAPSHOT", "Patch snapshot hash is not a SHA-256 digest.");
  }
  if (policy.expectedSnapshotHash !== undefined && patch.snapshotHash !== policy.expectedSnapshotHash) {
    throw new PatchSafetyError("INVALID_SNAPSHOT", "Patch is bound to a different workspace snapshot.");
  }

  const normalizedKeys = new Set<string>();
  const claimedPaths = new Set<string>();
  for (const operation of patch.operations) {
    const paths = operation.kind === "rename" ? [operation.from, operation.path] : [operation.path];
    for (const rawPath of paths) {
      const path = normalizePatchPath(rawPath);
      assertAllowedPath(path, policy);
      const key = path.toLocaleLowerCase("en-US");
      if (normalizedKeys.has(key) || claimedPaths.has(path)) {
        throw new PatchSafetyError("PATH_COLLISION", `Patch contains a duplicate or case-colliding path: ${path}.`);
      }
      normalizedKeys.add(key);
      claimedPaths.add(path);
    }
  }

  const prepared: PreparedOperation[] = [];
  let changedBytes = 0;
  for (const operation of patch.operations) {
    const path = normalizePatchPath(operation.path);
    const absPath = resolveInside(root, path);
    await assertSafeParents(root, absPath);

    if (operation.kind === "create") {
      try {
        await lstat(absPath);
        throw new PatchSafetyError("TARGET_EXISTS", `Create target already exists: ${path}.`);
      } catch (error) {
        if (error instanceof PatchSafetyError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const mode = 0o644;
      changedBytes += Buffer.byteLength(operation.content);
      prepared.push({ kind: "create", path, absPath, content: operation.content, mode });
      continue;
    }

    if (operation.kind === "edit") {
      const current = await readSafeRegularFile(absPath, path);
      assertBaseHash(path, current.text, operation.baseHash);
      const index = uniqueOccurrence(current.text, operation.oldText);
      if (index === -1) {
        throw new PatchSafetyError("EDIT_MISMATCH", `Edit source text was not found in ${path}.`);
      }
      if (index === -2) {
        throw new PatchSafetyError("EDIT_AMBIGUOUS", `Edit source text is not unique in ${path}.`);
      }
      const after =
        current.text.slice(0, index) +
        operation.newText +
        current.text.slice(index + operation.oldText.length);
      changedBytes += Buffer.byteLength(operation.newText) + Buffer.byteLength(operation.oldText);
      prepared.push({ kind: "edit", path, absPath, before: current.text, after, mode: current.mode });
      continue;
    }

    if (operation.kind === "delete") {
      if (!policy.allowDeletes) {
        throw new PatchSafetyError("DELETE_NOT_ALLOWED", `Delete was not authorized: ${path}.`);
      }
      const current = await readSafeRegularFile(absPath, path);
      assertBaseHash(path, current.text, operation.baseHash);
      changedBytes += Buffer.byteLength(current.text);
      prepared.push({ kind: "delete", path, absPath, before: current.text, mode: current.mode });
      continue;
    }

    if (!policy.allowRenames) {
      throw new PatchSafetyError("RENAME_NOT_ALLOWED", `Rename was not authorized: ${operation.from}.`);
    }
    const from = normalizePatchPath(operation.from);
    const absFrom = resolveInside(root, from);
    await assertSafeParents(root, absFrom);
    const current = await readSafeRegularFile(absFrom, from);
    assertBaseHash(from, current.text, operation.baseHash);
    try {
      await lstat(absPath);
      throw new PatchSafetyError("TARGET_EXISTS", `Rename destination already exists: ${path}.`);
    } catch (error) {
      if (error instanceof PatchSafetyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    changedBytes += Buffer.byteLength(current.text);
    prepared.push({ kind: "rename", from, absFrom, path, absPath, before: current.text, mode: current.mode });
  }

  const maxChangedBytes = policy.maxChangedBytes ?? DEFAULT_MAX_BYTES;
  if (changedBytes > maxChangedBytes) {
    throw new PatchSafetyError(
      "PATCH_SIZE",
      `Patch changes ${changedBytes} bytes, exceeding the ${maxChangedBytes}-byte limit.`,
    );
  }
  return { root, patch, operations: prepared, changedBytes };
}

async function writeAtomic(absPath: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const temporary = join(dirname(absPath), `.${basename(absPath)}.h2c-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, absPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Writes a host-validated structured patch to the working tree. If something
 * fails, touched paths are restored before the error is rethrown. Atomicity is
 * per file — don't describe this as a filesystem-wide transaction, because it
 * isn't one.
 */
export async function applyPatchAtomic(
  root: string,
  patch: PatchSetV1,
  policy: PatchPolicy = {},
): Promise<ApplyResult> {
  const prepared = await preparePatch(root, patch, policy);
  const backupRoot = await mkdtemp(join(tmpdir(), "human-to-code-rollback-"));
  const applied: string[] = [];
  const appliedIndexes: number[] = [];

  try {
    for (let index = 0; index < prepared.operations.length; index++) {
      const operation = prepared.operations[index]!;
      const backup = join(backupRoot, String(index));
      if (operation.kind === "create") {
        await writeAtomic(operation.absPath, operation.content, operation.mode);
        applied.push(operation.path);
        appliedIndexes.push(index);
      } else if (operation.kind === "edit") {
        await copyFile(operation.absPath, backup, fsConstants.COPYFILE_EXCL);
        await writeAtomic(operation.absPath, operation.after, operation.mode);
        applied.push(operation.path);
        appliedIndexes.push(index);
      } else if (operation.kind === "delete") {
        await copyFile(operation.absPath, backup, fsConstants.COPYFILE_EXCL);
        await unlink(operation.absPath);
        applied.push(operation.path);
        appliedIndexes.push(index);
      } else {
        await copyFile(operation.absFrom, backup, fsConstants.COPYFILE_EXCL);
        await mkdir(dirname(operation.absPath), { recursive: true });
        await rename(operation.absFrom, operation.absPath);
        applied.push(`${operation.from} -> ${operation.path}`);
        appliedIndexes.push(index);
      }
    }
  } catch (error) {
    for (const index of appliedIndexes.reverse()) {
      const operation = prepared.operations[index]!;
      const backup = join(backupRoot, String(index));
      try {
        if (operation.kind === "create") {
          await rm(operation.absPath, { force: true });
        } else if (operation.kind === "edit" || operation.kind === "delete") {
          await copyFile(backup, operation.absPath);
          await chmod(operation.absPath, operation.mode);
        } else {
          await rm(operation.absPath, { force: true });
          await copyFile(backup, operation.absFrom);
          await chmod(operation.absFrom, operation.mode);
        }
      } catch {
        // Preserve the original failure. Rollback failures are surfaced in the
        // error message instead of risking a second exception hiding it.
      }
    }
    throw new PatchSafetyError("APPLY_FAILED", `Patch application failed and was rolled back: ${String(error)}.`);
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }

  return { applied, patchHash: hashCanonical(patch) };
}
