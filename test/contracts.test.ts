import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactValidationError,
  canonicalJson,
  hashCanonical,
  inferPatchRisks,
  sha256Text,
  validateChangeContractV1,
  validatePatchSetV1,
  validateValidationPlanV1,
  type ChangeContractV1,
  type PatchSetV1,
} from "../src/core/contracts.ts";

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: { path: "feature.human", sha256: sha256Text("feature") },
    projectFingerprint: sha256Text("project"),
    targetWorkspaces: ["apps/web"],
    targetSymbols: ["Widget"],
    requirements: [{ id: "REQ-1", description: "Implement the widget." }],
    acceptanceCriteria: { automated: ["Tests pass."], manual: [] },
    scope: {
      allowedPaths: ["src/**"],
      allowedOperations: ["create", "edit", "delete", "rename"],
      prohibitedPaths: ["src/generated/**"],
    },
    prohibitedChanges: ["Do not weaken tests."],
    risks: [],
    authorizedRisks: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

test("canonicalJson is stable across object insertion order", () => {
  const left = { z: [3, { b: true, a: null }], a: "first" };
  const right = { a: "first", z: [3, { a: null, b: true }] };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(hashCanonical(left), hashCanonical(right));
  assert.match(hashCanonical(left), /^[a-f0-9]{64}$/u);
});

test("canonicalJson rejects non-JSON and circular inputs", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), TypeError);
  assert.throws(() => canonicalJson({ bad: Number.NaN }), TypeError);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), TypeError);
  const sparse = new Array(2);
  assert.throws(() => canonicalJson(sparse), TypeError);
});

test("validation plans permit the repository root but reject shell-string fields", () => {
  const plan = validateValidationPlanV1({
    schemaVersion: 1,
    profileFingerprint: sha256Text("profile"),
    commands: [{
      id: "typecheck",
      argv: ["npm", "run", "typecheck"],
      cwd: ".",
      timeoutMs: 60_000,
      required: true,
      category: "typecheck",
    }],
    manualChecks: [],
  });
  assert.equal(plan.commands[0]?.cwd, ".");
  assert.throws(() => validateValidationPlanV1({
    ...plan,
    commands: [{ ...plan.commands[0], shell: "npm run typecheck && curl evil" }],
  }), ArtifactValidationError);
});

test("ChangeContractV1 uses exact keys and blocks material ambiguity", () => {
  const valid = validateChangeContractV1(contract());
  assert.equal(valid.schemaVersion, 1);

  assert.throws(
    () => validateChangeContractV1(contract({ surprise: true })),
    (error: unknown) => error instanceof ArtifactValidationError
      && error.issues.some((issue) => issue.code === "UNKNOWN_KEY"),
  );
  assert.throws(
    () => validateChangeContractV1(contract({
      unresolvedQuestions: [{ id: "Q-1", question: "Should the endpoint be public?", material: true }],
    })),
    (error: unknown) => error instanceof ArtifactValidationError
      && error.issues.some((issue) => issue.code === "UNRESOLVED"),
  );
});

test("PatchSetV1 binds contract, scope, requirements, and risk authorization", () => {
  const parsed = validateChangeContractV1(contract()) as ChangeContractV1;
  const patch: PatchSetV1 = {
    schemaVersion: 1,
    contractHash: hashCanonical(parsed),
    snapshotHash: sha256Text("snapshot"),
    operations: [{ kind: "create", path: "src/lib.rs", content: "pub unsafe fn raw() {}\n" }],
    requirementIds: ["REQ-1"],
    proposedTests: ["cargo test"],
  };
  assert.deepEqual(inferPatchRisks(patch.operations[0]!), ["unsafe_rust"]);
  assert.throws(
    () => validatePatchSetV1(patch, parsed),
    (error: unknown) => error instanceof ArtifactValidationError
      && error.issues.some((issue) => issue.code === "UNAUTHORIZED"),
  );

  const authorized = validateChangeContractV1(contract({
    risks: [{ category: "unsafe_rust", reason: "Required for a reviewed platform boundary." }],
    authorizedRisks: ["unsafe_rust"],
  }));
  const allowed = { ...patch, contractHash: hashCanonical(authorized) };
  assert.equal(validatePatchSetV1(allowed, authorized).operations.length, 1);
});

test("PatchSetV1 rejects traversal, unknown fields, and incomplete coverage", () => {
  const parsed = validateChangeContractV1(contract());
  const patch = {
    schemaVersion: 1,
    contractHash: hashCanonical(parsed),
    snapshotHash: sha256Text("snapshot"),
    operations: [{ kind: "create", path: "../escape.ts", content: "x", command: "rm -rf /" }],
    requirementIds: [],
    proposedTests: ["test"],
  };
  assert.throws(
    () => validatePatchSetV1(patch, parsed),
    (error: unknown) => error instanceof ArtifactValidationError
      && error.issues.some((issue) => issue.code === "UNKNOWN_KEY")
      && error.issues.some((issue) => issue.code === "VALUE")
      && error.issues.some((issue) => issue.code === "MISSING"),
  );
});

test("PatchSetV1 hard-blocks credential paths even when a contract permits all files", () => {
  const permissive = validateChangeContractV1(contract({
    scope: { allowedPaths: ["**"], allowedOperations: ["create"], prohibitedPaths: [] },
  }));
  assert.throws(() => validatePatchSetV1({
    schemaVersion: 1,
    contractHash: hashCanonical(permissive),
    snapshotHash: sha256Text("snapshot"),
    operations: [{ kind: "create", path: "config/.env.production", content: "SAFE_REFERENCE=process.env.VALUE" }],
    requirementIds: ["REQ-1"],
    proposedTests: [],
  }, permissive), (error: unknown) => error instanceof ArtifactValidationError
    && error.issues.some((issue) => issue.code === "UNAUTHORIZED"));
});
