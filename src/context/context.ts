/** Deterministic, secret-aware context selection and provenance. */

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_SCHEMA_VERSION,
  ArtifactValidationError,
  hashCanonical,
  isSafeRelativePath,
  sha256Text,
  type ValidationIssue,
} from "../core/contracts.ts";

export type LocalContextOrigin =
  | "project"
  | "dependency"
  | "private_documentation"
  | "diagnostic";

export interface ContextRangeV1 {
  startLine: number;
  endLine: number;
}

export interface LocalContextCandidateV1 {
  origin: LocalContextOrigin;
  path: string;
  reason: string;
  range?: ContextRangeV1;
  priority?: number;
  required?: boolean;
  version?: string;
}

export interface OfficialDocumentationCandidateV1 {
  origin: "official_documentation";
  url: string;
  version: string;
  content: string;
  /** Hash supplied by the documentation cache/retriever. */
  contentSha256: string;
  reason: string;
  cached: boolean;
  range?: ContextRangeV1;
  priority?: number;
  required?: boolean;
}

export type ContextCandidateV1 =
  | LocalContextCandidateV1
  | OfficialDocumentationCandidateV1;

export interface ContextRedactionV1 {
  kind: SecretKind;
  line: number;
}

export interface LocalContextEvidenceV1 {
  id: string;
  origin: LocalContextOrigin;
  path: string;
  version?: string;
  startLine: number;
  endLine: number;
  sha256: string;
  reason: string;
  content: string;
  redactions: ContextRedactionV1[];
  untrusted: true;
}

export interface OfficialDocumentationEvidenceV1 {
  id: string;
  origin: "official_documentation";
  url: string;
  version: string;
  cached: boolean;
  startLine: number;
  endLine: number;
  sha256: string;
  reason: string;
  content: string;
  redactions: ContextRedactionV1[];
  untrusted: true;
}

export type ContextEvidenceV1 =
  | LocalContextEvidenceV1
  | OfficialDocumentationEvidenceV1;

export type ContextExclusionCode =
  | "DUPLICATE"
  | "BUDGET"
  | "EMPTY"
  | "OPTIONAL_UNAVAILABLE";

export interface ContextExclusionV1 {
  location: string;
  code: ContextExclusionCode;
  reason: string;
}

export interface ContextBudgetV1 {
  maxItems: number;
  maxBytes: number;
  maxEstimatedTokens: number;
  maxBytesPerItem: number;
}

export interface ContextBudgetUsageV1 extends ContextBudgetV1 {
  usedItems: number;
  usedBytes: number;
  usedEstimatedTokens: number;
}

export interface ContextManifestV1 {
  schemaVersion: 1;
  projectFingerprint: string;
  offline: boolean;
  evidence: ContextEvidenceV1[];
  exclusions: ContextExclusionV1[];
  budget: ContextBudgetUsageV1;
  redactionCount: number;
}

export interface ContextSelectionOptions {
  root: string;
  projectFingerprint: string;
  candidates: ContextCandidateV1[];
  offline?: boolean;
  secretPolicy?: "block" | "redact";
  budget?: Partial<ContextBudgetV1>;
  /** Hostnames (or parent domains) approved as authoritative sources. */
  officialDocumentationHosts?: string[];
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudgetV1> = Object.freeze({
  maxItems: 40,
  maxBytes: 256 * 1024,
  maxEstimatedTokens: 64 * 1024,
  maxBytesPerItem: 64 * 1024,
});

const MAX_CONTEXT_SOURCE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_OFFICIAL_DOCUMENTATION_HOSTS: readonly string[] = Object.freeze([
  "react.dev",
  "nextjs.org",
  "vite.dev",
  "docs.nestjs.com",
  "fastapi.tiangolo.com",
  "docs.pydantic.dev",
  "docs.python.org",
  "python.org",
  "doc.rust-lang.org",
  "docs.rs",
  "nodejs.org",
  "typescriptlang.org",
  "developer.mozilla.org",
]);

export type SecretKind =
  | "private_key"
  | "aws_access_key"
  | "api_token"
  | "github_token"
  | "google_api_key"
  | "credential_assignment"
  | "credential_url";

export interface SecretFindingV1 {
  kind: SecretKind;
  line: number;
  start: number;
  end: number;
}

export type ContextErrorCode =
  | "INVALID_ROOT"
  | "PATH_ESCAPE"
  | "PROTECTED_PATH"
  | "SYMLINK_BLOCKED"
  | "NOT_A_FILE"
  | "BINARY_BLOCKED"
  | "SECRET_DETECTED"
  | "BUDGET_EXCEEDED"
  | "DOCUMENTATION_BLOCKED"
  | "DOCUMENTATION_HASH_MISMATCH"
  | "OFFLINE_MISS"
  | "INVALID_CANDIDATE";

export class ContextSecurityError extends Error {
  readonly code: ContextErrorCode;
  readonly location: string | undefined;

