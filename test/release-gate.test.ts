import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CERTIFIED_EVIDENCE,
  evaluateProviderCertification,
  providerProfileId,
  scoreCertificationEvidence,
  validateCertificationEvidenceV1,
} from "../src/llms/certification.ts";
import { defaultModelFor } from "../src/config/config.ts";
import { SUPPORT_MATRIX, SUPPORT_MATRIX_VERSION } from "../src/tools/analysis/support-matrix.ts";

/**
 * These gates used to pin the major version to 0. That conflated two separate
 * promises: that the *interfaces* are stable, and that *generation quality* has
 * been measured. Only the second needs a benchmark, so the version number is no
 * longer the thing under test — the honesty rules below are, and they hold at
 * every version.
 */

test("the released version is valid semantic versioning", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  assert.equal(typeof packageJson.version, "string");
  assert.ok(
    /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.test(packageJson.version as string),
    "package.version must be valid semantic versioning",
  );
});

test("no ecosystem may be declared certified without passing shipped evidence", () => {
  for (const entry of SUPPORT_MATRIX) {
    if (entry.tier !== "certified") continue;
    const passing = CERTIFIED_EVIDENCE.filter(
      (document) => document.matrixKey === entry.key
        && scoreCertificationEvidence(document).certified,
    );
    assert.ok(
      passing.length > 0,
      `${entry.key} claims the certified tier with no passing benchmark evidence behind it`,
    );
  }
});

test("shipped evidence is well formed and scored against the current support matrix", () => {
  for (const document of CERTIFIED_EVIDENCE) {
    // Re-validating the frozen data catches a hand-edited or truncated document.
    validateCertificationEvidenceV1(document);
    assert.equal(
      document.supportMatrixVersion,
      SUPPORT_MATRIX_VERSION,
      `evidence for ${document.matrixKey} was produced against a different support matrix and must be re-run`,
    );
    assert.ok(
      SUPPORT_MATRIX.some((entry) => entry.key === document.matrixKey),
      `evidence references support-matrix key ${document.matrixKey}, which no longer exists`,
    );
  }
});

test("with no shipped evidence, no provider profile certifies anything", () => {
  // The operational half of the same guarantee. While the registry is empty the
  // certification WRITE gate certifies nothing, so VERIFIED stays unreachable no
  // matter what the package version says.
  if (CERTIFIED_EVIDENCE.length > 0) return;
  const shippedDefault = providerProfileId("ollama", defaultModelFor("ollama"));
  assert.deepEqual(
    evaluateProviderCertification(shippedDefault).certifiedMatrixKeys,
    [],
    "the shipped default provider profile must certify no ecosystem",
  );
  assert.deepEqual(
    SUPPORT_MATRIX.filter((entry) => entry.tier === "certified"),
    [],
    "an empty evidence registry cannot support any certified tier entry",
  );
});
