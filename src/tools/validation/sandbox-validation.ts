/** Strong, container-only validation with baseline comparison. */

import { spawn } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ValidationCommandResultV1,
  ValidationCommandV1,
  ValidationPlanV1,
  ValidationReportV1,
} from "../../core/contracts.ts";
import { scanSecrets } from "../../memory/context.ts";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/u;

const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "npx",
]);

export interface StrongSandboxOptions {
  image: string;
  dockerBinary?: string;
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  maxOutputBytes?: number;
  /** Environment values are opt-in and should contain no credentials. */
  environment?: Record<string, string>;
}

export interface ValidationComparisonOptions extends StrongSandboxOptions {
  baselineRoot: string;
  candidateRoot: string;
  /** A single retry is used only to identify flaky commands. */
  retryFailedOnce?: boolean;
}

interface LocalSandboxRuntime {
  binary: string;
  version: string;
  /** Immutable content id of an image that was already present locally. */
  imageId: string;
}

export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

function now(): string {
  return new Date().toISOString();
}

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function validateCommand(command: ValidationCommandV1): void {
  if (!command.id || !Array.isArray(command.argv) || command.argv.length === 0) {
    throw new ValidationError("INVALID_COMMAND", "Validation commands require an id and argv.");
  }
  if (command.argv.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
    throw new ValidationError("INVALID_COMMAND", `Validation command ${command.id} has invalid argv.`);
  }
  if (SHELL_EXECUTABLES.has(executableName(command.argv[0]!))) {
    throw new ValidationError(
      "SHELL_COMMAND_BLOCKED",
      `Validation command ${command.id} invokes a shell or implicit downloader.`,
    );
  }
  if (
    !Number.isInteger(command.timeoutMs) ||
    command.timeoutMs < MIN_TIMEOUT_MS ||
    command.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new ValidationError(
      "INVALID_TIMEOUT",
      `Validation command ${command.id} timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`,
    );
  }
  if (isAbsolute(command.cwd) || command.cwd.includes("\0")) {
    throw new ValidationError("INVALID_CWD", `Validation command ${command.id} cwd must be relative.`);
  }
}

function assertDirectory(path: string, label: string): Promise<void> {
  return lstat(path).then((info) => {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ValidationError("INVALID_ROOT", `${label} must be a real directory.`);
    }
  });
}