  constructor(code: ContextErrorCode, message: string, location?: string) {
    super(message);
    this.name = "ContextSecurityError";
    this.code = code;
    this.location = location;
  }
}

const PROTECTED_EXACT_NAMES = new Set([
  "secrets.human",
  "human-to-code.config.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".envrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "service-account.json",
  "kubeconfig",
]);

const PROTECTED_SEGMENTS = new Set([".git", ".hg", ".svn", ".human-to-code"]);
const PROTECTED_NAME_PATTERNS = [
  /^\.env(?:\..*)?$/iu,
  /^\.envrc$/iu,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/iu,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/iu,
  /^(?:credentials?|secrets?)(?:\..*)?$/iu,
];

/** Filename-only protection, intentionally independent of ignore rules. */
export function isProtectedContextPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.some((part) => {
    const lower = part.toLowerCase();
    return PROTECTED_SEGMENTS.has(lower)
      || PROTECTED_EXACT_NAMES.has(lower)
      || PROTECTED_NAME_PATTERNS.some((pattern) => pattern.test(part));
  }) || parts.some((part, index) => part === ".cargo" && /^credentials(?:\.toml)?$/iu.test(parts[index + 1] ?? ""))
    || parts.some((part, index) => part === ".docker" && (parts[index + 1] ?? "").toLowerCase() === "config.json");
}

interface SecretPattern {
  kind: SecretKind;
  expression: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "private_key", expression: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu },
  { kind: "aws_access_key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { kind: "github_token", expression: /\b(?:gh[pousr]_[A-Za-z0-9]{32,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu },
  { kind: "google_api_key", expression: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { kind: "api_token", expression: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gu },
  {
    kind: "credential_assignment",
    expression: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|credential|password|passwd|private[_-]?key|database[_-]?url|connection[_-]?string)\b\s*(?::|=)\s*["']?[A-Za-z0-9/+_.:@-]{8,}["']?/giu,
  },
  { kind: "credential_url", expression: /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/giu },
];

/** Returns metadata only; the matched credential is never exposed. */
export function scanSecrets(content: string): SecretFindingV1[] {
  const offsets: Array<Omit<SecretFindingV1, "line">> = [];
  for (const pattern of SECRET_PATTERNS) {
    const expression = new RegExp(pattern.expression.source, pattern.expression.flags);
    for (const match of content.matchAll(expression)) {
      if (pattern.kind === "credential_assignment") {
        const assignment = match[0];
        const separator = assignment.search(/[:=]/u);
        const right = separator < 0 ? "" : assignment.slice(separator + 1).trim();
        const reference = /(?:process\.env|import\.meta\.env|os\.environ|environ\.(?:get|getitem)|\bgetenv\b|config\.get|settings\.|(?:get|load|read)secret|secret(?:::|provider|reference|ref)|secretmanager|\bvault\b|redacted|placeholder|example|changeme|your[_-]|<[^>]+>|\$\{)/iu.test(assignment)
          || (!/^["']/u.test(right) && /^[A-Za-z_$][\w$]*(?:(?:\.|::)[\w$]+)*$/u.test(right));
        if (reference) continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      offsets.push({ kind: pattern.kind, start, end });
    }
  }
  offsets.sort((a, b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind));
  let cursor = 0;
  let line = 1;
  return offsets.map((finding) => {
    for (let index = cursor; index < finding.start; index += 1) {
      if (content.charCodeAt(index) === 10) line += 1;
    }
    cursor = finding.start;
    return { ...finding, line };
  });
}

function redactSecretFindings(content: string, findings: readonly SecretFindingV1[]): { content: string; redactions: ContextRedactionV1[] } {
  const nonOverlapping: SecretFindingV1[] = [];
  let cursor = -1;
  for (const finding of findings) {
    if (finding.start < cursor) continue;
    nonOverlapping.push(finding);
    cursor = finding.end;
  }
  let output = "";
  cursor = 0;
  for (const finding of nonOverlapping) {
    const removed = content.slice(finding.start, finding.end);
    const newlineCount = removed.match(/\n/gu)?.length ?? 0;
    output += content.slice(cursor, finding.start);
    output += `[REDACTED:${finding.kind}]${"\n".repeat(newlineCount)}`;
    cursor = finding.end;
  }
  output += content.slice(cursor);
  return {
    content: output,
    redactions: nonOverlapping.map(({ kind, line }) => ({ kind, line })),
  };
}

function validateBudget(partial: Partial<ContextBudgetV1> | undefined): ContextBudgetV1 {
  if (partial !== undefined && (typeof partial !== "object" || partial === null || Array.isArray(partial))) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context budget must be an object.");
  }
  const allowed = new Set(["maxItems", "maxBytes", "maxEstimatedTokens", "maxBytesPerItem"]);
  for (const key of Object.keys(partial ?? {})) {
    if (!allowed.has(key)) throw new ContextSecurityError("INVALID_CANDIDATE", `Unknown context budget key '${key}'.`);
  }
  const budget = { ...DEFAULT_CONTEXT_BUDGET, ...partial };
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ContextSecurityError("INVALID_CANDIDATE", `Context budget '${key}' must be a positive integer.`);
    }
  }
  if (budget.maxBytesPerItem > budget.maxBytes) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "maxBytesPerItem cannot exceed maxBytes.");
  }
  return budget;
}

function validateRange(range: ContextRangeV1 | undefined, totalLines: number, location: string): ContextRangeV1 {
  const resolved = range ?? { startLine: 1, endLine: totalLines };
  if (!Number.isSafeInteger(resolved.startLine) || !Number.isSafeInteger(resolved.endLine)
    || resolved.startLine < 1 || resolved.endLine < resolved.startLine || resolved.endLine > totalLines) {
    throw new ContextSecurityError("INVALID_CANDIDATE", `Invalid line range for ${location}.`, location);
  }
  return resolved;
}

