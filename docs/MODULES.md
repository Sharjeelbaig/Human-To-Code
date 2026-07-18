# Module guide

A per-file map of `src/`, grouped by layer. Layers and dependency rules are
explained in [ARCHITECTURE.md](ARCHITECTURE.md). Tests live in `test/` and
mirror these modules by name.

## Entry points (`src/`)

| Module | Purpose |
| --- | --- |
| `index.ts` | Stable public API for embedding the pipeline. Re-exports each layer's surface, grouped and commented by layer. Published as `dist/index.js`. |
| `cli.ts` | The `human-to-code` binary: direct conversion plus guided `analyze`, `plan`, `context`, `generate`, `validate`, `apply`, `rollback`, `check`, `migrate-config`, and `--init`. Owns argument parsing, exit codes (0–6), and human-readable output; all real work is delegated to agents and deterministic services. Published as `dist/cli.js`. |

## `src/core/` — shared primitives

| Module | Purpose |
| --- | --- |
| `types.ts` | Small shared types used across the pipeline: `Config`, `ProviderConfig`, `ProviderName`, `SourceFile`, `SourceKind`, `DiscoveryResult`, `TargetLanguage`. |
| `contracts.ts` | The versioned artifact vocabulary: `ChangeContractV1`, `PatchSetV1` (+ `PatchOperation`), `ValidationPlanV1`, `RunRecordV1`, and friends. Exact-key validators (`validateChangeContractV1`, `validatePatchSetV1`, `validateRunRecordV1`, …), canonical JSON (`canonicalJson`, `hashCanonical`), and hashing helpers (`sha256Text`, `sha256Bytes`). Raises `ArtifactValidationError`. No LLM/SDK dependency by design. |

## `src/config/` — operator policy input

| Module | Purpose |
| --- | --- |
| `config.ts` | Strict schema-v1 `human-to-code.config.json`: `validateConfig`, `DEFAULT_CONFIG`, `CONFIG_FILENAME`, provider/pricing/privacy/sandbox/budget policy, endpoint trust rules, and explicit alpha-config migration. Unknown keys and credential-like values are rejected; credentials are environment-variable names only. |
| `discovery.ts` | Fail-closed discovery of `.human` sources and protected secret files (`discover`, `DiscoveryError`, `secretsTrackedError`). Never follows symlinks; never turns a partial scan into an empty success. |

## `src/analysis/` — static project intelligence

| Module | Purpose |
| --- | --- |
| `analyzer.ts` | `analyzeProject`: deterministic, read-only multi-workspace profiling. Runs every ecosystem adapter over a bounded file inventory and produces a `ProjectProfileV1` with diagnostics; falls back to the ungrounded `general` workspace only when configured. Re-exports the analysis surface consumed by `index.ts`. |
| `analyzer-types.ts` | Versioned analyzer output types (`ProjectProfileV1`, `WorkspaceProfileV1`, `EcosystemAdapter`, `AnalyzerContext`, evidence/diagnostic/validation-command types) and `PROJECT_PROFILE_SCHEMA_VERSION`. |
| `analyzer-utils.ts` | Shared adapter infrastructure: bounded repository scanning, hashing, evidence collection, diagnostics, and `finalizeWorkspace`. |
| `support-matrix.ts` | The declared capability matrix (`SUPPORT_MATRIX`, `SUPPORT_MATRIX_VERSION`, `supportFor`): every recognized ecosystem/variant/version profile and its tier (`certified`/`preview`/`legacy`/…). Support is declared here, never inferred. |
| `adapters/node.ts` | Static recognition of React (Vite, Next, CRA, libraries, Nx) and NestJS (standalone, CLI monorepo, Nx) workspaces, with version evidence and candidate validation commands. |
| `adapters/python.ts` | Static recognition of FastAPI applications: environment manager, router/dependency layout, Pydantic, sync/async signals. |
| `adapters/rust.ts` | Static recognition of Cargo crates/workspaces: edition, toolchain, features, targets, `unsafe`/FFI, build scripts, proc macros, native dependencies. |
| `adapters/general.ts` | The ungrounded `general` fallback workspace (`buildGeneralWorkspace`). Not a peer adapter: a deliberate lowest-trust last resort with an empty validation plan, pinned to `INCONCLUSIVE`. |

## `src/security/` — fail-closed guards

