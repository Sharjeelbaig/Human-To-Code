/**
 * Versioned, provider-neutral artifacts for the Human-to-Code pipeline.
 *
 * This module deliberately has no dependency on an LLM SDK.  Artifacts are
 * plain JSON values, are validated with an exact-key policy, and are hashed
 * using a canonical representation so they can be persisted and audited.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Canonical JSON (RFC 8785-style key ordering, with stricter JSON inputs). */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();

  const visit = (input: unknown, path: string): string => {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new TypeError(`${path} contains a non-finite number.`);
      }
      return Object.is(input, -0) ? "0" : JSON.stringify(input);
    }
    if (typeof input !== "object") {
      throw new TypeError(`${path} is not a JSON value.`);
    }
    if (active.has(input)) {
      throw new TypeError(`${path} contains a circular reference.`);
    }

    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Reflect.ownKeys(input).some((key) => typeof key === "symbol")) {
          throw new TypeError(`${path} has symbol-keyed array properties.`);
        }
        const values: string[] = [];
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.hasOwn(input, index)) {
            throw new TypeError(`${path}[${index}] is a sparse array entry, not a JSON value.`);
          }
          values.push(visit(input[index], `${path}[${index}]`));
        }
        const extraKeys = Object.keys(input).filter((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key));
        if (extraKeys.length > 0) {
          throw new TypeError(`${path} has non-index array properties.`);
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must contain only plain JSON objects.`);
      }
      const record = input as Record<string, unknown>;
      const ownKeys = Reflect.ownKeys(record);
      if (ownKeys.some((key) => typeof key === "symbol")
        || ownKeys.some((key) => typeof key === "string" && !Object.prototype.propertyIsEnumerable.call(record, key))) {
        throw new TypeError(`${path} must not contain symbol or non-enumerable properties.`);
      }
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(record[key], `${path}.${key}`)}`)
        .join(",")}}`;
    } finally {
      active.delete(input);
    }
  };

  return visit(value, "$ ".trim());
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export type RunStatus =
  | "VERIFIED"
  | "NEEDS_INPUT"
  | "UNSUPPORTED"
  | "INCONCLUSIVE"
  | "FAILED"
  | "SECURITY_BLOCKED";

export type PatchOperationKind = "create" | "edit" | "delete" | "rename";

export type RiskCategory =
  | "dependency_change"
  | "lockfile_change"
  | "database_migration"
  | "public_api_break"
  | "authentication_change"
  | "unsafe_rust"
  | "ffi"
  | "validation_config_change";

export interface FileDigestV1 {
  path: string;
  sha256: string;
}

export interface RequirementV1 {
  id: string;
  description: string;
}

export interface AcceptanceCriteriaV1 {
  automated: string[];
  manual: string[];
}

export interface ChangeScopeV1 {
  allowedPaths: string[];
  allowedOperations: PatchOperationKind[];
  prohibitedPaths: string[];
}

export interface RiskAssessmentV1 {
  category: RiskCategory;
  reason: string;
}

export interface UnresolvedQuestionV1 {
  id: string;
  question: string;
  material: boolean;
}

export interface ChangeContractV1 {
  schemaVersion: 1;
  source: FileDigestV1;
  projectFingerprint: string;
  targetWorkspaces: string[];
  targetSymbols: string[];
  requirements: RequirementV1[];
  acceptanceCriteria: AcceptanceCriteriaV1;
  scope: ChangeScopeV1;
  prohibitedChanges: string[];
  risks: RiskAssessmentV1[];
  authorizedRisks: RiskCategory[];
  unresolvedQuestions: UnresolvedQuestionV1[];
}

export interface CreatePatchOperationV1 {
  kind: "create";
  path: string;
  content: string;
}

export interface EditPatchOperationV1 {
  kind: "edit";
  path: string;
  baseHash: string;
  oldText: string;
  newText: string;
}

export interface DeletePatchOperationV1 {
  kind: "delete";
  path: string;
  baseHash: string;
}

export interface RenamePatchOperationV1 {
  kind: "rename";
  from: string;
  path: string;
  baseHash: string;
}

export type PatchOperationV1 =
  | CreatePatchOperationV1
  | EditPatchOperationV1
  | DeletePatchOperationV1
  | RenamePatchOperationV1;

/** Backwards-compatible short name used by patch preparation code. */
export type PatchOperation = PatchOperationV1;

export interface PatchSetV1 {
  schemaVersion: 1;
  contractHash: string;
  snapshotHash: string;
  operations: PatchOperationV1[];
  requirementIds: string[];
  proposedTests: string[];
}

export type ValidationCategory =
  | "format"
  | "lint"
  | "typecheck"
  | "test"
  | "build"
  | "integration"
  | "security";

export interface ValidationCommandV1 {
  id: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  category: ValidationCategory;
}

export interface ValidationPlanV1 {
  schemaVersion: 1;
  profileFingerprint: string;
  commands: ValidationCommandV1[];
  manualChecks: string[];
}

export type ValidationCommandStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "error";

export interface ValidationCommandResultV1 {
  id: string;
  status: ValidationCommandStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  flaky: boolean;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface RepairAttemptV1 {
  attempt: number;
  diagnostics: string[];
  patchHash?: string;
}

export interface ManualCheckResultV1 {
  description: string;
  status: "passed" | "failed" | "pending" | "not_applicable";
  evidence?: string;
}

export interface ValidationReportV1 {
  schemaVersion: 1;
  status: "validated" | "non_regression_only" | "unvalidated" | "failed";
  sandbox: "strong" | "degraded" | "none";
  baseline: ValidationCommandResultV1[];
  candidate: ValidationCommandResultV1[];
  repairs: RepairAttemptV1[];
  manualChecks: ManualCheckResultV1[];
  diagnostics: string[];
  startedAt: string;
  finishedAt: string;
}

export interface ProviderIdentityV1 {
  name: string;
  requestedModel: string;
  resolvedModel: string;
  requestIds: string[];
}

export interface UsageSummaryV1 {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  repairs?: number;
  costUsd?: number;
}

export interface RunRecordV1 {
  runId: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  root: string;
  status: RunStatus;
  contractHash?: string;
  contextManifestHash?: string;
  patchHash?: string;
  validationReportHash?: string;
  provider?: ProviderIdentityV1;
  usage?: UsageSummaryV1;
  diagnostics: string[];
}

export interface ValidationIssue {
  path: string;
  code:
    | "TYPE"
    | "UNKNOWN_KEY"
    | "MISSING"
    | "VALUE"
    | "DUPLICATE"
    | "UNRESOLVED"
    | "UNAUTHORIZED"
    | "OUT_OF_SCOPE";
  message: string;
}

export class ArtifactValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ArtifactValidationError";
    this.issues = issues;
  }
}

type RecordValue = Record<string, unknown>;

class Inspector {
  readonly issues: ValidationIssue[] = [];

  issue(path: string, code: ValidationIssue["code"], message: string): void {
    this.issues.push({ path, code, message });
  }

  record(value: unknown, path: string): RecordValue | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.issue(path, "TYPE", "must be an object.");
      return undefined;
    }
    return value as RecordValue;
  }

  exact(record: RecordValue, path: string, required: readonly string[], optional: readonly string[] = []): void {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) this.issue(`${path}.${key}`, "UNKNOWN_KEY", "is not allowed.");
    }
    for (const key of required) {
      if (!Object.hasOwn(record, key)) this.issue(`${path}.${key}`, "MISSING", "is required.");
    }
  }

  string(value: unknown, path: string, options: { nonEmpty?: boolean; max?: number } = {}): value is string {
    if (typeof value !== "string") {
      this.issue(path, "TYPE", "must be a string.");
      return false;
    }
    if (options.nonEmpty && value.trim().length === 0) this.issue(path, "VALUE", "must not be empty.");
    if (options.max !== undefined && value.length > options.max) this.issue(path, "VALUE", `must be at most ${options.max} characters.`);
    return true;
  }

  boolean(value: unknown, path: string): value is boolean {
    if (typeof value !== "boolean") {
      this.issue(path, "TYPE", "must be a boolean.");
      return false;
    }
    return true;
  }

  integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      this.issue(path, "VALUE", `must be an integer from ${min} to ${max}.`);
      return false;
    }
    return true;
  }

  array(value: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.issue(path, "TYPE", "must be an array.");
      return undefined;
    }
    return value;
  }

  enum<T extends string>(value: unknown, path: string, values: readonly T[]): value is T {
    if (typeof value !== "string" || !values.includes(value as T)) {
      this.issue(path, "VALUE", `must be one of: ${values.join(", ")}.`);
      return false;
    }
    return true;
  }

  finish(): void {
    if (this.issues.length > 0) throw new ArtifactValidationError(this.issues);
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const PATCH_KINDS = ["create", "edit", "delete", "rename"] as const;
const RISK_CATEGORIES: readonly RiskCategory[] = [
  "dependency_change",
  "lockfile_change",
  "database_migration",
  "public_api_break",
  "authentication_change",
  "unsafe_rust",
  "ffi",
  "validation_config_change",
];

function inspectSchemaVersion(i: Inspector, record: RecordValue, path: string): void {
  if (record.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    i.issue(`${path}.schemaVersion`, "VALUE", "must equal 1.");
  }
}

function inspectSha(i: Inspector, value: unknown, path: string): void {
  if (!i.string(value, path) || !SHA256.test(value)) {
    if (typeof value === "string") i.issue(path, "VALUE", "must be a lowercase SHA-256 hex digest.");
  }
}

/** Paths in contracts and patches are always root-relative POSIX paths. */
export function isSafeRelativePath(path: string, allowPattern = false): boolean {
  if (path.length === 0 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path)
    || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  const plain = allowPattern ? path.replaceAll("*", "x") : path;
  const normalized = posix.normalize(plain);
  return normalized !== ".." && !normalized.startsWith("../") && normalized !== "." && !plain.split("/").includes("..");
}

function inspectPath(i: Inspector, value: unknown, path: string, allowPattern = false, allowRoot = false): void {
  if (i.string(value, path, { nonEmpty: true, max: 4096 }) && !(allowRoot && value === ".") && !isSafeRelativePath(value, allowPattern)) {
    i.issue(path, "VALUE", "must be a confined, root-relative POSIX path.");
  }
}

function inspectStringArray(
  i: Inspector,
  value: unknown,
  path: string,
  options: { nonEmptyItems?: boolean; unique?: boolean; pathItems?: boolean; patternPaths?: boolean } = {},
): string[] {
  const result: string[] = [];
  const array = i.array(value, path);
  if (!array) return result;
  array.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (options.pathItems) inspectPath(i, item, itemPath, options.patternPaths);
    else i.string(item, itemPath, { nonEmpty: options.nonEmptyItems, max: 16_384 });
    if (typeof item === "string") result.push(item);
  });
  if (options.unique) {
    const seen = new Set<string>();
    result.forEach((item, index) => {
      if (seen.has(item)) i.issue(`${path}[${index}]`, "DUPLICATE", "must be unique.");
      seen.add(item);
    });
  }
  return result;
}

function inspectId(i: Inspector, value: unknown, path: string): void {
  if (i.string(value, path, { nonEmpty: true, max: 128 }) && !ID.test(value)) {
    i.issue(path, "VALUE", "contains unsupported characters.");
  }
}

function inspectWorkspaceId(i: Inspector, value: unknown, path: string): void {
  if (i.string(value, path, { nonEmpty: true, max: 512 })
    && (!WORKSPACE_ID.test(value) || value.includes("\0") || value.split("/").includes(".."))) {
    i.issue(path, "VALUE", "must be a bounded analyzer workspace identifier.");
  }
}

function inspectTimestamp(i: Inspector, value: unknown, path: string): void {
  if (i.string(value, path, { nonEmpty: true })
    && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
      || !Number.isFinite(Date.parse(value)))) {
    i.issue(path, "VALUE", "must be an ISO-8601 timestamp.");
  }
}

function inspectFileDigest(i: Inspector, value: unknown, path: string): void {
  const record = i.record(value, path);
  if (!record) return;
  i.exact(record, path, ["path", "sha256"]);
  inspectPath(i, record.path, `${path}.path`);
  inspectSha(i, record.sha256, `${path}.sha256`);
}

export function validateChangeContractV1(value: unknown): ChangeContractV1 {
  const i = new Inspector();
  const record = i.record(value, "$contract");
  if (!record) {
    i.finish();
    throw new Error("unreachable");
  }
  i.exact(record, "$contract", [
    "schemaVersion", "source", "projectFingerprint", "targetWorkspaces", "targetSymbols",
    "requirements", "acceptanceCriteria", "scope", "prohibitedChanges", "risks",
    "authorizedRisks", "unresolvedQuestions",
  ]);
  inspectSchemaVersion(i, record, "$contract");
  inspectFileDigest(i, record.source, "$contract.source");
  inspectSha(i, record.projectFingerprint, "$contract.projectFingerprint");
  const targetWorkspaces = inspectStringArray(i, record.targetWorkspaces, "$contract.targetWorkspaces", { nonEmptyItems: true, unique: true });
  targetWorkspaces.forEach((workspace, index) => inspectWorkspaceId(i, workspace, `$contract.targetWorkspaces[${index}]`));
  if (targetWorkspaces.length === 0) i.issue("$contract.targetWorkspaces", "VALUE", "must identify at least one workspace.");
  inspectStringArray(i, record.targetSymbols, "$contract.targetSymbols", { nonEmptyItems: true, unique: true });

  const requirements = i.array(record.requirements, "$contract.requirements");
  const requirementIds = new Set<string>();
  requirements?.forEach((raw, index) => {
    const path = `$contract.requirements[${index}]`;
    const requirement = i.record(raw, path);
    if (!requirement) return;
    i.exact(requirement, path, ["id", "description"]);
    inspectId(i, requirement.id, `${path}.id`);
    i.string(requirement.description, `${path}.description`, { nonEmpty: true, max: 16_384 });
    if (typeof requirement.id === "string") {
      if (requirementIds.has(requirement.id)) i.issue(`${path}.id`, "DUPLICATE", "must be unique.");
      requirementIds.add(requirement.id);
    }
  });
  if (requirements?.length === 0) i.issue("$contract.requirements", "VALUE", "must contain at least one requirement.");

  const acceptance = i.record(record.acceptanceCriteria, "$contract.acceptanceCriteria");
  if (acceptance) {
    i.exact(acceptance, "$contract.acceptanceCriteria", ["automated", "manual"]);
    const automated = inspectStringArray(i, acceptance.automated, "$contract.acceptanceCriteria.automated", { nonEmptyItems: true, unique: true });
    const manual = inspectStringArray(i, acceptance.manual, "$contract.acceptanceCriteria.manual", { nonEmptyItems: true, unique: true });
    if (automated.length + manual.length === 0) i.issue("$contract.acceptanceCriteria", "VALUE", "must contain at least one acceptance criterion.");
  }

  const scope = i.record(record.scope, "$contract.scope");
  if (scope) {
    i.exact(scope, "$contract.scope", ["allowedPaths", "allowedOperations", "prohibitedPaths"]);
    const allowed = inspectStringArray(i, scope.allowedPaths, "$contract.scope.allowedPaths", { nonEmptyItems: true, unique: true, pathItems: true, patternPaths: true });
    if (allowed.length === 0) i.issue("$contract.scope.allowedPaths", "VALUE", "must contain at least one path.");
  const operations = i.array(scope.allowedOperations, "$contract.scope.allowedOperations");
    const seenOperations = new Set<string>();
    operations?.forEach((operation, index) => {
      i.enum(operation, `$contract.scope.allowedOperations[${index}]`, PATCH_KINDS);
      if (typeof operation === "string") {
        if (seenOperations.has(operation)) i.issue(`$contract.scope.allowedOperations[${index}]`, "DUPLICATE", "must be unique.");
        seenOperations.add(operation);
      }
    });
    if (operations?.length === 0) i.issue("$contract.scope.allowedOperations", "VALUE", "must contain at least one operation.");
    inspectStringArray(i, scope.prohibitedPaths, "$contract.scope.prohibitedPaths", { nonEmptyItems: true, unique: true, pathItems: true, patternPaths: true });
  }
  inspectStringArray(i, record.prohibitedChanges, "$contract.prohibitedChanges", { nonEmptyItems: true, unique: true });

  const authorized = i.array(record.authorizedRisks, "$contract.authorizedRisks");
  const authorizedSet = new Set<string>();
  authorized?.forEach((risk, index) => {
    i.enum(risk, `$contract.authorizedRisks[${index}]`, RISK_CATEGORIES);
    if (typeof risk === "string") {
      if (authorizedSet.has(risk)) i.issue(`$contract.authorizedRisks[${index}]`, "DUPLICATE", "must be unique.");
      authorizedSet.add(risk);
    }
  });

  const risks = i.array(record.risks, "$contract.risks");
  const assessed = new Set<string>();
  risks?.forEach((raw, index) => {
    const path = `$contract.risks[${index}]`;
    const risk = i.record(raw, path);
    if (!risk) return;
    i.exact(risk, path, ["category", "reason"]);
    i.enum(risk.category, `${path}.category`, RISK_CATEGORIES);
    i.string(risk.reason, `${path}.reason`, { nonEmpty: true, max: 4096 });
    if (typeof risk.category === "string") assessed.add(risk.category);
  });
  authorizedSet.forEach((risk) => {
    if (!assessed.has(risk)) i.issue("$contract.authorizedRisks", "UNAUTHORIZED", `risk '${risk}' must have a matching assessment.`);
  });

  const questions = i.array(record.unresolvedQuestions, "$contract.unresolvedQuestions");
  const questionIds = new Set<string>();
  questions?.forEach((raw, index) => {
    const path = `$contract.unresolvedQuestions[${index}]`;
    const question = i.record(raw, path);
    if (!question) return;
    i.exact(question, path, ["id", "question", "material"]);
    inspectId(i, question.id, `${path}.id`);
    i.string(question.question, `${path}.question`, { nonEmpty: true, max: 8192 });
    i.boolean(question.material, `${path}.material`);
    if (question.material === true) i.issue(path, "UNRESOLVED", "material questions must be resolved before generation.");
    if (typeof question.id === "string") {
      if (questionIds.has(question.id)) i.issue(`${path}.id`, "DUPLICATE", "must be unique.");
      questionIds.add(question.id);
    }
  });
  i.finish();
  return value as ChangeContractV1;
}

function globMatches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const expression = escaped.replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^${expression}(?:/.*)?$`, "u").test(path);
}

