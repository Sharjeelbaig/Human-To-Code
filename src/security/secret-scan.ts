/** Fail-closed repository-wide credential scan performed before provider access. */

import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { scanSecrets, type SecretKind } from "../context/context.ts";

const SKIP_DIRECTORIES = new Set(["node_modules", ".venv", "venv", "target", ".git", ".hg", ".svn", ".human-to-code"]);

export interface ProjectSecretFindingV1 {
  path: string;
  kind: SecretKind;
  line: number;
}

export interface ProjectSecretScanOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxFindings?: number;
}

export interface ProjectSecretScanResultV1 {
  filesScanned: number;
  bytesScanned: number;
  symlinksSkipped: number;
  findings: ProjectSecretFindingV1[];
}

export class ProjectSecretScanError extends Error {
  readonly code: "INVALID_ROOT" | "PARTIAL_SCAN" | "SECRET_DETECTED";
  readonly findings: readonly ProjectSecretFindingV1[];

  constructor(code: ProjectSecretScanError["code"], message: string, findings: readonly ProjectSecretFindingV1[] = []) {
    super(message);
    this.name = "ProjectSecretScanError";
    this.code = code;
    this.findings = findings;
  }
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

/**
 * Scan first-party regular files, including ignored/untracked fixtures and
 * logs. Dependency stores and VCS/tool internals are excluded because they are
 * neither provider context nor first-party source.
 */
export async function scanProjectForSecrets(
  rootInput: string,
  options: ProjectSecretScanOptions = {},
): Promise<ProjectSecretScanResultV1> {
  const root = resolve(rootInput);
  const maximumFiles = options.maxFiles ?? 100_000;
  const maximumBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const maximumFindings = options.maxFindings ?? 100;
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(maximumFindings) || maximumFindings < 1) {
    throw new RangeError("Secret scan budgets must be positive safe integers.");
  }
  const rootMetadata = await lstat(root).catch((cause: unknown) => {
    throw new ProjectSecretScanError("INVALID_ROOT", `Cannot inspect secret-scan root: ${String(cause)}`);
  });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new ProjectSecretScanError("INVALID_ROOT", "Secret-scan root must be a real directory.");
  const canonicalRoot = await realpath(root);
  const result: ProjectSecretScanResultV1 = { filesScanned: 0, bytesScanned: 0, symlinksSkipped: 0, findings: [] };

  const scanFile = async (absolute: string, path: string): Promise<void> => {
    const before = await lstat(absolute).catch((cause: unknown) => {
      throw new ProjectSecretScanError("PARTIAL_SCAN", `Cannot inspect ${path}: ${String(cause)}`);
    });
    if (before.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      return;
    }
    if (!before.isFile() || before.nlink > 1) throw new ProjectSecretScanError("PARTIAL_SCAN", `Secret scan encountered a non-regular or hard-linked file: ${path}.`);
    if (result.filesScanned + 1 > maximumFiles || result.bytesScanned + before.size > maximumBytes) throw new ProjectSecretScanError("PARTIAL_SCAN", "Repository exceeds the configured secret-scan budget.");
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((cause: unknown) => {
      throw new ProjectSecretScanError("PARTIAL_SCAN", `Cannot securely open ${path}: ${String(cause)}`);
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new ProjectSecretScanError("PARTIAL_SCAN", `File changed during secret scan: ${path}.`);
      result.filesScanned += 1;
      result.bytesScanned += opened.size;
      let tail = "";
      let priorLines = 0;
      const stream = handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const decoded = chunk.toString("utf8");
        const searchable = `${tail}${decoded}`;
        const tailLines = tail.match(/\n/gu)?.length ?? 0;
        const findings = scanSecrets(searchable);
        if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u.test(searchable) && !findings.some((item) => item.kind === "private_key")) {
          findings.push({ kind: "private_key", line: 1, start: 0, end: 0 });
        }
        for (const finding of findings) {
          result.findings.push({ path, kind: finding.kind, line: Math.max(1, priorLines - tailLines + finding.line) });
          if (result.findings.length >= maximumFindings) break;
        }
        if (result.findings.length >= maximumFindings) break;
        priorLines += decoded.match(/\n/gu)?.length ?? 0;
        tail = searchable.slice(-4096);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      const path = toPosix(relative(canonicalRoot, directory)) || ".";
      throw new ProjectSecretScanError("PARTIAL_SCAN", `Cannot read ${path}: ${String(cause)}`);
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.findings.length >= maximumFindings) return;
      const absolute = resolve(directory, entry.name);
      const path = toPosix(relative(canonicalRoot, absolute));
      if (entry.isSymbolicLink()) {
        result.symlinksSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute);
      } else if (entry.isFile()) {
        await scanFile(absolute, path);
      } else {
        throw new ProjectSecretScanError("PARTIAL_SCAN", `Secret scan encountered a special file: ${path}.`);
      }
    }
  };

  await walk(canonicalRoot);
  if (result.findings.length > 0) {
    const locations = result.findings.slice(0, 10).map((finding) => `${finding.path}:${finding.line} (${finding.kind})`).join(", ");
    throw new ProjectSecretScanError("SECRET_DETECTED", `Credential-like content was found before provider/cache/report writes: ${locations}.`, result.findings);
  }
  return result;
}