| Module | Purpose |
| --- | --- |
| `secret-scan.ts` | Repository-wide first-party credential scan run before any provider access (`scanProjectForSecrets`, `ProjectSecretScanError`). Reports path/line/kind, never the matched value; partial scans fail closed. |
| `pinned-http.ts` | `pinnedHttpFetch`: dependency-free HTTPS transport whose socket is pinned to a DNS-vetted address while TLS keeps the reviewed hostname. Blocks userinfo, private networks, unsafe redirects, and DNS rebinding. Used for provider and documentation traffic. |

## `src/context/` — what the model may see

| Module | Purpose |
| --- | --- |
| `context.ts` | Deterministic, secret-aware context selection (`selectContext`, `hashContextManifest`): ranks relevant definitions/tests/config plus dependency evidence into a `ContextManifestV1` where every item records location, range, SHA-256, reason, and redactions. Also home of the `scanSecrets` pattern primitive reused at every trust boundary, and `ContextSecurityError`. |
| `documentation.ts` | `OfficialDocumentationClient`: allowlisted, exact-version official documentation retrieval (built-in `docs.rs`, operator `officialSources`), with a version-and-content-hash cache, strict offline mode, and safe redirect/DNS revalidation. |
| `compiler-skills.ts` | `COMPILER_SKILLS` / `skillsForEcosystems`: immutable, non-executable ecosystem policy packs (React, NestJS, FastAPI, Rust, core contract scope) supplied to the compiler agent. Data, not authority. |
| `compiler-tools.ts` | `CompilerToolExecutor`: the bounded read-only context-request executor advertised only to verified loopback-local providers. At most eight host-validated requests of four kinds; every response is recorded in the final manifest. |

## `src/providers/` — what the model may do

| Module | Purpose |
| --- | --- |
| `provider.ts` | The provider-neutral contract: `ProviderAdapter`, `JsonSchemaV1`, budget accounting (pessimistic pre-request reservation, usage reconciliation), normalized `ProviderError`s, bounded retries, and the schema gate `generateValidated`. |
| `providers.ts` | The bundled dependency-free HTTP adapters: `createOpenAIProvider` (Responses API, strict JSON schema) and `createOllamaProvider` (loopback-local native `format`, or Cloud/custom prompt-constrained). Endpoint-bound credentials, manual redirects, bounded response bodies. |
| `certification.ts` | The fail-closed WRITE gate (`evaluateProviderCertification`, `providerProfileId`, `CERTIFIED_EVIDENCE`): a run may become `VERIFIED` only with host-owned, re-scored benchmark evidence for the exact provider/model profile and ecosystem. Ships empty in the preview, so `VERIFIED` is unreachable by design. |
| `schemas.ts` | JSON Schema documents for every persisted v1 artifact, including `PATCH_SET_SCHEMA_V1` — the provider-bound wire schema for structured patch output. |

## `src/prompts/` — what the model is told

All model-facing prose is constructed here by pure functions. Prompt modules
accept typed, already-reviewed data and perform no I/O or mutation.

| Module | Purpose |
| --- | --- |
| `direct-conversion.ts` | System and user messages for whole-file and inline direct conversion, including FileMemory rules and examples. |
| `guided-patch.ts` | Structured patch-generation messages: reviewed contract, target profile, immutable snapshot hash, compiler skills, and wrapped untrusted evidence. |
| `guided-repair.ts` | Bounded repair messages that freeze contract, snapshot, validation plan, paths, operations, and scope. |
| `provider-output.ts` | Host-enforced JSON output-contract message used only when a provider lacks native JSON Schema support. |
| `index.ts` | Prompt-builder export surface. |

## `src/agents/` — model-using application services

### `src/agents/direct/`

| Module | Purpose |
| --- | --- |
| `types.ts` | Direct-agent request, unit, progress, result, and provider-option types. |
| `languages.ts` | Language-to-extension and human-readable prompt-label mapping. |
| `marker-parser.ts` | Lightweight lexical scanner for real line, block, and JSDoc `@human` comment markers; quoted and already-commented examples stay inert. |
| `discovery.ts` | Bounded file walking and conversion-unit creation, including existing-target and unsupported-marker notices. |
| `declarations.ts` | Language-aware declared-identifier extraction, including type-led C, C++, C#, and Java declarations. |
| `replacement.ts` | Exact inline-marker byte verification plus newline-preserving indentation formatting shared by memory and application. |
| `candidate-validation.ts` | Baseline-aware pre-write syntax gate: TypeScript parser diagnostics for JS/TS and deterministic structure checks for other direct languages. Inline units are rejected only for newly introduced diagnostics. It does not claim semantic or sandbox verification. |
| `file-memory.ts` | Ephemeral declaration memory, replacement normalization, candidate-validation retry isolation, and sequential per-file generation. |
| `generation-client.ts` | One direct provider request through OpenAI-compatible chat or Ollama, using the central direct prompt builder. |
| `presentation.ts` | Stable conversion receipt and unambiguous single-code-block extraction; rejects multiple or unterminated fences. |
| `application.ts` | Stale-safe inline replacement and exclusive whole-file creation that never overwrites a sibling. |
| `index.ts` | Direct-agent export surface used by the CLI and package entry point. |