function rangeContent(content: string, range: ContextRangeV1): string {
  return content.split("\n").slice(range.startLine - 1, range.endLine).join("\n");
}

function estimatedTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

function sourceRank(origin: ContextCandidateV1["origin"]): number {
  return origin === "project" ? 0
    : origin === "dependency" ? 1
      : origin === "private_documentation" ? 2
        : origin === "diagnostic" ? 3
          : 4;
}

function candidateLocation(candidate: ContextCandidateV1): string {
  return candidate.origin === "official_documentation" ? candidate.url : candidate.path;
}

function compareCandidates(a: ContextCandidateV1, b: ContextCandidateV1): number {
  return Number(Boolean(b.required)) - Number(Boolean(a.required))
    || sourceRank(a.origin) - sourceRank(b.origin)
    || (b.priority ?? 0) - (a.priority ?? 0)
    || candidateLocation(a).localeCompare(candidateLocation(b))
    || (a.range?.startLine ?? 1) - (b.range?.startLine ?? 1)
    || a.reason.localeCompare(b.reason);
}

function ensureReason(candidate: ContextCandidateV1): void {
  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0 || candidate.reason.length > 4096) {
    throw new ContextSecurityError("INVALID_CANDIDATE", `Context candidate ${candidateLocation(candidate)} needs a bounded reason.`);
  }
  if (candidate.priority !== undefined && (!Number.isSafeInteger(candidate.priority) || candidate.priority < -1000 || candidate.priority > 1000)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", `Context candidate ${candidateLocation(candidate)} has an invalid priority.`);
  }
}

function assertCandidateShape(value: unknown): asserts value is ContextCandidateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Every context candidate must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const origins = ["project", "dependency", "private_documentation", "diagnostic", "official_documentation"];
  if (typeof candidate.origin !== "string" || !origins.includes(candidate.origin)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidate has an unsupported origin.");
  }
  const official = candidate.origin === "official_documentation";
  const requiredKeys = official
    ? ["origin", "url", "version", "content", "contentSha256", "reason", "cached"]
    : ["origin", "path", "reason"];
  const allowedKeys = new Set([...requiredKeys, "range", "priority", "required", ...(official ? [] : ["version"])]);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) throw new ContextSecurityError("INVALID_CANDIDATE", `Unknown context candidate key '${key}'.`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(candidate, key)) throw new ContextSecurityError("INVALID_CANDIDATE", `Context candidate is missing '${key}'.`);
  }
  if (candidate.required !== undefined && typeof candidate.required !== "boolean") {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidate required flag must be boolean.");
  }
  if (candidate.version !== undefined && (typeof candidate.version !== "string" || candidate.version.trim().length === 0 || candidate.version.length > 256)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidate version must be a non-empty bounded string.");
  }
  if (official) {
    if (typeof candidate.url !== "string" || candidate.url.length === 0 || candidate.url.length > 4096
      || typeof candidate.content !== "string" || typeof candidate.contentSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.contentSha256) || typeof candidate.cached !== "boolean") {
      throw new ContextSecurityError("INVALID_CANDIDATE", "Official documentation candidate fields are invalid.");
    }
  } else if (typeof candidate.path !== "string") {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Local context candidate path must be a string.");
  }
  if (candidate.range !== undefined) {
    if (typeof candidate.range !== "object" || candidate.range === null || Array.isArray(candidate.range)) {
      throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidate range must be an object.");
    }
    const range = candidate.range as Record<string, unknown>;
    if (Object.keys(range).some((key) => !["startLine", "endLine"].includes(key))
      || !Object.hasOwn(range, "startLine") || !Object.hasOwn(range, "endLine")
      || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine)) {
      throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidate range requires integer startLine and endLine only.");
    }
  }
  ensureReason(value as ContextCandidateV1);
}

async function assertNoSymlinkComponents(root: string, path: string, allowConfinedDependencyLinks: boolean): Promise<void> {
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor).catch((error: unknown) => {
      void error;
      throw new ContextSecurityError("NOT_A_FILE", "Requested context path does not exist or is unreadable.", path);
    });
    if (info.isSymbolicLink()) {
      if (!allowConfinedDependencyLinks) {
        throw new ContextSecurityError("SYMLINK_BLOCKED", "Project context paths may not traverse symbolic links.", path);
      }
    }
  }
}

