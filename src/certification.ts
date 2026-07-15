/**
 * Certification harness: the WRITE gate that decides whether a
 * (provider-profile, support-matrix-entry) pair may reach VERIFIED.
 *
 * The reliability contract forbids turning model confidence into certification.
 * Certification therefore comes exclusively from stored, host-owned benchmark
 * evidence that this module re-scores deterministically. Evidence is shipped as
 * frozen package data — never read from the analyzed repository, which is
 * untrusted — and the shipped registry is intentionally EMPTY until a real
 * benchmark corpus has actually run. With no evidence, nothing is certified and
 * VERIFIED stays unreachable, exactly as the preview requires.
 */

import type { Ecosystem } from "./analyzer-types.ts";
import { SUPPORT_MATRIX, SUPPORT_MATRIX_VERSION } from "./support-matrix.ts";

/**
 * Fail-closed thresholds from the reliability contract: a large per-ecosystem
 * corpus, repeated runs, and a high pass rate. These are policy constants and
 * are never relaxed by a caller, model, or repository.
 */
export const CERTIFICATION_POLICY = Object.freeze({
  minTasksPerEcosystem: 25,
  runsPerTask: 3,
  minPassRate: 0.95,
});

/**
 * A benchmark run "passes" only when the generated candidate reached a
 * validated strong sandbox for that task's own oracle. It is deliberately NOT
 * the production VERIFIED status, which requires certification and would make
 * this gate circular.
 */
export type BenchmarkRunOutcome = "validated" | "failed" | "inconclusive";

const BENCHMARK_OUTCOMES: ReadonlySet<string> = new Set<BenchmarkRunOutcome>([
  "validated",
  "failed",
  "inconclusive",
]);

export interface CertificationTaskResultV1 {
  /** Stable identifier of the benchmark task within the corpus. */
  taskId: string;
  /** Exactly `runsPerTask` independent outcomes for this task. */
  runs: readonly BenchmarkRunOutcome[];
}

export interface CertificationEvidenceV1 {
  schemaVersion: 1;
  /** Evidence is invalidated when the support matrix it was produced against changes. */
  supportMatrixVersion: string;
  ecosystem: Ecosystem;
  /** Exact support-matrix entry key this evidence certifies. */
  matrixKey: string;
  /** Exact provider/model profile that produced the runs (see providerProfileId). */
  providerProfileId: string;
  /** sha256 of the benchmark corpus used; recorded for provenance. */
  corpusHash: string;
  producedAt: string;
  tasks: readonly CertificationTaskResultV1[];
}

export interface CertificationScore {
  certified: boolean;
  passRate: number;
  taskCount: number;
  runCount: number;
  reasons: string[];
}

/**
 * Deterministic profile identity for a provider/model combination. Moving
 * aliases and tags are not immutable digests, so this proves which label ran,
 * not a reproducible snapshot. Evidence and live runs must match exactly.
 */
