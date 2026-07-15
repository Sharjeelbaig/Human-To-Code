/** Durable, private, crash-safe storage for resumable run metadata. */

import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { validateRunRecordV1, type RunRecordV1 } from "./contracts.ts";
import { scanSecrets } from "./context.ts";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const heldRunLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export class RunStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
  }
}

export function defaultRunStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HUMAN_TO_CODE_CACHE) return resolve(env.HUMAN_TO_CODE_CACHE, "runs");
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME, "human-to-code", "runs");
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return resolve(env.LOCALAPPDATA, "human-to-code", "runs");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Caches", "human-to-code", "runs");
  }
  return resolve(homedir(), ".cache", "human-to-code", "runs");
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunStoreError("INVALID_RUN_ID", `Invalid run id: ${JSON.stringify(runId)}.`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const inspect = (input: unknown): void => {
    if (typeof input === "string") {
      if (scanSecrets(input).length > 0) throw new RunStoreError("SECRET_BLOCKED", "Credential-like content was blocked before a run-store write.");
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) inspect(item);
      return;
    }
    if (typeof input === "object" && input !== null) {
      for (const item of Object.values(input)) inspect(item);
    }
  };
  inspect(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new RunStoreError("UNSAFE_STORE", `${label} must be a real, non-symlink directory.`);
  }
}

async function readJsonSecure(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) throw new RunStoreError("ARTIFACT_NOT_FOUND", `${label} is missing.`);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new RunStoreError("INVALID_ARTIFACT", `${label} is missing, unsafe, or too large.`);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size > maximumBytes) {
      throw new RunStoreError("INVALID_ARTIFACT", `${label} changed while it was being opened.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes) throw new RunStoreError("INVALID_ARTIFACT", `${label} is too large.`);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new RunStoreError("INVALID_ARTIFACT", `${label} is invalid JSON.`);
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("INVALID_ARTIFACT", `${label} could not be securely read.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class RunStore {
  readonly root: string;

  constructor(root = defaultRunStoreRoot()) {
    this.root = resolve(root);
  }

  private runDirectory(runId: string): string {
    assertRunId(runId);
    return join(this.root, runId);
  }

  private recordPath(runId: string): string {
    return join(this.runDirectory(runId), "run.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertRealDirectory(this.root, "Run-store root");
    await chmod(this.root, 0o700);
  }

  async create(record: RunRecordV1): Promise<void> {
    await this.initialize();
    const directory = this.runDirectory(record.runId);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RunStoreError("RUN_EXISTS", `Run already exists: ${record.runId}.`);
      }
      throw error;
    }
    await writeJsonAtomic(this.recordPath(record.runId), record);
  }

  async read(runId: string): Promise<RunRecordV1> {
    const path = this.recordPath(runId);
    let value: unknown;
    try {
      await assertRealDirectory(this.root, "Run-store root");
      await assertRealDirectory(this.runDirectory(runId), "Run directory");
      value = await readJsonSecure(path, 2 * 1024 * 1024, `Run record ${runId}`);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "UNSAFE_STORE") {
        const missing = await lstat(path).catch(() => undefined);
        if (!missing) throw new RunStoreError("RUN_NOT_FOUND", `Run not found: ${runId}.`);
      }
      if (error instanceof RunStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunStoreError("RUN_NOT_FOUND", `Run not found: ${runId}.`);
      }
      throw error;
    }
    let record: RunRecordV1;
    try {
      record = validateRunRecordV1(value);
    } catch {
      throw new RunStoreError("INVALID_RUN", `Run record schema or identity is invalid: ${runId}.`);
    }
    if (record.runId !== runId) throw new RunStoreError("INVALID_RUN", `Run record identity is invalid: ${runId}.`);
    return record;
  }

  async update(
    runId: string,
    update: (current: RunRecordV1) => RunRecordV1 | Promise<RunRecordV1>,
  ): Promise<RunRecordV1> {
    return this.withLock(runId, async () => {
      const current = await this.read(runId);
      const next = await update(current);
      if (next.runId !== runId || next.schemaVersion !== 1) {
        throw new RunStoreError("INVALID_RUN", "Run updates cannot change schemaVersion or runId.");
      }
      await writeJsonAtomic(this.recordPath(runId), next);
      return next;
    });
  }

  async writeArtifact(runId: string, name: string, value: unknown): Promise<string> {
    assertRunId(runId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name)) {
      throw new RunStoreError("INVALID_ARTIFACT", `Invalid JSON artifact name: ${JSON.stringify(name)}.`);
    }
    await this.initialize();
    const directory = this.runDirectory(runId);
    await assertRealDirectory(directory, "Run directory");
    const path = join(directory, name);
    await writeJsonAtomic(path, value);
    return path;
  }

  async readArtifact<T>(runId: string, name: string): Promise<T> {
    assertRunId(runId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name)) {
      throw new RunStoreError("INVALID_ARTIFACT", `Invalid JSON artifact name: ${JSON.stringify(name)}.`);
    }
    const path = join(this.runDirectory(runId), name);
    await assertRealDirectory(this.root, "Run-store root");
    await assertRealDirectory(this.runDirectory(runId), "Run directory");
    return await readJsonSecure(path, 10 * 1024 * 1024, `Artifact ${name}`) as T;
  }

  async readArtifactOptional<T>(runId: string, name: string): Promise<T | undefined> {
    try {
      return await this.readArtifact<T>(runId, name);
    } catch (error) {
      if (error instanceof RunStoreError && error.code === "ARTIFACT_NOT_FOUND") return undefined;
      throw error;
    }
  }

  /** Serialize a state-changing run action across processes. */
  async exclusive<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return this.withLock(runId, action);
  }

  private async withLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const directory = this.runDirectory(runId);
    await assertRealDirectory(this.root, "Run-store root");
    await assertRealDirectory(directory, "Run directory");
    const lockKey = `${this.root}\0${runId}`;
    const inherited = heldRunLocks.getStore();
    if (inherited?.has(lockKey)) return action();
    const lockPath = join(directory, ".lock");
    let handle;
    const acquire = async (): Promise<Awaited<ReturnType<typeof open>>> => open(lockPath, "wx", 0o600);
    try {
      handle = await acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = await lstat(lockPath).catch(() => undefined);
      let stale = false;
      if (before?.isFile() && !before.isSymbolicLink() && before.nlink === 1) {
        const ageMs = Date.now() - before.mtimeMs;
        if (before.size === 0) {
          stale = ageMs >= 30_000;
        } else {
          const raw = await readJsonSecure(lockPath, 4096, "Run lock").catch(() => undefined);
          if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            const pid = (raw as { pid?: unknown }).pid;
            const createdAt = (raw as { createdAt?: unknown }).createdAt;
            if (Number.isSafeInteger(pid) && (pid as number) > 0
              && typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt))
              && Date.now() - Date.parse(createdAt) >= 5_000) {
              try {
                process.kill(pid as number, 0);
              } catch (probeError) {
                stale = (probeError as NodeJS.ErrnoException).code === "ESRCH";
              }
            }
          }
        }
      }
      if (stale && before) {
        const after = await lstat(lockPath).catch(() => undefined);
        if (after && after.dev === before.dev && after.ino === before.ino) {
          await rm(lockPath, { force: true });
          handle = await acquire().catch(() => undefined);
        }
      }
      if (!handle) {
        throw new RunStoreError("RUN_LOCKED", `Another process is updating run ${runId}.`);
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce: randomUUID() })}\n`, "utf8");
      await handle.sync();
      return await heldRunLocks.run(new Set([...(inherited ?? []), lockKey]), action);
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  }
}