async function readLocalCandidate(
  realRoot: string,
  candidate: LocalContextCandidateV1,
  policy: "block" | "redact",
): Promise<LocalContextEvidenceV1> {
  if (!isSafeRelativePath(candidate.path) || isAbsolute(candidate.path)) {
    throw new ContextSecurityError("PATH_ESCAPE", "Context path must be root-relative and confined.", candidate.path);
  }
  const normalized = candidate.path.replaceAll("\\", "/");
  if (isProtectedContextPath(normalized)) {
    throw new ContextSecurityError("PROTECTED_PATH", "A protected credential-bearing path was requested.", normalized);
  }
  const dependencyLink = candidate.origin === "dependency" && normalized.split("/").includes("node_modules");
  await assertNoSymlinkComponents(realRoot, normalized, dependencyLink);
  const absolute = resolve(realRoot, ...normalized.split("/"));
  const canonical = await realpath(absolute).catch((error: unknown) => {
    void error;
    throw new ContextSecurityError("NOT_A_FILE", "Requested context path does not exist or is unreadable.", normalized);
  });
  const rel = relative(realRoot, canonical);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ContextSecurityError("PATH_ESCAPE", "Resolved context path escapes the project root.", normalized);
  }
  const canonicalRelative = rel.split(sep).join("/");
  if (isProtectedContextPath(canonicalRelative)) {
    throw new ContextSecurityError("PROTECTED_PATH", "Resolved context path targets protected content.", normalized);
  }
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || (!dependencyLink && info.nlink > 1)) {
    throw new ContextSecurityError(info.isSymbolicLink() ? "SYMLINK_BLOCKED" : "NOT_A_FILE", "Context source must be a single-link regular file.", normalized);
  }
  if (info.size > MAX_CONTEXT_SOURCE_BYTES) {
    throw new ContextSecurityError("BUDGET_EXCEEDED", "Context source exceeds the maximum safe scan size.", normalized);
  }
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: unknown) => {
    void error;
    throw new ContextSecurityError("NOT_A_FILE", "Context source could not be opened without following links.", normalized);
  });
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (!dependencyLink && opened.nlink !== 1) || opened.dev !== info.dev || opened.ino !== info.ino
      || opened.size !== info.size || opened.size > MAX_CONTEXT_SOURCE_BYTES) {
      throw new ContextSecurityError("SYMLINK_BLOCKED", "Context source changed during secure opening.", normalized);
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.includes(0)) throw new ContextSecurityError("BINARY_BLOCKED", "Binary files cannot be model context.", normalized);
  let content = bytes.toString("utf8");
  const findings = scanSecrets(content);
  if (findings.length > 0 && policy === "block") {
    throw new ContextSecurityError("SECRET_DETECTED", `Credential-like content was found in ${normalized}; no content was selected.`, normalized);
  }
  const redacted = findings.length > 0 ? redactSecretFindings(content, findings) : { content, redactions: [] };
  content = redacted.content;
  const totalLines = content.split("\n").length;
  const range = validateRange(candidate.range, totalLines, normalized);
  const selected = rangeContent(content, range);
  const sha256 = sha256Text(selected);
  return {
    id: sha256Text(`${candidate.origin}\0${normalized}\0${range.startLine}\0${range.endLine}\0${sha256}`),
    origin: candidate.origin,
    path: normalized,
    ...(candidate.version === undefined ? {} : { version: candidate.version }),
    startLine: range.startLine,
    endLine: range.endLine,
    sha256,
    reason: candidate.reason,
    content: selected,
    redactions: redacted.redactions.filter((finding) => finding.line >= range.startLine && finding.line <= range.endLine),
    untrusted: true,
  };
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return allowed.some((entry) => {
    const normalized = entry.toLowerCase().replace(/\.$/u, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function validateDocumentationUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ContextSecurityError("DOCUMENTATION_BLOCKED", "Documentation URL is invalid.", raw);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ContextSecurityError("DOCUMENTATION_BLOCKED", "Documentation URLs must use credential-free HTTPS on the default port.");
  }
  if ([...url.searchParams.keys()].some((key) => /(?:token|key|secret|password|credential|signature)/iu.test(key))) {
    throw new ContextSecurityError("DOCUMENTATION_BLOCKED", "Documentation URLs may not contain credential-like query parameters.");
  }
  if (isIP(url.hostname) !== 0 || url.hostname === "localhost" || !hostAllowed(url.hostname, allowedHosts)) {
    throw new ContextSecurityError("DOCUMENTATION_BLOCKED", "Documentation host is not on the official allowlist.");
  }
  url.hash = "";
  return url;
}

function readDocumentationCandidate(
  candidate: OfficialDocumentationCandidateV1,
  offline: boolean,
  policy: "block" | "redact",
  allowedHosts: readonly string[],
): OfficialDocumentationEvidenceV1 {
  const url = validateDocumentationUrl(candidate.url, allowedHosts);
  if (!candidate.version.trim()) throw new ContextSecurityError("INVALID_CANDIDATE", "Official documentation evidence requires an exact version.", candidate.url);
  if (offline && !candidate.cached) throw new ContextSecurityError("OFFLINE_MISS", "Offline mode accepts only previously cached documentation.", candidate.url);
  if (sha256Text(candidate.content) !== candidate.contentSha256) {
    throw new ContextSecurityError("DOCUMENTATION_HASH_MISMATCH", "Documentation content does not match its cache/retrieval hash.", candidate.url);
  }
  if (Buffer.byteLength(candidate.content, "utf8") > MAX_CONTEXT_SOURCE_BYTES) {
    throw new ContextSecurityError("BUDGET_EXCEEDED", "Documentation evidence exceeds the maximum safe scan size.", candidate.url);
  }
  const findings = scanSecrets(candidate.content);
  if (findings.length > 0 && policy === "block") {
    throw new ContextSecurityError("SECRET_DETECTED", "Credential-like content was found in documentation evidence.", candidate.url);
  }
  const redacted = findings.length > 0 ? redactSecretFindings(candidate.content, findings) : { content: candidate.content, redactions: [] };
  const totalLines = redacted.content.split("\n").length;
  const range = validateRange(candidate.range, totalLines, candidate.url);
  const selected = rangeContent(redacted.content, range);
  const sha256 = sha256Text(selected);
  return {
    id: sha256Text(`official_documentation\0${url.href}\0${candidate.version}\0${range.startLine}\0${range.endLine}\0${sha256}`),
    origin: "official_documentation",
    url: url.href,
    version: candidate.version,
    cached: candidate.cached,
    startLine: range.startLine,
    endLine: range.endLine,
    sha256,
    reason: candidate.reason,
    content: selected,
    redactions: redacted.redactions.filter((finding) => finding.line >= range.startLine && finding.line <= range.endLine),
    untrusted: true,
  };
}

/**
 * Human-to-code role: select the least-privilege project evidence the model may
 * use to turn a reviewed request into code. Selection is deterministic, performs
 * no network access, and never executes or imports project code.
 */
export async function selectContext(options: ContextSelectionOptions): Promise<ContextManifestV1> {
  if (!/^[a-f0-9]{64}$/u.test(options.projectFingerprint)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "projectFingerprint must be a lowercase SHA-256 digest.");
  }
  const root = resolve(options.root);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    throw new ContextSecurityError("INVALID_ROOT", `Cannot inspect context root: ${String(error)}`);
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ContextSecurityError("INVALID_ROOT", "Context root must be a real directory.");
  }
  const realRoot = await realpath(root);
  const budget = validateBudget(options.budget);
  const offline = options.offline ?? false;
  const policy = options.secretPolicy ?? "block";
  if (typeof offline !== "boolean" || !["block", "redact"].includes(policy)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context offline or secret policy option is invalid.");
  }
  const allowedHosts = options.officialDocumentationHosts ?? [...DEFAULT_OFFICIAL_DOCUMENTATION_HOSTS];
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/iu.test(host))) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Official documentation hosts must be a non-empty hostname allowlist.");
  }
  if (!Array.isArray(options.candidates)) {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidates must be an array.");
  }
  let candidates: ContextCandidateV1[];
  try {
    candidates = structuredClone(options.candidates);
  } catch {
    throw new ContextSecurityError("INVALID_CANDIDATE", "Context candidates must contain cloneable JSON-like data only.");
  }
  candidates.forEach(assertCandidateShape);
  const evidence: ContextEvidenceV1[] = [];
  const exclusions: ContextExclusionV1[] = [];
  const seen = new Set<string>();
  let usedBytes = 0;
  let usedTokens = 0;

  for (const candidate of candidates.sort(compareCandidates)) {
    const location = candidateLocation(candidate);
    const identity = `${candidate.origin}\0${location}\0${candidate.range?.startLine ?? 1}\0${candidate.range?.endLine ?? "end"}`;
    if (seen.has(identity)) {
      exclusions.push({ location, code: "DUPLICATE", reason: "Duplicate candidate was deterministically omitted." });
      continue;
    }
    seen.add(identity);

    let item: ContextEvidenceV1;
    try {
      item = candidate.origin === "official_documentation"
        ? readDocumentationCandidate(candidate, offline, policy, allowedHosts)
        : await readLocalCandidate(realRoot, candidate, policy);
    } catch (error) {
      if (candidate.required || error instanceof ContextSecurityError && ["PATH_ESCAPE", "PROTECTED_PATH", "SYMLINK_BLOCKED", "SECRET_DETECTED", "DOCUMENTATION_BLOCKED"].includes(error.code)) {
        throw error;
      }
      exclusions.push({
        location,
        code: error instanceof ContextSecurityError && error.code === "BUDGET_EXCEEDED" ? "BUDGET" : "OPTIONAL_UNAVAILABLE",
        reason: error instanceof Error ? error.message : "Candidate unavailable.",
      });
      continue;
    }

    const bytes = Buffer.byteLength(item.content, "utf8");
    const tokens = estimatedTokens(item.content);
    const over = bytes > budget.maxBytesPerItem
      || evidence.length + 1 > budget.maxItems
      || usedBytes + bytes > budget.maxBytes
      || usedTokens + tokens > budget.maxEstimatedTokens;
    if (over) {
      if (candidate.required) {
        throw new ContextSecurityError("BUDGET_EXCEEDED", `Required context '${location}' does not fit the configured budget.`, location);
      }
      exclusions.push({ location, code: "BUDGET", reason: "Candidate did not fit the configured context budget." });
      continue;
    }
    if (item.content.length === 0) {
      if (candidate.required) throw new ContextSecurityError("INVALID_CANDIDATE", `Required context '${location}' is empty.`, location);
      exclusions.push({ location, code: "EMPTY", reason: "Empty candidate was omitted." });
      continue;
    }
    evidence.push(item);
    usedBytes += bytes;
    usedTokens += tokens;
  }

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    projectFingerprint: options.projectFingerprint,
    offline,
    evidence,
    exclusions,
    budget: {
      ...budget,
      usedItems: evidence.length,
      usedBytes,
      usedEstimatedTokens: usedTokens,
    },
    redactionCount: evidence.reduce((sum, item) => sum + item.redactions.length, 0),
  };
}

