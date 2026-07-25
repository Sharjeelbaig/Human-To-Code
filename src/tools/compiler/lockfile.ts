/** Secure validation and atomic persistence for `human-to-code.lock.json`. */
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const COMPILER_LOCK_FILENAME = "human-to-code.lock.json";
export const COMPILER_LOCK_SCHEMA_VERSION = 1 as const;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_UNITS = 10_000;
const HASH = /^[a-f0-9]{64}$/u;

export interface CompilerLockEntryV1 {
  compileKey: string;
  outputHash: string;
  targetPath: string;
}

export interface CompilerLockfileV1 {
  schemaVersion: typeof COMPILER_LOCK_SCHEMA_VERSION;
  units: Record<string, CompilerLockEntryV1>;
}

export class CompilerLockError extends Error {
  override readonly name = "CompilerLockError";
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new CompilerLockError(`Unknown lockfile field \`${path}${key}\`.`);
    }
  }
}

function object(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompilerLockError(`\`${path}\` must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function validateCompilerLockfile(raw: unknown): CompilerLockfileV1 {
  const root = object(raw, "");
  exactKeys(root, ["schemaVersion", "units"], "");
  if (root.schemaVersion !== COMPILER_LOCK_SCHEMA_VERSION) {
    throw new CompilerLockError("Unsupported compiler lockfile schema version.");
  }
  const units = object(root.units, "units");
  const entries = Object.entries(units);
  if (entries.length > MAX_LOCK_UNITS) {
    throw new CompilerLockError(
      `Compiler lockfile contains more than ${MAX_LOCK_UNITS} units.`,
    );
  }
  const validated: Record<string, CompilerLockEntryV1> = {};
  for (const [id, rawEntry] of entries) {
    if (!HASH.test(id)) {
      throw new CompilerLockError(`Invalid compiler unit id ${JSON.stringify(id)}.`);
    }
    const entry = object(rawEntry, `units.${id}`);
    exactKeys(entry, ["compileKey", "outputHash", "targetPath"], `units.${id}.`);
    if (
      typeof entry.compileKey !== "string"
      || !HASH.test(entry.compileKey)
      || typeof entry.outputHash !== "string"
      || !HASH.test(entry.outputHash)
      || typeof entry.targetPath !== "string"
      || entry.targetPath.length === 0
      || entry.targetPath.length > 1_024
      || entry.targetPath.includes("\0")
      || entry.targetPath.startsWith("/")
      || entry.targetPath.includes("\\")
      || entry.targetPath.split(/[\\/]/u).includes("..")
    ) {
      throw new CompilerLockError(`Invalid compiler lock entry \`units.${id}\`.`);
    }
    validated[id] = {
      compileKey: entry.compileKey,
      outputHash: entry.outputHash,
      targetPath: entry.targetPath,
    };
  }
  return { schemaVersion: 1, units: validated };
}

/** Strict secure reader used by tests and callers that need diagnostics. */
export async function loadCompilerLockfile(
  root: string,
): Promise<CompilerLockfileV1 | undefined> {
  const path = join(root, COMPILER_LOCK_FILENAME);
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new CompilerLockError(`Could not inspect ${COMPILER_LOCK_FILENAME}.`);
  });
  if (before === undefined) return undefined;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size > MAX_LOCK_BYTES
  ) {
    throw new CompilerLockError(
      `${COMPILER_LOCK_FILENAME} must be a regular non-symlink file under ${MAX_LOCK_BYTES} bytes.`,
    );
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size > MAX_LOCK_BYTES
    ) {
      throw new CompilerLockError(
        `${COMPILER_LOCK_FILENAME} changed while it was being opened.`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_LOCK_BYTES) {
      throw new CompilerLockError(
        `${COMPILER_LOCK_FILENAME} exceeds the size limit.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new CompilerLockError(`${COMPILER_LOCK_FILENAME} is invalid JSON.`);
    }
    return validateCompilerLockfile(parsed);
  } catch (error) {
    if (error instanceof CompilerLockError) throw error;
    throw new CompilerLockError(`Could not securely read ${COMPILER_LOCK_FILENAME}.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Build operation: a corrupt lock is a cache miss, never a failed generation. */
export async function readCompilerLockfile(
  root: string,
): Promise<CompilerLockfileV1 | undefined> {
  return loadCompilerLockfile(root).catch(() => undefined);
}

export async function writeCompilerLockfile(
  root: string,
  lockfile: CompilerLockfileV1,
): Promise<void> {
  const validated = validateCompilerLockfile(lockfile);
  const path = join(root, COMPILER_LOCK_FILENAME);
  const temporary = join(
    root,
    `.${COMPILER_LOCK_FILENAME}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(validated, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