function assertCwd(root: string, cwd: string): string {
  const abs = resolve(root, cwd || ".");
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ValidationError("INVALID_CWD", `Validation cwd escapes the snapshot: ${cwd}.`);
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise<ProcessResult>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function strongSandboxAvailable(dockerBinary = "docker"): Promise<boolean> {
  try {
    const result = await runProcess(
      dockerBinary,
      ["version", "--format", "{{.Server.Version}}"],
      5_000,
      16_384,
    );
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function validateImageReference(image: string): void {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 512 ||
    image.startsWith("-") ||
    /[\0\r\n\t ]/u.test(image)
  ) {
    throw new ValidationError(
      "INVALID_IMAGE",
      "Sandbox image must be a bounded container image reference without whitespace or option prefixes.",
    );
  }
}

/**
 * Resolve a trusted image reference to an already-installed immutable id.
 * Validation never lets Docker/Podman pull an image as a side effect.
 */
async function localSandboxRuntime(
  dockerBinary: string,
  image: string,
): Promise<LocalSandboxRuntime | undefined> {
  validateImageReference(image);
  let versionResult: ProcessResult;
  let imageResult: ProcessResult;
  try {
    [versionResult, imageResult] = await Promise.all([
      runProcess(
        dockerBinary,
        ["version", "--format", "{{.Server.Version}}"],
        5_000,
        16_384,
      ),
      runProcess(
        dockerBinary,
        ["image", "inspect", "--format", "{{.Id}}", image],
        10_000,
        16_384,
      ),
    ]);
  } catch {
    return undefined;
  }
  const version = versionResult.stdout.trim();
  const rawId = imageResult.stdout.trim().toLowerCase();
  if (
    versionResult.code !== 0 ||
    version.length === 0 ||
    imageResult.code !== 0 ||
    !IMAGE_ID.test(rawId)
  ) {
    return undefined;
  }
  const imageId = rawId.startsWith("sha256:") ? rawId : `sha256:${rawId}`;
  return { binary: dockerBinary, version, imageId };
}

function safeEnvironment(environment: Record<string, string> | undefined): string[] {
  const args: string[] = ["-e", "HOME=/tmp/human-to-code-home", "-e", "CI=1"];
  for (const [key, value] of Object.entries(environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new ValidationError("INVALID_ENV", `Invalid sandbox environment name: ${key}.`);
    }
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL/i.test(key)) {
      throw new ValidationError("SECRET_ENV", `Credential-like environment variable is blocked: ${key}.`);
    }
    if (value.includes("\0") || value.length > 16_384) {
      throw new ValidationError("INVALID_ENV", `Invalid sandbox environment value for ${key}.`);
    }
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

async function runInStrongSandbox(
  rootInput: string,
  command: ValidationCommandV1,
  options: StrongSandboxOptions,
): Promise<ValidationCommandResultV1> {
  validateCommand(command);
  const root = resolve(rootInput);
  await assertDirectory(root, "Validation snapshot");
  const cwd = assertCwd(root, command.cwd);
  const cwdInfo = await stat(resolve(root, cwd)).catch(() => undefined);
  if (!cwdInfo?.isDirectory()) {
    throw new ValidationError("INVALID_CWD", `Validation cwd does not exist: ${command.cwd}.`);
  }

  const name = `human-to-code-${randomUUID()}`;
  const docker = options.dockerBinary ?? "docker";
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(options.pidsLimit ?? 256),
    "--memory",
    options.memory ?? "2g",
    "--cpus",
    String(options.cpus ?? 2),
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=536870912",
    "--mount",
    `type=bind,src=${root},dst=/workspace,rw`,
    "--workdir",
    cwd === "." ? "/workspace" : `/workspace/${cwd}`,
    ...safeEnvironment(options.environment),
    options.image,
    ...command.argv,
  ];

  const startedAt = now();
  let result: ProcessResult;
  try {
    result = await runProcess(
      docker,
      args,
      command.timeoutMs,
      options.maxOutputBytes ?? MAX_CAPTURE_BYTES,
    );
  } catch (error) {
    return {
      id: command.id,
      status: "error",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: String(error),
      timedOut: false,
      flaky: false,
      outputTruncated: false,
      startedAt,
      finishedAt: now(),
    };
  }
  if (result.timedOut) {
    await runProcess(docker, ["rm", "-f", name], 10_000, 32_768).catch(() => undefined);
  }
  const secretOutput = scanSecrets(result.stdout).length > 0 || scanSecrets(result.stderr).length > 0;
  return {
    id: command.id,
    status: secretOutput ? "error" : result.code === 0 && !result.timedOut ? "passed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: secretOutput ? "" : result.stdout,
    stderr: secretOutput ? "SECURITY_BLOCKED: credential-like validation output was discarded before report persistence." : result.stderr,
    timedOut: result.timedOut,
    flaky: false,
    outputTruncated: result.outputTruncated,
    startedAt,
    finishedAt: now(),
  };
}

async function runPlan(
  root: string,
  plan: ValidationPlanV1,
  options: StrongSandboxOptions,
  retryFailedOnce: boolean,
): Promise<ValidationCommandResultV1[]> {
  const results: ValidationCommandResultV1[] = [];
  for (const command of plan.commands) {
    let result = await runInStrongSandbox(root, command, options);
    if (retryFailedOnce && result.status === "failed") {
      const retry = await runInStrongSandbox(root, command, options);
      if (retry.status === "passed") result = { ...retry, flaky: true };
    }
    results.push(result);
  }
  return results;
}

function resultFailed(result: ValidationCommandResultV1): boolean {
  return result.status !== "passed" || result.flaky || result.outputTruncated;
}

/**
 * Runs the same frozen checks against the untouched project and against the
 * generated candidate, each in its own strong sandbox, then compares them.
 */
export async function validateBaselineAndCandidate(
  plan: ValidationPlanV1,
  options: ValidationComparisonOptions,
): Promise<ValidationReportV1> {
  const startedAt = now();
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.commands) || plan.commands.length === 0) {
    throw new ValidationError("INVALID_PLAN", "ValidationPlanV1 must contain at least one command.");
  }
  for (const command of plan.commands) validateCommand(command);
  await Promise.all([
    assertDirectory(resolve(options.baselineRoot), "Baseline snapshot"),
    assertDirectory(resolve(options.candidateRoot), "Candidate snapshot"),
  ]);

  const available = await strongSandboxAvailable(options.dockerBinary);
  if (!available) {
    return {
      schemaVersion: 1,
      status: "unvalidated",
      sandbox: "none",
      baseline: [],
      candidate: [],
      repairs: [],
      manualChecks: plan.manualChecks.map((description) => ({
        description,
        status: "pending" as const,
      })),
      diagnostics: ["A strong Docker sandbox is unavailable; no project command was executed."],
      startedAt,
      finishedAt: now(),
    };
  }

  const dockerBinary = options.dockerBinary ?? "docker";
  const runtime = await localSandboxRuntime(dockerBinary, options.image);
  if (!runtime) {
    return {
      schemaVersion: 1,
      status: "unvalidated",
      sandbox: "none",
      baseline: [],
      candidate: [],
      repairs: [],
      manualChecks: plan.manualChecks.map((description) => ({
        description,
        status: "pending" as const,
      })),
      diagnostics: [
        "The configured validation image is not already installed as a locally inspectable immutable image; no image was pulled and no project command was executed.",
      ],
      startedAt,
      finishedAt: now(),
    };
  }

  const sandboxOptions: StrongSandboxOptions = {
    image: runtime.imageId,
    dockerBinary: runtime.binary,
    cpus: options.cpus,
    memory: options.memory,
    pidsLimit: options.pidsLimit,
    maxOutputBytes: options.maxOutputBytes,
    environment: options.environment,
  };
  const retry = options.retryFailedOnce ?? true;
  const baseline = await runPlan(options.baselineRoot, plan, sandboxOptions, retry);
  const candidate = await runPlan(options.candidateRoot, plan, sandboxOptions, retry);

  const requiredIds = new Set(plan.commands.filter((command) => command.required).map((command) => command.id));
  const requiredCandidate = candidate.filter((result) => requiredIds.has(result.id));
  const baselineFailures = baseline.filter((result) => requiredIds.has(result.id) && resultFailed(result));
  const candidateFailures = requiredCandidate.filter(resultFailed);
  const diagnostics: string[] = [];
  diagnostics.push(
    `Sandbox runtime ${runtime.version}; locally installed image ${runtime.imageId}; image pulling disabled.`,
  );
  let status: ValidationReportV1["status"];

  if (candidateFailures.length === 0 && baselineFailures.length === 0) {
    status = plan.manualChecks.length === 0 ? "validated" : "unvalidated";
    if (plan.manualChecks.length > 0) diagnostics.push("Manual acceptance checks remain incomplete.");
  } else if (candidateFailures.length === 0 && baselineFailures.length > 0) {
    status = "non_regression_only";
    diagnostics.push("The baseline was unhealthy; candidate checks passed but cannot be certified automatically.");
  } else {
    const baselineIds = new Set(baselineFailures.map((result) => result.id));
    const onlyExisting = candidateFailures.every((result) => baselineIds.has(result.id));
    status = onlyExisting ? "non_regression_only" : "failed";
    diagnostics.push(
      onlyExisting
        ? "Required failures existed in the baseline and remain; the result is not verified."
        : "The candidate introduced or retained required validation failures.",
    );
  }
  if ([...baseline, ...candidate].some((result) => result.flaky)) {
    status = "unvalidated";
    diagnostics.push("At least one validation command was flaky (failed and then passed)." );
  }
  if ([...baseline, ...candidate].some((result) => result.stderr.startsWith("SECURITY_BLOCKED:"))) {
    status = "failed";
    diagnostics.push("SECURITY_BLOCKED: validation emitted credential-like content; captured output was discarded.");
  }

  return {
    schemaVersion: 1,
    status,
    sandbox: "strong",
    baseline,
    candidate,
    repairs: [],
    manualChecks: plan.manualChecks.map((description) => ({
      description,
      status: "pending" as const,
    })),
    diagnostics,
    startedAt,
    finishedAt: now(),
  };
}