export type ContextRequestKind = "symbol" | "file" | "dependency-doc" | "diagnostic";

export interface ContextRequestV1 {
  schemaVersion: 1;
  requestId: string;
  kind: ContextRequestKind;
  workspace: string;
  query: string;
  reason: string;
  maxItems: number;
  /** Required by strict tool schemas; null unless kind is `file`. */
  path: string | null;
}

const CONTEXT_REQUEST_KINDS: readonly ContextRequestKind[] = ["symbol", "file", "dependency-doc", "diagnostic"];
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Exact-schema validator for compiler-agent context tool calls. */
export function validateContextRequestV1(value: unknown): ContextRequestV1 {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, code: ValidationIssue["code"], message: string): void => { issues.push({ path, code, message }); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError([{ path: "$contextRequest", code: "TYPE", message: "must be an object." }]);
  }
  const record = value as Record<string, unknown>;
  const required = ["schemaVersion", "requestId", "kind", "workspace", "query", "reason", "maxItems", "path"];
  const allowed = new Set(required);
  Object.keys(record).forEach((key) => { if (!allowed.has(key)) issue(`$contextRequest.${key}`, "UNKNOWN_KEY", "is not allowed."); });
  required.forEach((key) => { if (!Object.hasOwn(record, key)) issue(`$contextRequest.${key}`, "MISSING", "is required."); });
  if (record.schemaVersion !== 1) issue("$contextRequest.schemaVersion", "VALUE", "must equal 1.");
  if (typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId)) issue("$contextRequest.requestId", "VALUE", "must be a bounded identifier.");
  if (typeof record.kind !== "string" || !CONTEXT_REQUEST_KINDS.includes(record.kind as ContextRequestKind)) issue("$contextRequest.kind", "VALUE", `must be one of: ${CONTEXT_REQUEST_KINDS.join(", ")}.`);
  if (typeof record.workspace !== "string" || (record.workspace !== "." && !isSafeRelativePath(record.workspace))) issue("$contextRequest.workspace", "VALUE", "must be a confined workspace id/path.");
  for (const key of ["query", "reason"] as const) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0 || record[key].length > 4096) issue(`$contextRequest.${key}`, "VALUE", "must be a non-empty string of at most 4096 characters.");
  }
  if (!Number.isSafeInteger(record.maxItems) || (record.maxItems as number) < 1 || (record.maxItems as number) > 20) issue("$contextRequest.maxItems", "VALUE", "must be an integer from 1 to 20.");
  if (record.path !== null && (typeof record.path !== "string" || record.path.length > 4096 || !isSafeRelativePath(record.path) || isProtectedContextPath(record.path))) issue("$contextRequest.path", "UNAUTHORIZED", "must be null or a non-protected confined path.");
  if (record.kind === "file" && typeof record.path !== "string") issue("$contextRequest.path", "MISSING", "must be a path for file requests.");
  if (record.kind !== "file" && record.path !== null) issue("$contextRequest.path", "VALUE", "must be null for non-file requests.");
  if (typeof record.query === "string" && /(?:secrets?\.human|\.env\b|private[_ -]?key|credential|password)/iu.test(record.query)) issue("$contextRequest.query", "UNAUTHORIZED", "may not request credentials or protected content.");
  if (issues.length > 0) throw new ArtifactValidationError(issues);
  return value as ContextRequestV1;
}

