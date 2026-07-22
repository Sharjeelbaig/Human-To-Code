/**
 * Ungrounded `general` fallback workspace.
 *
 * Unlike the framework adapters, this is NOT a peer `EcosystemAdapter` (those
 * run unconditionally and must recognize a real ecosystem). It is a deliberate
 * last resort invoked by `analyzeProject` only when no framework adapter
 * recognized a workspace and the operator declared a language for general
 * generation. The resulting workspace is the lowest-trust tier the tool emits:
 *
 *   - it carries an EMPTY validation plan, so isolated validation has nothing to
 *     prove and every general run resolves to INCONCLUSIVE — never VERIFIED and
 *     never auto-applied;
 *   - it advertises no dependency evidence, so API grounding is intentionally
 *     skipped for it (there is nothing to ground against). That relaxation is
 *     confined to this ecosystem and is surfaced as a standing diagnostic.
 *
 * This exists so a bare `.human` request against an unrecognized project yields
 * a reviewable patch instead of a hard UNSUPPORTED stop, without ever letting
 * ungrounded output masquerade as validated.
 */

import type { AnalyzerContext, WorkspaceProfileV1 } from "../analyzer-types.ts";
import { PROJECT_PROFILE_SCHEMA_VERSION } from "../analyzer-types.ts";
import { finalizeWorkspace } from "../analyzer-utils.ts";
import { supportFor } from "../support-matrix.ts";

/** Conservative slug for an operator-declared language label. */
export function normalizeGeneralLanguage(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9+#.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned.slice(0, 40) || "code";
}

/**
 * Build the single ungrounded general workspace at the project root. The caller
 * (`analyzeProject`) is responsible for only invoking this when no framework
 * workspace was recognized.
 */
export function buildGeneralWorkspace(
  context: AnalyzerContext,
  language: string,
): WorkspaceProfileV1 {
  const normalizedLanguage = normalizeGeneralLanguage(language);
  return finalizeWorkspace({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    id: "general:.",
    relativeRoot: ".",
    ecosystem: "general",
    variant: "general-code",
    support: supportFor("general", "general-code"),
    ownership: { root: ".", members: ["."] },
    framework: { name: "General", dependencies: [] },
    runtime: { language: normalizedLanguage, grounded: false },
    manifests: [],
    lockfiles: [],
    sourceRoots: ["."],
    testRoots: [],
    generatedRoots: [],
    migrationRoots: [],
    protectedRoots: [".git", ".env"],
    moduleAliases: {},
    workspaceDependencies: [],
    publicExports: [],
    entryPoints: [],
    routes: [],
    signals: { language: normalizedLanguage, grounded: false },
    // Deliberately empty: with no recognized toolchain there is no argv plan to
    // run, so validation stays INCONCLUSIVE and apply remains unreachable.
    validationPlan: [],
    manualAcceptance: [
      "General generation is ungrounded and unvalidated: review every line, path, import, and side effect before use.",
      "Provide a recognized project (React, NestJS, FastAPI, or Cargo) to obtain grounded, sandbox-validated output.",
    ],
    diagnostics: [
      {
        code: "GENERAL_UNGROUNDED_PREVIEW",
        message: `No framework was recognized; emitting an ungrounded ${normalizedLanguage} general workspace. Output cannot be grounded or validated and will remain INCONCLUSIVE.`,
        severity: "warning",
        paths: ["."],
      },
    ],
    evidence: [],
  });
}
