import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SUPPORT_MATRIX } from "../src/support-matrix.ts";

test("an uncertified shipped matrix cannot be released as 1.0 or claim certified profiles", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  assert.equal(typeof packageJson.version, "string");
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(packageJson.version as string);
  assert.ok(version, "package.version must be valid semantic versioning");

  // Complete certification evidence requires both a shipped certified profile
  // and a shipped provider/model benchmark entry. This release has no profile
  // half of that evidence, so it must remain explicitly preview/pre-1.0.
  const claimedCertifiedProfiles = SUPPORT_MATRIX.filter((entry) => entry.tier === "certified");
  assert.deepEqual(claimedCertifiedProfiles, []);
  assert.equal(Number(version[1]), 0, "an uncertified release must remain pre-1.0");
});