export class ContextRequestLimitError extends Error {
  readonly maximum: number;

  constructor(maximum: number) {
    super(`The compiler agent may make at most ${maximum} context requests.`);
    this.name = "ContextRequestLimitError";
    this.maximum = maximum;
  }
}

/** Stateful per-run gate: validate first, then count, with a hard maximum of 8. */
export class ContextRequestSession {
  readonly maximum: number;
  readonly #accepted: ContextRequestV1[] = [];

  constructor(maximum = 8) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) {
      throw new RangeError("Context request maximum must be an integer from 1 to 8.");
    }
    this.maximum = maximum;
  }

  accept(value: unknown): ContextRequestV1 {
    const request = validateContextRequestV1(value);
    if (this.#accepted.length >= this.maximum) throw new ContextRequestLimitError(this.maximum);
    if (this.#accepted.some((existing) => existing.requestId === request.requestId)) {
      throw new ArtifactValidationError([{ path: "$contextRequest.requestId", code: "DUPLICATE", message: "was already used in this run." }]);
    }
    this.#accepted.push(structuredClone(request));
    return request;
  }

  get count(): number {
    return this.#accepted.length;
  }

  get remaining(): number {
    return this.maximum - this.count;
  }

  get accepted(): readonly ContextRequestV1[] {
    return structuredClone(this.#accepted);
  }
}

/** Exact validator for context manifests loaded from disk or a run store. */
export function validateContextManifestV1(value: unknown): ContextManifestV1 {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, code: ValidationIssue["code"], message: string): void => { issues.push({ path, code, message }); };
  const asRecord = (input: unknown, path: string): Record<string, unknown> | undefined => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      issue(path, "TYPE", "must be an object.");
      return undefined;
    }
    return input as Record<string, unknown>;
  };
  const exact = (record: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void => {
    const allowed = new Set([...required, ...optional]);
    Object.keys(record).forEach((key) => { if (!allowed.has(key)) issue(`${path}.${key}`, "UNKNOWN_KEY", "is not allowed."); });
    required.forEach((key) => { if (!Object.hasOwn(record, key)) issue(`${path}.${key}`, "MISSING", "is required."); });
  };
  const record = asRecord(value, "$contextManifest");
  if (!record) throw new ArtifactValidationError(issues);
  exact(record, "$contextManifest", ["schemaVersion", "projectFingerprint", "offline", "evidence", "exclusions", "budget", "redactionCount"]);
  if (record.schemaVersion !== 1) issue("$contextManifest.schemaVersion", "VALUE", "must equal 1.");
  if (typeof record.projectFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.projectFingerprint)) issue("$contextManifest.projectFingerprint", "VALUE", "must be a lowercase SHA-256 digest.");
  if (typeof record.offline !== "boolean") issue("$contextManifest.offline", "TYPE", "must be boolean.");

  let calculatedRedactions = 0;
  let calculatedBytes = 0;
  let calculatedTokens = 0;
  const evidenceIds = new Set<string>();
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  if (!Array.isArray(record.evidence)) issue("$contextManifest.evidence", "TYPE", "must be an array.");
  evidence.forEach((raw, index) => {
    const path = `$contextManifest.evidence[${index}]`;
    const item = asRecord(raw, path);
    if (!item) return;
    const official = item.origin === "official_documentation";
    const required = official
      ? ["id", "origin", "url", "version", "cached", "startLine", "endLine", "sha256", "reason", "content", "redactions", "untrusted"]
      : ["id", "origin", "path", "startLine", "endLine", "sha256", "reason", "content", "redactions", "untrusted"];
    exact(item, path, required, official ? [] : ["version"]);
    const localOrigins: readonly string[] = ["project", "dependency", "private_documentation", "diagnostic"];
    if (typeof item.origin !== "string" || !(official || localOrigins.includes(item.origin))) issue(`${path}.origin`, "VALUE", "has an unsupported context origin.");
    if (typeof item.id !== "string" || !/^[a-f0-9]{64}$/u.test(item.id)) issue(`${path}.id`, "VALUE", "must be a lowercase SHA-256 identifier.");
    else if (evidenceIds.has(item.id)) issue(`${path}.id`, "DUPLICATE", "must be unique.");
    else evidenceIds.add(item.id);
    if (!Number.isSafeInteger(item.startLine) || (item.startLine as number) < 1) issue(`${path}.startLine`, "VALUE", "must be a positive integer.");
    if (!Number.isSafeInteger(item.endLine) || (item.endLine as number) < (item.startLine as number)) issue(`${path}.endLine`, "VALUE", "must be an integer no earlier than startLine.");
    if (typeof item.reason !== "string" || item.reason.trim().length === 0 || item.reason.length > 4096) issue(`${path}.reason`, "VALUE", "must be a non-empty bounded reason.");
    if (item.untrusted !== true) issue(`${path}.untrusted`, "VALUE", "must be true; context never becomes policy.");
    if (typeof item.content !== "string") issue(`${path}.content`, "TYPE", "must be a string.");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) issue(`${path}.sha256`, "VALUE", "must be a lowercase SHA-256 digest.");
    if (typeof item.content === "string") {
      calculatedBytes += Buffer.byteLength(item.content, "utf8");
      calculatedTokens += estimatedTokens(item.content);
      if (item.sha256 !== sha256Text(item.content)) issue(`${path}.sha256`, "VALUE", "does not match selected content.");
      if (Number.isSafeInteger(item.startLine) && Number.isSafeInteger(item.endLine)
        && item.content.split("\n").length !== (item.endLine as number) - (item.startLine as number) + 1) {
        issue(`${path}.content`, "VALUE", "line count does not match its exact range.");
      }
      if (scanSecrets(item.content).length > 0) issue(`${path}.content`, "UNAUTHORIZED", "contains credential-like content.");
    }
    if (official) {
      if (typeof item.url !== "string") issue(`${path}.url`, "TYPE", "must be a string.");
      else {
        try {
          const url = new URL(item.url);
          if (url.protocol !== "https:" || url.username || url.password || url.hash) issue(`${path}.url`, "VALUE", "must be canonical credential-free HTTPS without a fragment.");
        } catch {
          issue(`${path}.url`, "VALUE", "must be a valid URL.");
        }
      }
      if (typeof item.version !== "string" || item.version.trim().length === 0) issue(`${path}.version`, "VALUE", "must identify the documented version.");
      if (typeof item.cached !== "boolean") issue(`${path}.cached`, "TYPE", "must be boolean.");
      if (record.offline === true && item.cached !== true) issue(`${path}.cached`, "VALUE", "must be true for an offline manifest.");
    } else {
      if (typeof item.path !== "string" || !isSafeRelativePath(item.path) || isProtectedContextPath(item.path)) issue(`${path}.path`, "UNAUTHORIZED", "must be a non-protected confined path.");
      if (item.version !== undefined && (typeof item.version !== "string" || item.version.trim().length === 0)) issue(`${path}.version`, "VALUE", "must be non-empty when present.");
    }
    const redactions = Array.isArray(item.redactions) ? item.redactions : [];
    if (!Array.isArray(item.redactions)) issue(`${path}.redactions`, "TYPE", "must be an array.");
    calculatedRedactions += redactions.length;
    redactions.forEach((rawRedaction, redactionIndex) => {
      const redactionPath = `${path}.redactions[${redactionIndex}]`;
      const redaction = asRecord(rawRedaction, redactionPath);
      if (!redaction) return;
      exact(redaction, redactionPath, ["kind", "line"]);
      if (!["private_key", "aws_access_key", "api_token", "github_token", "google_api_key", "credential_assignment", "credential_url"].includes(String(redaction.kind))) issue(`${redactionPath}.kind`, "VALUE", "has an unsupported redaction kind.");
      if (!Number.isSafeInteger(redaction.line) || (redaction.line as number) < (item.startLine as number) || (redaction.line as number) > (item.endLine as number)) issue(`${redactionPath}.line`, "VALUE", "must fall inside the evidence range.");
    });
    if (typeof item.id === "string" && typeof item.sha256 === "string"
      && typeof item.startLine === "number" && typeof item.endLine === "number") {
      const expectedId = official && typeof item.url === "string" && typeof item.version === "string"
        ? sha256Text(`official_documentation\0${item.url}\0${item.version}\0${item.startLine}\0${item.endLine}\0${item.sha256}`)
        : !official && typeof item.origin === "string" && typeof item.path === "string"
          ? sha256Text(`${item.origin}\0${item.path}\0${item.startLine}\0${item.endLine}\0${item.sha256}`)
          : undefined;
      if (expectedId !== undefined && item.id !== expectedId) issue(`${path}.id`, "VALUE", "does not match the evidence provenance fields.");
    }
  });

  const exclusions = Array.isArray(record.exclusions) ? record.exclusions : [];
  if (!Array.isArray(record.exclusions)) issue("$contextManifest.exclusions", "TYPE", "must be an array.");
  exclusions.forEach((raw, index) => {
    const path = `$contextManifest.exclusions[${index}]`;
    const exclusion = asRecord(raw, path);
    if (!exclusion) return;
    exact(exclusion, path, ["location", "code", "reason"]);
    if (typeof exclusion.location !== "string" || exclusion.location.length === 0) issue(`${path}.location`, "VALUE", "must be non-empty.");
    if (!["DUPLICATE", "BUDGET", "EMPTY", "OPTIONAL_UNAVAILABLE"].includes(String(exclusion.code))) issue(`${path}.code`, "VALUE", "has an unsupported exclusion code.");
    if (typeof exclusion.reason !== "string" || exclusion.reason.trim().length === 0) issue(`${path}.reason`, "VALUE", "must be non-empty.");
  });

  const budget = asRecord(record.budget, "$contextManifest.budget");
  if (budget) {
    const keys = ["maxItems", "maxBytes", "maxEstimatedTokens", "maxBytesPerItem", "usedItems", "usedBytes", "usedEstimatedTokens"];
    exact(budget, "$contextManifest.budget", keys);
    keys.forEach((key) => {
      const minimum = key.startsWith("max") ? 1 : 0;
      if (!Number.isSafeInteger(budget[key]) || (budget[key] as number) < minimum) issue(`$contextManifest.budget.${key}`, "VALUE", `must be a safe integer of at least ${minimum}.`);
    });
    if (budget.usedItems !== evidence.length) issue("$contextManifest.budget.usedItems", "VALUE", "does not match evidence length.");
    if (budget.usedBytes !== calculatedBytes) issue("$contextManifest.budget.usedBytes", "VALUE", "does not match evidence bytes.");
    if (budget.usedEstimatedTokens !== calculatedTokens) issue("$contextManifest.budget.usedEstimatedTokens", "VALUE", "does not match evidence token estimate.");
    if (typeof budget.usedItems === "number" && typeof budget.maxItems === "number" && budget.usedItems > budget.maxItems) issue("$contextManifest.budget.usedItems", "VALUE", "exceeds maxItems.");
    if (typeof budget.usedBytes === "number" && typeof budget.maxBytes === "number" && budget.usedBytes > budget.maxBytes) issue("$contextManifest.budget.usedBytes", "VALUE", "exceeds maxBytes.");
    if (typeof budget.usedEstimatedTokens === "number" && typeof budget.maxEstimatedTokens === "number" && budget.usedEstimatedTokens > budget.maxEstimatedTokens) issue("$contextManifest.budget.usedEstimatedTokens", "VALUE", "exceeds maxEstimatedTokens.");
    if (typeof budget.maxBytesPerItem === "number" && typeof budget.maxBytes === "number" && budget.maxBytesPerItem > budget.maxBytes) issue("$contextManifest.budget.maxBytesPerItem", "VALUE", "cannot exceed maxBytes.");
    if (typeof budget.maxBytesPerItem === "number" && evidence.some((item) => typeof item === "object" && item !== null && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).content === "string"
      && Buffer.byteLength((item as Record<string, unknown>).content as string, "utf8") > (budget.maxBytesPerItem as number))) {
      issue("$contextManifest.budget.maxBytesPerItem", "VALUE", "is smaller than an included evidence item.");
    }
  }
  if (!Number.isSafeInteger(record.redactionCount) || record.redactionCount !== calculatedRedactions) issue("$contextManifest.redactionCount", "VALUE", "must equal the exact number of evidence redactions.");
  if (issues.length > 0) throw new ArtifactValidationError(issues);
  return value as ContextManifestV1;
}

export function hashContextManifest(manifest: ContextManifestV1): string {
  return hashCanonical(validateContextManifestV1(manifest));
}