export function providerProfileId(name: string, resolvedModel: string): string {
  const clean = (value: string): string => value.trim().toLowerCase();
  return `${clean(name)}::${clean(resolvedModel)}`;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function isEvidenceShape(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly validate one evidence document. Throws on any deviation so a corrupt
 * or over-broad evidence file can never contribute silent trust.
 */
export function validateCertificationEvidenceV1(value: unknown): CertificationEvidenceV1 {
  if (!isEvidenceShape(value)) throw new Error("Certification evidence must be an object.");
  const allowed = new Set([
    "schemaVersion",
    "supportMatrixVersion",
    "ecosystem",
    "matrixKey",
    "providerProfileId",
    "corpusHash",
    "producedAt",
    "tasks",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Certification evidence has an unexpected field: ${key}.`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("Certification evidence schemaVersion must be 1.");
  if (typeof record.supportMatrixVersion !== "string" || record.supportMatrixVersion.length === 0) {
    throw new Error("Certification evidence supportMatrixVersion must be a non-empty string.");
  }
  if (record.ecosystem !== "react" && record.ecosystem !== "nestjs"
    && record.ecosystem !== "fastapi" && record.ecosystem !== "rust") {
    throw new Error("Certification evidence ecosystem is not a recognized ecosystem.");
  }
  if (typeof record.matrixKey !== "string" || record.matrixKey.length === 0) {
    throw new Error("Certification evidence matrixKey must be a non-empty string.");
  }
  if (typeof record.providerProfileId !== "string" || record.providerProfileId.length === 0) {
    throw new Error("Certification evidence providerProfileId must be a non-empty string.");
  }
  if (typeof record.corpusHash !== "string" || !HEX64.test(record.corpusHash)) {
    throw new Error("Certification evidence corpusHash must be a sha256 hex digest.");
  }
  if (typeof record.producedAt !== "string" || !Number.isFinite(Date.parse(record.producedAt))) {
    throw new Error("Certification evidence producedAt must be an ISO timestamp.");
  }
  if (!Array.isArray(record.tasks)) throw new Error("Certification evidence tasks must be an array.");
  const taskIds = new Set<string>();
  const tasks: CertificationTaskResultV1[] = record.tasks.map((raw, index) => {
    if (!isEvidenceShape(raw)) throw new Error(`Certification task ${index} must be an object.`);
    for (const key of Object.keys(raw)) {
      if (key !== "taskId" && key !== "runs") throw new Error(`Certification task ${index} has an unexpected field: ${key}.`);
    }
    const taskId = raw.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) throw new Error(`Certification task ${index} taskId must be a non-empty string.`);
    if (taskIds.has(taskId)) throw new Error(`Certification task ${index} repeats taskId ${taskId}.`);
    taskIds.add(taskId);
    if (!Array.isArray(raw.runs)) throw new Error(`Certification task ${taskId} runs must be an array.`);
    const runs = raw.runs.map((outcome) => {
      if (typeof outcome !== "string" || !BENCHMARK_OUTCOMES.has(outcome)) {
        throw new Error(`Certification task ${taskId} has an invalid run outcome.`);
      }
      return outcome as BenchmarkRunOutcome;
    });
    return { taskId, runs };
  });
  return {
    schemaVersion: 1,
    supportMatrixVersion: record.supportMatrixVersion,
    ecosystem: record.ecosystem as Ecosystem,
    matrixKey: record.matrixKey,
    providerProfileId: record.providerProfileId,
    corpusHash: record.corpusHash,
    producedAt: record.producedAt,
    tasks,
  };
}

/**
 * Re-score already-validated evidence against the fail-closed policy. Every
 * failing condition is collected so the diagnostics explain exactly why a
 * profile is not certified. `certified` is true only when nothing failed.
 */
export function scoreCertificationEvidence(evidence: CertificationEvidenceV1): CertificationScore {
  const reasons: string[] = [];
  if (evidence.supportMatrixVersion !== SUPPORT_MATRIX_VERSION) {
    reasons.push(`Evidence was produced against support matrix ${evidence.supportMatrixVersion}, not ${SUPPORT_MATRIX_VERSION}.`);
  }
  const entry = SUPPORT_MATRIX.find((candidate) => candidate.key === evidence.matrixKey);
  if (!entry) {
    reasons.push(`Evidence references unknown support-matrix key ${evidence.matrixKey}.`);
  } else if (entry.ecosystem !== evidence.ecosystem) {
    reasons.push(`Evidence ecosystem ${evidence.ecosystem} does not match matrix key ${evidence.matrixKey}.`);
  }
  const taskCount = evidence.tasks.length;
  if (taskCount < CERTIFICATION_POLICY.minTasksPerEcosystem) {
    reasons.push(`Corpus has ${taskCount} tasks; certification requires at least ${CERTIFICATION_POLICY.minTasksPerEcosystem}.`);
  }
  let runCount = 0;
  let passing = 0;
  for (const task of evidence.tasks) {
    if (task.runs.length !== CERTIFICATION_POLICY.runsPerTask) {
      reasons.push(`Task ${task.taskId} has ${task.runs.length} runs; certification requires exactly ${CERTIFICATION_POLICY.runsPerTask}.`);
    }
    runCount += task.runs.length;
    passing += task.runs.filter((outcome) => outcome === "validated").length;
  }
  const passRate = runCount === 0 ? 0 : passing / runCount;
  if (passRate < CERTIFICATION_POLICY.minPassRate) {
    reasons.push(`Corpus pass rate ${(passRate * 100).toFixed(1)}% is below the required ${(CERTIFICATION_POLICY.minPassRate * 100).toFixed(0)}%.`);
  }
  return { certified: reasons.length === 0, passRate, taskCount, runCount, reasons };
}

export interface CertificationEvaluation {
  matrixKey: string;
  certified: boolean;
  passRate: number;
  reasons: string[];
}

export interface ProviderCertificationResult {
  providerProfileId: string;
  /** Support-matrix keys with passing evidence for this exact provider profile. */
  certifiedMatrixKeys: string[];
  /** One evaluation per evidence document matching this provider profile. */
  evaluations: CertificationEvaluation[];
}

/**
 * Resolve every support-matrix key a provider profile has passing evidence for.
 * Only evidence whose `providerProfileId` matches exactly is considered, and
 * each document must independently clear the fail-closed score.
 */
export function evaluateProviderCertification(
  profileId: string,
  evidence: readonly CertificationEvidenceV1[] = CERTIFIED_EVIDENCE,
): ProviderCertificationResult {
  const certifiedMatrixKeys = new Set<string>();
  const evaluations: CertificationEvaluation[] = [];
  for (const document of evidence) {
    if (document.providerProfileId !== profileId) continue;
    const score = scoreCertificationEvidence(document);
    evaluations.push({
      matrixKey: document.matrixKey,
      certified: score.certified,
      passRate: score.passRate,
      reasons: score.reasons,
    });
    if (score.certified) certifiedMatrixKeys.add(document.matrixKey);
  }
  return {
    providerProfileId: profileId,
    certifiedMatrixKeys: [...certifiedMatrixKeys],
    evaluations,
  };
}

/**
 * Shipped, host-owned certification evidence. Deliberately EMPTY: no
 * 25-task-per-ecosystem, three-run, 95% benchmark has been executed and
 * archived for this preview, so no provider/model/profile is certified and
 * VERIFIED remains unreachable. Adding a real, scored corpus here — and nowhere
 * else — is the only way to make a profile certifiable.
 */
export const CERTIFIED_EVIDENCE: readonly CertificationEvidenceV1[] = Object.freeze([]);
