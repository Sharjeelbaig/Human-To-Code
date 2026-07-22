/** Isolated, content-addressed workspace snapshots used for validation. */

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { hashCanonical, sha256Bytes } from "../../core/contracts.ts";

const ALWAYS_EXCLUDE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".human-to-code",
  "secrets.human",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|key)$/i,
  /^(?:credentials|service-account)(?:\.|$)/i,
];

export interface SnapshotOptions {
  includeNodeModules?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  excludeNames?: string[];
}

export interface SnapshotFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface WorkspaceSnapshot {
  sourceRoot: string;
  root: string;
  files: SnapshotFile[];
  excluded: string[];
  snapshotHash: string;
  totalBytes: number;
}

export class SnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function isSecretName(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

async function assertRealDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new SnapshotError("INVALID_ROOT", `Cannot inspect snapshot root: ${String(error)}.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SnapshotError("INVALID_ROOT", "Snapshot root must be a real directory.");
  }
}

/**
 * Create a private copy without VCS metadata or credential-bearing files.
 * Symlinks and special files are rejected instead of copied or dereferenced.
 */
export async function createWorkspaceSnapshot(
  rootInput: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const sourceRoot = resolve(rootInput);
  await assertRealDirectory(sourceRoot);
  const container = await mkdtemp(join(tmpdir(), "human-to-code-snapshot-"));
  await chmod(container, 0o700);
  const root = join(container, "workspace");
  await mkdir(root, { mode: 0o700 });

  const excluded: string[] = [];
  const files: SnapshotFile[] = [];
  const excludedNames = new Set([...ALWAYS_EXCLUDE_NAMES, ...(options.excludeNames ?? [])]);
  if (!options.includeNodeModules) excludedNames.add("node_modules");
  const maxFiles = options.maxFiles ?? 100_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  let totalBytes = 0;

  const walk = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: unknown) => {
      throw new SnapshotError("PARTIAL_SCAN", `Cannot read ${sourceDirectory}: ${String(error)}.`);
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const source = join(sourceDirectory, entry.name);
      const target = join(targetDirectory, entry.name);
      const relPath = toPosix(relative(sourceRoot, source));

      if (excludedNames.has(entry.name) || isSecretName(entry.name)) {
        excluded.push(relPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new SnapshotError("SYMLINK_BLOCKED", `Snapshot contains a symlink: ${relPath}.`);
      }
      if (entry.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        await walk(source, target);
        continue;
      }
      if (!entry.isFile()) {
        throw new SnapshotError("SPECIAL_FILE_BLOCKED", `Snapshot contains a special file: ${relPath}.`);
      }

      const info = await lstat(source);
      if (info.nlink > 1) {
        throw new SnapshotError("HARDLINK_BLOCKED", `Snapshot contains a hard-linked file: ${relPath}.`);
      }
      if (files.length + 1 > maxFiles || totalBytes + info.size > maxBytes) {
        throw new SnapshotError("SNAPSHOT_TOO_LARGE", "Workspace exceeds the configured snapshot budget.");
      }
      await copyFile(source, target);
      const mode = info.mode & 0o777;
      await chmod(target, mode);
      const bytes = await readFile(target);
      totalBytes += bytes.length;
      files.push({ path: relPath, sha256: sha256Bytes(bytes), size: bytes.length, mode });
    }
  };

  try {
    await walk(sourceRoot, root);
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort();
  return {
    sourceRoot,
    root,
    files,
    excluded,
    snapshotHash: hashCanonical(files),
    totalBytes,
  };
}

export async function cloneWorkspaceSnapshot(
  source: WorkspaceSnapshot,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  return createWorkspaceSnapshot(source.root, {
    ...options,
    includeNodeModules: options.includeNodeModules ?? true,
  });
}

export async function disposeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  // The public root is always `<private temp>/workspace`; deleting its parent
  // removes the snapshot atomically from the user's perspective.
  const parent = resolve(snapshot.root, "..");
  if (basename(snapshot.root) !== "workspace" || !basename(parent).startsWith("human-to-code-snapshot-")) {
    throw new SnapshotError("INVALID_SNAPSHOT", "Refusing to remove a directory not owned by the snapshot store.");
  }
  await rm(parent, { recursive: true, force: true });
}
