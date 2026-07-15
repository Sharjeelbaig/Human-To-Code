import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CERTIFICATION_POLICY,
  CERTIFIED_EVIDENCE,
  evaluateProviderCertification,
  providerProfileId,
  scoreCertificationEvidence,
  validateCertificationEvidenceV1,
  type BenchmarkRunOutcome,
  type CertificationEvidenceV1,
} from "../src/certification.ts";
import { SUPPORT_MATRIX_VERSION } from "../src/support-matrix.ts";

const CORPUS_HASH = createHash("sha256").update("react-vite-spa-corpus").digest("hex");
const PROFILE = providerProfileId("Ollama", "qwen2.5-coder:7b");

function evidence(overrides: Partial<CertificationEvidenceV1> = {}): CertificationEvidenceV1 {
  const tasks = Array.from({ length: CERTIFICATION_POLICY.minTasksPerEcosystem }, (_unused, index) => ({
    taskId: `react-vite-spa-${index}`,
    runs: Array.from({ length: CERTIFICATION_POLICY.runsPerTask }, () => "validated" as BenchmarkRunOutcome),
  }));
  return {
    schemaVersion: 1,
    supportMatrixVersion: SUPPORT_MATRIX_VERSION,
    ecosystem: "react",
    matrixKey: "react.vite-spa",
    providerProfileId: PROFILE,
    corpusHash: CORPUS_HASH,
    producedAt: "2026-07-15T00:00:00.000Z",
    tasks,
    ...overrides,
  };
}

test("the shipped certification registry is empty, so nothing is certified", () => {
  assert.deepEqual([...CERTIFIED_EVIDENCE], []);
  const resolved = evaluateProviderCertification(PROFILE);
  assert.deepEqual(resolved.certifiedMatrixKeys, []);
  assert.deepEqual(resolved.evaluations, []);
});

test("provider profile identity is normalized so evidence must match exactly", () => {
  assert.equal(providerProfileId(" OpenAI ", "GPT-4O-Mini"), "openai::gpt-4o-mini");
  assert.notEqual(providerProfileId("ollama", "qwen2.5-coder:7b"), providerProfileId("ollama", "qwen2.5-coder:14b"));
});

test("a complete, all-passing corpus scores as certified", () => {
  const score = scoreCertificationEvidence(evidence());
  assert.equal(score.certified, true);
  assert.equal(score.passRate, 1);
  assert.equal(score.taskCount, CERTIFICATION_POLICY.minTasksPerEcosystem);
  assert.equal(score.runCount, CERTIFICATION_POLICY.minTasksPerEcosystem * CERTIFICATION_POLICY.runsPerTask);
  assert.deepEqual(score.reasons, []);
});

test("too few benchmark tasks is not certified", () => {
  const short = evidence({ tasks: evidence().tasks.slice(0, CERTIFICATION_POLICY.minTasksPerEcosystem - 1) });
  const score = scoreCertificationEvidence(short);
  assert.equal(score.certified, false);
  assert.match(score.reasons.join("\n"), /at least 25/u);
});

test("a task with the wrong number of runs is not certified", () => {
  const tasks = evidence().tasks.map((task, index) =>
    index === 0 ? { taskId: task.taskId, runs: task.runs.slice(0, 2) } : task);
  const score = scoreCertificationEvidence(evidence({ tasks }));
  assert.equal(score.certified, false);
  assert.match(score.reasons.join("\n"), /exactly 3/u);
});

test("a pass rate below the threshold is not certified", () => {
  // 25 tasks x 3 runs = 75 runs; 95% requires >= 72 passing. Fail four runs -> 71/75 = 94.6%.
  let failsRemaining = 4;
  const tasks = evidence().tasks.map((task) => {
    const runs = task.runs.map((outcome) => {
      if (failsRemaining > 0) {
        failsRemaining -= 1;
        return "failed" as BenchmarkRunOutcome;
      }
      return outcome;
    });
    return { taskId: task.taskId, runs };
  });
  const score = scoreCertificationEvidence(evidence({ tasks }));
  assert.equal(score.certified, false);
  assert.ok(score.passRate < CERTIFICATION_POLICY.minPassRate);
  assert.match(score.reasons.join("\n"), /below the required 95%/u);
});

test("evidence produced against a different support matrix is not certified", () => {
  const score = scoreCertificationEvidence(evidence({ supportMatrixVersion: "0.9.0" }));
  assert.equal(score.certified, false);
  assert.match(score.reasons.join("\n"), /different support matrix|not 1\.0\.0/u);
});

test("evidence for an unknown matrix key is not certified", () => {
  const score = scoreCertificationEvidence(evidence({ matrixKey: "react.imaginary" }));
  assert.equal(score.certified, false);
  assert.match(score.reasons.join("\n"), /unknown support-matrix key/u);
});

test("evidence whose ecosystem contradicts its matrix key is not certified", () => {
  const score = scoreCertificationEvidence(evidence({ ecosystem: "rust" }));
  assert.equal(score.certified, false);
  assert.match(score.reasons.join("\n"), /does not match matrix key/u);
});

test("evaluateProviderCertification only trusts exact-profile passing evidence", () => {
  const passing = evidence();
  const otherProfile = evidence({ providerProfileId: providerProfileId("openai", "gpt-4o-mini") });
  const belowBar = evidence({ matrixKey: "react.next-app", tasks: evidence().tasks.slice(0, 3) });
  const resolved = evaluateProviderCertification(PROFILE, [passing, otherProfile, belowBar]);
  assert.deepEqual(resolved.certifiedMatrixKeys, ["react.vite-spa"]);
  // Both documents for this profile are evaluated; only the complete one certifies.
  assert.equal(resolved.evaluations.length, 2);
  assert.equal(resolved.evaluations.filter((item) => item.certified).length, 1);
});

test("strict validation rejects malformed evidence documents", () => {
  const base = evidence() as unknown as Record<string, unknown>;
  const cases: Array<[string, unknown]> = [
    ["non-object", 42],
    ["unexpected field", { ...base, sneaky: true }],
    ["bad schemaVersion", { ...base, schemaVersion: 2 }],
    ["empty matrixKey", { ...base, matrixKey: "" }],
    ["unknown ecosystem", { ...base, ecosystem: "go" }],
    ["short corpus hash", { ...base, corpusHash: "abc" }],
    ["non-iso producedAt", { ...base, producedAt: "yesterday" }],
    ["invalid run outcome", { ...base, tasks: [{ taskId: "t", runs: ["passed"] }] }],
    ["duplicate task id", { ...base, tasks: [{ taskId: "dup", runs: [] }, { taskId: "dup", runs: [] }] }],
    ["extra task field", { ...base, tasks: [{ taskId: "t", runs: [], note: "x" }] }],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => validateCertificationEvidenceV1(value), new RegExp(".", "u"), label);
  }
});

test("strict validation accepts a well-formed document unchanged", () => {
  const parsed = validateCertificationEvidenceV1(JSON.parse(JSON.stringify(evidence())));
  assert.equal(parsed.matrixKey, "react.vite-spa");
  assert.equal(parsed.tasks.length, CERTIFICATION_POLICY.minTasksPerEcosystem);
  // A validated document still has to clear the fail-closed score to certify.
  assert.equal(scoreCertificationEvidence(parsed).certified, true);
});