function contractAllowsPath(contract: ChangeContractV1, path: string): boolean {
  return contract.scope.allowedPaths.some((pattern) => globMatches(pattern, path))
    && !contract.scope.prohibitedPaths.some((pattern) => globMatches(pattern, path));
}

const LOCKFILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock)$/u;
const DEPENDENCY_MANIFESTS = /(?:^|\/)(?:package\.json|Cargo\.toml|pyproject\.toml|Pipfile|requirements(?:-[^/]*)?\.txt)$/u;
const MIGRATIONS = /(?:^|\/)(?:migrations?|alembic|prisma\/migrations)(?:\/|$)|\.sql$/u;
const VALIDATION_CONFIG = /(?:^|\/)(?:(?:jest|vitest|eslint|biome|playwright|tsconfig|mypy|pytest|ruff|clippy)(?:\.[^/]*)?(?:\.config)?\.[^/]+|package\.json|pyproject\.toml|tox\.ini|noxfile\.py|Makefile|Justfile|Jenkinsfile|azure-pipelines\.ya?ml|\.gitlab-ci\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/iu;
const AUTH_PATH = /(?:^|\/)(?:auth|authentication|authorization|security|guards?)(?:[._/-]|$)/iu;
const UNSAFE_RUST = /\bunsafe\b/u;
const FFI = /(?:extern\s+"C"|#\s*\[\s*(?:unsafe\s*\(\s*)?no_mangle|\b(?:std|core)::ffi\b|\blibc::|\bbindgen\b)/u;

/** Paths that no reviewed contract is allowed to expose or mutate. */
export function isHardProtectedPatchPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.some((part) => [".git", ".hg", ".svn", ".human-to-code", "secrets.human", "human-to-code.config.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials", ".envrc"].includes(part.toLowerCase()))
    || parts.some((part) => /^\.env(?:\..*)?$/iu.test(part)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/iu.test(part)
      || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/iu.test(part)
      || /^(?:credentials?|secrets?)(?:\..*)?$/iu.test(part))
    || parts.some((part, index) => part.toLowerCase() === ".cargo" && /^credentials(?:\.toml)?$/iu.test(parts[index + 1] ?? ""))
    || parts.some((part, index) => part.toLowerCase() === ".docker" && (parts[index + 1] ?? "").toLowerCase() === "config.json");
}

/** Conservative, deterministic risk inference for patch authorization. */
export function inferPatchRisks(operation: PatchOperationV1): RiskCategory[] {
  const paths = operation.kind === "rename" ? [operation.from, operation.path] : [operation.path];
  const added = operation.kind === "create" ? operation.content : operation.kind === "edit" ? operation.newText : "";
  const risks = new Set<RiskCategory>();
  if (paths.some((path) => LOCKFILES.test(path))) risks.add("lockfile_change");
  if (paths.some((path) => DEPENDENCY_MANIFESTS.test(path))) risks.add("dependency_change");
  if (paths.some((path) => MIGRATIONS.test(path))) risks.add("database_migration");
  if (paths.some((path) => VALIDATION_CONFIG.test(path))) risks.add("validation_config_change");
  if (paths.some((path) => AUTH_PATH.test(path))) risks.add("authentication_change");
  if (UNSAFE_RUST.test(added)) risks.add("unsafe_rust");
  if (FFI.test(added)) risks.add("ffi");
  if (operation.kind === "delete" || operation.kind === "rename") risks.add("public_api_break");
  if (operation.kind === "edit" && /\bexport\b/u.test(operation.oldText) && !/\bexport\b/u.test(operation.newText)) risks.add("public_api_break");
  return [...risks].sort();
}

export function validatePatchSetV1(value: unknown, contract?: ChangeContractV1): PatchSetV1 {
  const i = new Inspector();
  const record = i.record(value, "$patch");
  if (!record) {
    i.finish();
    throw new Error("unreachable");
  }
  i.exact(record, "$patch", ["schemaVersion", "contractHash", "snapshotHash", "operations", "requirementIds", "proposedTests"]);
  inspectSchemaVersion(i, record, "$patch");
  inspectSha(i, record.contractHash, "$patch.contractHash");
  inspectSha(i, record.snapshotHash, "$patch.snapshotHash");

  if (contract && record.contractHash !== hashCanonical(contract)) {
    i.issue("$patch.contractHash", "VALUE", "does not match the canonical contract hash.");
  }
  const requirementIds = inspectStringArray(i, record.requirementIds, "$patch.requirementIds", { nonEmptyItems: true, unique: true });
  if (requirementIds.length === 0) i.issue("$patch.requirementIds", "VALUE", "must contain at least one requirement id.");
  inspectStringArray(i, record.proposedTests, "$patch.proposedTests", { nonEmptyItems: true, unique: true });
  if (contract) {
    const known = new Set(contract.requirements.map((requirement) => requirement.id));
    requirementIds.forEach((id, index) => {
      if (!known.has(id)) i.issue(`$patch.requirementIds[${index}]`, "VALUE", "does not identify a contract requirement.");
    });
    known.forEach((id) => {
      if (!requirementIds.includes(id)) i.issue("$patch.requirementIds", "MISSING", `does not cover requirement '${id}'.`);
    });
  }

  const operations = i.array(record.operations, "$patch.operations");
  if (operations && operations.length > 200) i.issue("$patch.operations", "VALUE", "must contain at most 200 operations.");
  const destinations = new Set<string>();
  operations?.forEach((raw, index) => {
    const path = `$patch.operations[${index}]`;
    const operation = i.record(raw, path);
    if (!operation) return;
    if (!i.enum(operation.kind, `${path}.kind`, PATCH_KINDS)) return;
    const required = operation.kind === "create"
      ? ["kind", "path", "content"]
      : operation.kind === "edit"
        ? ["kind", "path", "baseHash", "oldText", "newText"]
        : operation.kind === "delete"
          ? ["kind", "path", "baseHash"]
          : ["kind", "from", "path", "baseHash"];
    i.exact(operation, path, required);
    inspectPath(i, operation.path, `${path}.path`);
    if (operation.kind === "rename") inspectPath(i, operation.from, `${path}.from`);
    if (operation.kind !== "create") inspectSha(i, operation.baseHash, `${path}.baseHash`);
    if (operation.kind === "create") {
      i.string(operation.content, `${path}.content`, { max: 10_000_000 });
    }
    if (operation.kind === "edit") {
      i.string(operation.oldText, `${path}.oldText`, { nonEmpty: true, max: 10_000_000 });
      i.string(operation.newText, `${path}.newText`, { max: 10_000_000 });
      if (operation.oldText === operation.newText) i.issue(path, "VALUE", "edit must change text.");
    }
    if (typeof operation.path === "string") {
      if (destinations.has(operation.path)) i.issue(`${path}.path`, "DUPLICATE", "overlaps another operation destination.");
      destinations.add(operation.path);
    }

    if (contract && typeof operation.path === "string") {
      if (!contract.scope.allowedOperations.includes(operation.kind)) {
        i.issue(`${path}.kind`, "OUT_OF_SCOPE", "operation kind is not allowed by the contract.");
      }
      const affected = operation.kind === "rename" && typeof operation.from === "string"
        ? [operation.from, operation.path]
        : [operation.path];
      affected.forEach((affectedPath) => {
        if (isHardProtectedPatchPath(affectedPath)) i.issue(`${path}.path`, "UNAUTHORIZED", `'${affectedPath}' is a hard-protected credential or tool-state path.`);
        if (!contractAllowsPath(contract, affectedPath)) i.issue(`${path}.path`, "OUT_OF_SCOPE", `'${affectedPath}' is outside the contract scope.`);
      });
      const inferred = inferPatchRisks(operation as unknown as PatchOperationV1);
      inferred.forEach((risk) => {
        if (!contract.authorizedRisks.includes(risk)) {
          i.issue(path, "UNAUTHORIZED", `operation requires explicit '${risk}' authorization.`);
        }
      });
    }
    if (!contract && typeof operation.path === "string") {
      const affected = operation.kind === "rename" && typeof operation.from === "string" ? [operation.from, operation.path] : [operation.path];
      affected.forEach((affectedPath) => {
        if (isHardProtectedPatchPath(affectedPath)) i.issue(`${path}.path`, "UNAUTHORIZED", `'${affectedPath}' is a hard-protected credential or tool-state path.`);
      });
    }
  });
  if (operations?.length === 0) i.issue("$patch.operations", "VALUE", "must contain at least one operation.");
  i.finish();
  return value as PatchSetV1;
}

export function validateValidationPlanV1(value: unknown): ValidationPlanV1 {
  const i = new Inspector();
  const record = i.record(value, "$validationPlan");
  if (!record) {
    i.finish();
    throw new Error("unreachable");
  }
  i.exact(record, "$validationPlan", ["schemaVersion", "profileFingerprint", "commands", "manualChecks"]);
  inspectSchemaVersion(i, record, "$validationPlan");
  inspectSha(i, record.profileFingerprint, "$validationPlan.profileFingerprint");
  inspectStringArray(i, record.manualChecks, "$validationPlan.manualChecks", { nonEmptyItems: true, unique: true });
  const commands = i.array(record.commands, "$validationPlan.commands");
  const ids = new Set<string>();
  commands?.forEach((raw, index) => {
    const path = `$validationPlan.commands[${index}]`;
    const command = i.record(raw, path);
    if (!command) return;
    i.exact(command, path, ["id", "argv", "cwd", "timeoutMs", "required", "category"]);
    inspectId(i, command.id, `${path}.id`);
    const argv = inspectStringArray(i, command.argv, `${path}.argv`, { nonEmptyItems: true });
    if (argv.length === 0) i.issue(`${path}.argv`, "VALUE", "must contain an executable and arguments; shell strings are not accepted.");
    inspectPath(i, command.cwd, `${path}.cwd`, false, true);
    i.integer(command.timeoutMs, `${path}.timeoutMs`, 1, 3_600_000);
    i.boolean(command.required, `${path}.required`);
    i.enum(command.category, `${path}.category`, ["format", "lint", "typecheck", "test", "build", "integration", "security"]);
    if (typeof command.id === "string") {
      if (ids.has(command.id)) i.issue(`${path}.id`, "DUPLICATE", "must be unique.");
      ids.add(command.id);
    }
  });
  if (commands?.length === 0) i.issue("$validationPlan.commands", "VALUE", "must contain at least one command.");
  i.finish();
  return value as ValidationPlanV1;
}

function inspectCommandResult(i: Inspector, value: unknown, path: string): void {
  const result = i.record(value, path);
  if (!result) return;
  i.exact(result, path, ["id", "status", "exitCode", "signal", "durationMs", "stdout", "stderr", "timedOut", "flaky", "outputTruncated", "startedAt", "finishedAt"]);
  inspectId(i, result.id, `${path}.id`);
  i.enum(result.status, `${path}.status`, ["passed", "failed", "skipped", "error"]);
  if (result.exitCode !== null) i.integer(result.exitCode, `${path}.exitCode`, 0, 255);
  if (result.signal !== null) i.string(result.signal, `${path}.signal`, { nonEmpty: true, max: 64 });
  i.integer(result.durationMs, `${path}.durationMs`, 0, Number.MAX_SAFE_INTEGER);
  i.string(result.stdout, `${path}.stdout`, { max: 10_000_000 });
  i.string(result.stderr, `${path}.stderr`, { max: 10_000_000 });
  i.boolean(result.timedOut, `${path}.timedOut`);
  i.boolean(result.flaky, `${path}.flaky`);
  i.boolean(result.outputTruncated, `${path}.outputTruncated`);
  inspectTimestamp(i, result.startedAt, `${path}.startedAt`);
  inspectTimestamp(i, result.finishedAt, `${path}.finishedAt`);
  if (typeof result.startedAt === "string" && typeof result.finishedAt === "string"
    && Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
    i.issue(`${path}.finishedAt`, "VALUE", "must not precede startedAt.");
  }
  if (result.status === "passed" && (result.exitCode !== 0 || result.timedOut === true)) {
    i.issue(`${path}.status`, "VALUE", "passed results require exitCode 0 and no timeout.");
  }
}

export function validateValidationReportV1(value: unknown): ValidationReportV1 {
  const i = new Inspector();
  const record = i.record(value, "$validationReport");
  if (!record) {
    i.finish();
    throw new Error("unreachable");
  }
  i.exact(record, "$validationReport", ["schemaVersion", "status", "sandbox", "baseline", "candidate", "repairs", "manualChecks", "diagnostics", "startedAt", "finishedAt"]);
  inspectSchemaVersion(i, record, "$validationReport");
  i.enum(record.status, "$validationReport.status", ["validated", "non_regression_only", "unvalidated", "failed"]);
  i.enum(record.sandbox, "$validationReport.sandbox", ["strong", "degraded", "none"]);
  for (const field of ["baseline", "candidate"] as const) {
    i.array(record[field], `$validationReport.${field}`)?.forEach((entry, index) => inspectCommandResult(i, entry, `$validationReport.${field}[${index}]`));
  }
  const repairAttempts = new Set<number>();
  const repairs = i.array(record.repairs, "$validationReport.repairs");
  if (repairs && repairs.length > 2) i.issue("$validationReport.repairs", "VALUE", "must contain at most two repair attempts.");
  repairs?.forEach((raw, index) => {
    const path = `$validationReport.repairs[${index}]`;
    const repair = i.record(raw, path);
    if (!repair) return;
    i.exact(repair, path, ["attempt", "diagnostics"], ["patchHash"]);
    i.integer(repair.attempt, `${path}.attempt`, 1, 2);
    if (typeof repair.attempt === "number") {
      if (repairAttempts.has(repair.attempt)) i.issue(`${path}.attempt`, "DUPLICATE", "must be unique.");
      repairAttempts.add(repair.attempt);
    }
    inspectStringArray(i, repair.diagnostics, `${path}.diagnostics`, { nonEmptyItems: true });
    if (repair.patchHash !== undefined) inspectSha(i, repair.patchHash, `${path}.patchHash`);
  });
  const manualChecks = i.array(record.manualChecks, "$validationReport.manualChecks");
  manualChecks?.forEach((raw, index) => {
    const path = `$validationReport.manualChecks[${index}]`;
    const check = i.record(raw, path);
    if (!check) return;
    i.exact(check, path, ["description", "status"], ["evidence"]);
    i.string(check.description, `${path}.description`, { nonEmpty: true, max: 4096 });
    i.enum(check.status, `${path}.status`, ["passed", "failed", "pending", "not_applicable"]);
    if (check.evidence !== undefined) i.string(check.evidence, `${path}.evidence`, { nonEmpty: true, max: 16_384 });
  });
  inspectStringArray(i, record.diagnostics, "$validationReport.diagnostics", { nonEmptyItems: true });
  inspectTimestamp(i, record.startedAt, "$validationReport.startedAt");
  inspectTimestamp(i, record.finishedAt, "$validationReport.finishedAt");
  if (typeof record.startedAt === "string" && typeof record.finishedAt === "string" && Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
    i.issue("$validationReport.finishedAt", "VALUE", "must not precede startedAt.");
  }
  if (record.status === "validated" && record.sandbox !== "strong") {
    i.issue("$validationReport.status", "VALUE", "validated status requires a strong sandbox.");
  }
  if (record.sandbox === "none"
    && ((Array.isArray(record.baseline) && record.baseline.length > 0)
      || (Array.isArray(record.candidate) && record.candidate.length > 0))) {
    i.issue("$validationReport.sandbox", "VALUE", "a report with no sandbox cannot contain executed command results.");
  }
  if (record.status === "validated") {
    const results = [
      ...(Array.isArray(record.baseline) ? record.baseline : []),
      ...(Array.isArray(record.candidate) ? record.candidate : []),
    ] as Record<string, unknown>[];
    if (results.length === 0 || results.some((result) => result.status !== "passed" || result.flaky === true || result.outputTruncated === true || result.timedOut === true)) {
      i.issue("$validationReport.status", "VALUE", "validated status requires non-flaky, non-truncated passing command results.");
    }
    if (Array.isArray(record.manualChecks) && record.manualChecks.some((check) => {
      if (typeof check !== "object" || check === null || Array.isArray(check)) return true;
      return !["passed", "not_applicable"].includes(String((check as Record<string, unknown>).status));
    })) {
      i.issue("$validationReport.status", "VALUE", "validated status requires every manual check to be resolved successfully.");
    }
  }
  i.finish();
  return value as ValidationReportV1;
}

export function validateRunRecordV1(value: unknown): RunRecordV1 {
  const i = new Inspector();
  const record = i.record(value, "$run");
  if (!record) {
    i.finish();
    throw new Error("unreachable");
  }
  i.exact(record, "$run", ["runId", "schemaVersion", "createdAt", "updatedAt", "root", "status", "diagnostics"], [
    "contractHash", "contextManifestHash", "patchHash", "validationReportHash", "provider", "usage",
  ]);
  inspectId(i, record.runId, "$run.runId");
  inspectSchemaVersion(i, record, "$run");
  inspectTimestamp(i, record.createdAt, "$run.createdAt");
  inspectTimestamp(i, record.updatedAt, "$run.updatedAt");
  i.string(record.root, "$run.root", { nonEmpty: true, max: 4096 });
  i.enum(record.status, "$run.status", ["VERIFIED", "NEEDS_INPUT", "UNSUPPORTED", "INCONCLUSIVE", "FAILED", "SECURITY_BLOCKED"]);
  inspectStringArray(i, record.diagnostics, "$run.diagnostics", { nonEmptyItems: true });
  for (const key of ["contractHash", "contextManifestHash", "patchHash", "validationReportHash"] as const) {
    if (record[key] !== undefined) inspectSha(i, record[key], `$run.${key}`);
  }
  if (record.provider !== undefined) {
    const provider = i.record(record.provider, "$run.provider");
    if (provider) {
      i.exact(provider, "$run.provider", ["name", "requestedModel", "resolvedModel", "requestIds"]);
      i.string(provider.name, "$run.provider.name", { nonEmpty: true, max: 128 });
      i.string(provider.requestedModel, "$run.provider.requestedModel", { nonEmpty: true, max: 256 });
      i.string(provider.resolvedModel, "$run.provider.resolvedModel", { nonEmpty: true, max: 256 });
      inspectStringArray(i, provider.requestIds, "$run.provider.requestIds", { nonEmptyItems: true, unique: true });
    }
  }
  if (record.usage !== undefined) {
    const usage = i.record(record.usage, "$run.usage");
    if (usage) {
      i.exact(usage, "$run.usage", ["inputTokens", "outputTokens", "totalTokens", "requests"], ["repairs", "costUsd"]);
      i.integer(usage.inputTokens, "$run.usage.inputTokens");
      i.integer(usage.outputTokens, "$run.usage.outputTokens");
      i.integer(usage.totalTokens, "$run.usage.totalTokens");
      i.integer(usage.requests, "$run.usage.requests");
      if (usage.repairs !== undefined) i.integer(usage.repairs, "$run.usage.repairs", 0, 2);
      if (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number" && usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
        i.issue("$run.usage.totalTokens", "VALUE", "must equal inputTokens + outputTokens.");
      }
      if (usage.costUsd !== undefined && (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
        i.issue("$run.usage.costUsd", "VALUE", "must be a non-negative finite number.");
      }
    }
  }
  if (typeof record.createdAt === "string" && typeof record.updatedAt === "string" && Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    i.issue("$run.updatedAt", "VALUE", "must not precede createdAt.");
  }
  if (record.status === "VERIFIED") {
    for (const key of ["contractHash", "contextManifestHash", "patchHash", "validationReportHash"] as const) {
      if (record[key] === undefined) i.issue(`$run.${key}`, "MISSING", "is required for VERIFIED status.");
    }
  } else if (Array.isArray(record.diagnostics) && record.diagnostics.length === 0) {
    i.issue("$run.diagnostics", "MISSING", "must explain every non-verified terminal status.");
  }
  i.finish();
  return value as RunRecordV1;
}
