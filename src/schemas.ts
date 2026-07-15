/** JSON Schema representations of every persisted v1 pipeline artifact. */

import type { JsonSchemaV1 } from "./provider.ts";

const SHA256 = "^[a-f0-9]{64}$";
const ID = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const WORKSPACE_ID = "^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$";
const PATH = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?![A-Za-z]:).+$";

const stringArray = (minimum = 0): Record<string, unknown> => ({
  type: "array",
  items: { type: "string", minLength: 1 },
  minItems: minimum,
  uniqueItems: true,
});

const patchOperationSchemas = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "path", "content"],
    properties: {
      kind: { const: "create" },
      path: { type: "string", pattern: PATH },
      content: { type: "string", maxLength: 10_000_000 },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "path", "baseHash", "oldText", "newText"],
    properties: {
      kind: { const: "edit" },
      path: { type: "string", pattern: PATH },
      baseHash: { type: "string", pattern: SHA256 },
      oldText: { type: "string", minLength: 1, maxLength: 10_000_000 },
      newText: { type: "string", maxLength: 10_000_000 },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "path", "baseHash"],
    properties: {
      kind: { const: "delete" },
      path: { type: "string", pattern: PATH },
      baseHash: { type: "string", pattern: SHA256 },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "from", "path", "baseHash"],
    properties: {
      kind: { const: "rename" },
      from: { type: "string", pattern: PATH },
      path: { type: "string", pattern: PATH },
      baseHash: { type: "string", pattern: SHA256 },
    },
  },
];

export const CHANGE_CONTRACT_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/change-contract-v1.json",
  title: "ChangeContractV1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "source", "projectFingerprint", "targetWorkspaces",
    "targetSymbols", "requirements", "acceptanceCriteria", "scope",
    "prohibitedChanges", "risks", "authorizedRisks", "unresolvedQuestions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    source: {
      type: "object", additionalProperties: false, required: ["path", "sha256"],
      properties: { path: { type: "string", pattern: PATH }, sha256: { type: "string", pattern: SHA256 } },
    },
    projectFingerprint: { type: "string", pattern: SHA256 },
    targetWorkspaces: { ...stringArray(1), items: { type: "string", pattern: WORKSPACE_ID } },
    targetSymbols: stringArray(),
    requirements: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["id", "description"],
        properties: { id: { type: "string", pattern: ID }, description: { type: "string", minLength: 1, maxLength: 16_384 } },
      },
    },
    acceptanceCriteria: {
      type: "object", additionalProperties: false, required: ["automated", "manual"],
      properties: { automated: stringArray(), manual: stringArray() },
    },
    scope: {
      type: "object", additionalProperties: false, required: ["allowedPaths", "allowedOperations", "prohibitedPaths"],
      properties: {
        allowedPaths: { ...stringArray(1), items: { type: "string", pattern: PATH } },
        allowedOperations: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["create", "edit", "delete", "rename"] } },
        prohibitedPaths: { ...stringArray(), items: { type: "string", pattern: PATH } },
      },
    },
    prohibitedChanges: stringArray(),
    risks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["category", "reason"],
        properties: {
          category: { enum: ["dependency_change", "lockfile_change", "database_migration", "public_api_break", "authentication_change", "unsafe_rust", "ffi", "validation_config_change"] },
          reason: { type: "string", minLength: 1, maxLength: 4096 },
        },
      },
    },
    authorizedRisks: { type: "array", uniqueItems: true, items: { enum: ["dependency_change", "lockfile_change", "database_migration", "public_api_break", "authentication_change", "unsafe_rust", "ffi", "validation_config_change"] } },
    unresolvedQuestions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "question", "material"],
        properties: { id: { type: "string", pattern: ID }, question: { type: "string", minLength: 1, maxLength: 8192 }, material: { type: "boolean" } },
      },
    },
  },
} as unknown as JsonSchemaV1;

/** Provider response schema. File modes are intentionally never model-controlled. */
export const PATCH_SET_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/patch-set-v1.json",
  title: "PatchSetV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "contractHash", "snapshotHash", "operations", "requirementIds", "proposedTests"],
  properties: {
    schemaVersion: { const: 1 },
    contractHash: { type: "string", pattern: SHA256 },
    snapshotHash: { type: "string", pattern: SHA256 },
    operations: { type: "array", minItems: 1, maxItems: 200, items: { anyOf: patchOperationSchemas } },
    requirementIds: { ...stringArray(1), items: { type: "string", pattern: ID } },
    proposedTests: stringArray(),
  },
} as unknown as JsonSchemaV1;

const validationCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "argv", "cwd", "timeoutMs", "required", "category"],
  properties: {
    id: { type: "string", pattern: ID },
    argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    cwd: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 1_800_000 },
    required: { type: "boolean" },
    category: { enum: ["format", "lint", "typecheck", "test", "build", "integration", "security"] },
  },
};

export const VALIDATION_PLAN_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/validation-plan-v1.json",
  title: "ValidationPlanV1",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "profileFingerprint", "commands", "manualChecks"],
  properties: {
    schemaVersion: { const: 1 },
    profileFingerprint: { type: "string", pattern: SHA256 },
    commands: { type: "array", minItems: 1, items: validationCommandSchema },
    manualChecks: stringArray(),
  },
} as unknown as JsonSchemaV1;

const commandResultSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "status", "exitCode", "signal", "durationMs", "stdout", "stderr", "timedOut", "flaky", "outputTruncated", "startedAt", "finishedAt"],
  properties: {
    id: { type: "string", pattern: ID }, status: { enum: ["passed", "failed", "skipped", "error"] },
    exitCode: { type: ["integer", "null"] }, signal: { type: ["string", "null"] }, durationMs: { type: "integer", minimum: 0 },
    stdout: { type: "string" }, stderr: { type: "string" }, timedOut: { type: "boolean" }, flaky: { type: "boolean" }, outputTruncated: { type: "boolean" },
    startedAt: { type: "string", format: "date-time" }, finishedAt: { type: "string", format: "date-time" },
  },
};

export const VALIDATION_REPORT_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/validation-report-v1.json",
  title: "ValidationReportV1",
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "status", "sandbox", "baseline", "candidate", "repairs", "manualChecks", "diagnostics", "startedAt", "finishedAt"],
  properties: {
    schemaVersion: { const: 1 }, status: { enum: ["validated", "non_regression_only", "unvalidated", "failed"] }, sandbox: { enum: ["strong", "degraded", "none"] },
    baseline: { type: "array", items: commandResultSchema }, candidate: { type: "array", items: commandResultSchema },
    repairs: { type: "array", items: { type: "object" } }, manualChecks: { type: "array", items: { type: "object" } }, diagnostics: stringArray(),
    startedAt: { type: "string", format: "date-time" }, finishedAt: { type: "string", format: "date-time" },
  },
} as unknown as JsonSchemaV1;

export const CONTEXT_MANIFEST_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/context-manifest-v1.json",
  title: "ContextManifestV1",
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "projectFingerprint", "offline", "evidence", "exclusions", "budget", "redactionCount"],
  properties: {
    schemaVersion: { const: 1 }, projectFingerprint: { type: "string", pattern: SHA256 }, offline: { type: "boolean" },
    evidence: { type: "array", items: { type: "object" } }, exclusions: { type: "array", items: { type: "object" } }, budget: { type: "object" },
    redactionCount: { type: "integer", minimum: 0 },
  },
} as unknown as JsonSchemaV1;

export const RUN_RECORD_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://human-to-code.dev/schemas/run-record-v1.json",
  title: "RunRecordV1",
  type: "object", additionalProperties: false,
  required: ["runId", "schemaVersion", "createdAt", "updatedAt", "root", "status", "diagnostics"],
  properties: {
    runId: { type: "string", pattern: ID }, schemaVersion: { const: 1 }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
    root: { type: "string" }, status: { enum: ["VERIFIED", "NEEDS_INPUT", "UNSUPPORTED", "INCONCLUSIVE", "FAILED", "SECURITY_BLOCKED"] },
    contractHash: { type: "string", pattern: SHA256 }, contextManifestHash: { type: "string", pattern: SHA256 }, patchHash: { type: "string", pattern: SHA256 }, validationReportHash: { type: "string", pattern: SHA256 },
    provider: { type: "object" },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["inputTokens", "outputTokens", "totalTokens", "requests"],
      properties: {
        inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 }, requests: { type: "integer", minimum: 0 },
        repairs: { type: "integer", minimum: 0, maximum: 2 }, costUsd: { type: "number", minimum: 0 },
      },
    },
    diagnostics: stringArray(),
  },
} as unknown as JsonSchemaV1;

export const ARTIFACT_SCHEMAS_V1 = Object.freeze({
  ChangeContractV1: CHANGE_CONTRACT_SCHEMA_V1,
  ContextManifestV1: CONTEXT_MANIFEST_SCHEMA_V1,
  PatchSetV1: PATCH_SET_SCHEMA_V1,
  ValidationPlanV1: VALIDATION_PLAN_SCHEMA_V1,
  ValidationReportV1: VALIDATION_REPORT_SCHEMA_V1,
  RunRecordV1: RUN_RECORD_SCHEMA_V1,
});