### `src/agents/guided/`

| Module | Purpose |
| --- | --- |
| `types.ts` | Guided run inputs, outputs, certification, and stored-validation options. |
| `workspace-policy.ts` | Conservative workspace selection, override merging, and validation-plan construction. |
| `patch-diff.ts` | Stable review-oriented rendering for structured patch operations. |
| `api-grounding.ts` | Static detection and evidence checks for external APIs introduced by a patch. |
| `workflow.ts` | Auditable `generateRun`, validate/repair, verified apply, and exact rollback lifecycle. Coordinates deterministic services but contains no prompt prose. |
| `index.ts` | Guided-agent export surface used by the CLI and package entry point. |

## `src/pipeline/` — deterministic execution mechanics

| Module | Purpose |
| --- | --- |
| `planner.ts` | Deterministic creation and loading of reviewed `ChangeContractV1` drafts (`foo.strict.human.json`), bound to source hash and profile fingerprint, with conservative review questions. |
| `snapshot.ts` | Isolated content-addressed workspace snapshots (`createWorkspaceSnapshot`, `cloneWorkspaceSnapshot`, `disposeWorkspaceSnapshot`) used for generation and baseline/candidate validation. |
| `patch.ts` | Constrained patch validation and atomic application (`preparePatch`, `applyPatchAtomic`, `PatchSafetyError`, `PatchPolicy`): scope/hash/anchor checks, protected/generated/lockfile refusal, traversal/symlink/binary/collision rejection, per-file atomic writes, rollback artifacts. |
| `validation.ts` | Strong container-only validation (`validateBaselineAndCandidate`, `strongSandboxAvailable`): Docker/Podman sandbox with no network, read-only root, scrubbed environment, resource limits; unchanged baseline first, then candidate; secret-scanned output. |
| `run-store.ts` | `RunStore`: durable, private, crash-safe run metadata (contracts, patches, reports, rollback artifacts) with recursive secret gating on every write. |
| `file-memory.ts` | Dependency-free static declaration/signature indexing for every language scanned by the direct path, including JavaScript regex-literal awareness. Produces exact line-range evidence without executing project code. |
| `simple.ts` | Deprecated source-compatibility re-export for `agents/direct/`; contains no implementation. |
| `workflow.ts` | Deprecated source-compatibility re-export for `agents/guided/`; contains no implementation. |

## Test map

| Test | Covers |
| --- | --- |
| `test/analyzer.test.ts`, `test/general.test.ts` | Static analysis, adapters, and the general fallback. |
| `test/config.test.ts`, `test/discovery.test.ts` | Config schema/migration and `.human` discovery. |
| `test/contracts.test.ts` | Artifact validators, canonical JSON, hashing. |
| `test/context.test.ts`, `test/documentation.test.ts` | Context selection/provenance and documentation retrieval. |
| `test/secret-scan.test.ts` | Repository credential scanning. |
| `test/provider.test.ts`, `test/providers.test.ts` | Provider contract, budgets, and HTTP adapters (injected fetch/DNS). |
| `test/certification.test.ts`, `test/release-gate.test.ts` | Certification evidence gate and release-status honesty. |
| `test/planner.test.ts`, `test/patch.test.ts`, `test/snapshot.test.ts`, `test/run-store.test.ts`, `test/validation.test.ts`, `test/guided-agent.test.ts` | Guided mechanics and lifecycle stage by stage, including apply/rollback and repair limits. |
| `test/direct-agent.test.ts` | Lexical marker discovery, FileMemory indexing/normalization, provider prompts, retry isolation, and application. |
| `test/direct-reliability.test.ts` | Regression coverage for direct issues 02 and 04–11: JSDoc, output cleanup, validation, overwrite/staleness/indent guards, regex memory, C-family declarations, and discovery notices. |
| `test/cli.test.ts` | Command surface and exit codes. |
| `test/package-smoke.mjs` | Packed-tarball install, public import, installed-CLI invocation (`npm run package:check`). |
