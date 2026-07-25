/** Secret-scanned, bounded content-addressed storage for generated target bytes. */
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanSecrets } from "../../memory/context.ts";

const KEY = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export class ArtifactCacheError extends Error {
  override readonly name = "ArtifactCacheError";
}

export function defaultArtifactCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HUMAN_TO_CODE_CACHE) {
    return resolve(env.HUMAN_TO_CODE_CACHE, "artifacts");
  }
  if (env.XDG_CACHE_HOME) {
    return resolve(env.XDG_CACHE_HOME, "human-to-code", "artifacts");
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return resolve(env.LOCALAPPDATA, "human-to-code", "artifacts");
  }
  if (process.platform === "darwin") {
    return resolve(
      homedir(),
      "Library",
      "Caches",
      "human-to-code",
      "artifacts",
    );
  }
  return resolve(homedir(), ".cache", "human-to-code", "artifacts");
}

function artifactPath(root: string, key: string): string {
  if (!KEY.test(key)) {
    throw new ArtifactCacheError(`Invalid compile key ${JSON.stringify(key)}.`);
  }
  return join(root, key.slice(0, 2), `${key}.bin`);
}

async function isRealDirectory(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => undefined);
  return metadata?.isDirectory() === true && !metadata.isSymbolicLink();
}

export async function readCompilerArtifact(
  key: string,
  root = defaultArtifactCacheRoot(),
): Promise<Buffer | undefined> {
  const path = artifactPath(root, key);
  if (
    !await isRealDirectory(root)
    || !await isRealDirectory(dirname(path))
  ) {
    return undefined;
  }
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined
    || !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size > MAX_ARTIFACT_BYTES
  ) {
    return undefined;
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
      || after.size > MAX_ARTIFACT_BYTES
    ) {
      return undefined;
    }
    const bytes = await handle.readFile();
    return bytes.length <= MAX_ARTIFACT_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function evict(root: string): Promise<void> {
  const directories = await readdir(root, { withFileTypes: true })
    .catch(() => []);
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const childRoot = join(root, directory.name);
    const children = await readdir(childRoot, { withFileTypes: true })
      .catch(() => []);
    for (const child of children) {
      if (!child.isFile() || child.isSymbolicLink()) continue;
      const path = join(childRoot, child.name);
      const metadata = await stat(path).catch(() => undefined);
      if (metadata?.isFile()) {
        files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (
    const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)
  ) {
    if (total <= MAX_CACHE_BYTES) break;
    await rm(file.path, { force: true }).catch(() => undefined);
    total -= file.size;
  }
}

export async function writeCompilerArtifact(
  key: string,
  bytes: Uint8Array,
  root = defaultArtifactCacheRoot(),
): Promise<void> {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ArtifactCacheError(
      `Compiler artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`,
    );
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (scanSecrets(text).length > 0) {
    throw new ArtifactCacheError(
      "Credential-like content was blocked before an artifact-cache write.",
    );
  }
  const path = artifactPath(root, key);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!await isRealDirectory(root)) {
    throw new ArtifactCacheError(
      "Artifact cache root must be a real, non-symlink directory.",
    );
  }
  await chmod(root, 0o700);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!await isRealDirectory(dirname(path))) {
    throw new ArtifactCacheError(
      "Artifact cache shard must be a real, non-symlink directory.",
    );
  }
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await evict(root);
}
