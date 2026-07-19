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
| `languages.ts` | Shared code-extension-to-language registry used by strict configuration validation and direct discovery. |
| `contracts.ts` | The versioned artifact vocabulary: `ChangeContractV1`, `PatchSetV1` (+ `PatchOperation`), `ValidationPlanV1`, `RunRecordV1`, and friends. Exact-key validators (`validateChangeContractV1`, `validatePatchSetV1`, `validateRunRecordV1`, …), canonical JSON (`canonicalJson`, `hashCanonical`), and hashing helpers (`sha256Text`, `sha256Bytes`). Raises `ArtifactValidationError`. No LLM/SDK dependency by design. |

## `src/config/` — operator policy input

| Module | Purpose |
| --- | --- |
| `config.ts` | Strict schema-v1 `human-to-code.config.json`: `validateConfig`, `DEFAULT_CONFIG`, `CONFIG_FILENAME`, enabled languages, exact `humanFileExtensions` routing, provider/pricing/privacy/sandbox/budget policy, the default-off `direct.reconcileIntegrations` switch, endpoint trust rules, and explicit alpha-config migration. Unknown keys and credential-like values are rejected; credentials are environment-variable names only. |
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
| `direct-conversion.ts` | One-target system and user messages for whole-file and inline direct conversion. The prompt contract separates the authoritative current task from untrusted FileMemory/ProjectMemory evidence, requires exact project-relative integration paths, freezes output scope to one target, and ends with a small-model-friendly silent checklist. |
| `direct-integration.ts` | Cross-language integration prompts: a read-only strict-JSON audit over bounded generated contracts/relationships, plus a separate one-target raw-code repair. File purposes, contracts, audit messages, related candidates, and ProjectMemory remain untrusted evidence. |
| `direct-repair.ts` | Bounded cross-file repair messages for one generated JS/TS unit: original instruction, current candidate, normalized compiler diagnostics, related generated files, and the same target-specific ProjectMemory, all framed as untrusted data. |
| `guided-patch.ts` | Structured patch-generation messages: reviewed contract, target profile, immutable snapshot hash, compiler skills, and wrapped untrusted evidence. |
| `guided-repair.ts` | Bounded repair messages that freeze contract, snapshot, validation plan, paths, operations, and scope. |
| `provider-output.ts` | Host-enforced JSON output-contract message used only when a provider lacks native JSON Schema support. |
| `index.ts` | Prompt-builder export surface. |

## `src/agents/` — model-using application services

### `src/agents/direct/`

| Module | Purpose |
| --- | --- |
| `types.ts` | Direct-agent request, unit, progress, result, and provider-option types. |
| `languages.ts` | Language-to-default-extension and human-readable prompt-label mapping; delegates extension ownership to the shared core registry. |
| `marker-parser.ts` | Lightweight lexical scanner for real line, block, JSDoc, and HTML `@human` comment markers. HTML scanning is tag-aware and also handles script/style comments; quoted attributes, strings, visible-text apostrophes, and already-commented examples stay inert. |
| `discovery.ts` | Bounded file walking and conversion-unit creation. Output routing prioritizes exact config mappings, consumed first-line extension or canonical language-name declarations, inner filename extensions, then deterministic inference; conflicts, existing targets, and unsupported markers produce notices. |
| `declarations.ts` | Language-aware declared-identifier extraction, including type-led C, C++, C#, and Java declarations. |
| `replacement.ts` | Exact inline-marker byte verification plus newline-preserving indentation formatting shared by memory and application. |
| `candidate-validation.ts` | Baseline-aware pre-write syntax gate: TypeScript parser diagnostics for JS/TS, deterministic structure checks for other programming languages, and non-empty/fence gates for HTML/CSS. Inline units are rejected only for newly introduced diagnostics. It does not claim semantic or sandbox verification. |
| `candidate-overlay.ts` | In-memory candidate overlay combining whole-file outputs and inline replacements for staged validation; the working tree stays unchanged and stale or conflicting units are excluded fail-closed. |
| `program-diagnostics.ts` | Combined TypeScript Compiler API validation over the candidate overlay: TypeScript is checked semantically; JavaScript follows explicit project `checkJs` or file `@ts-check` policy. Includes an overlay-aware compiler host, bundled `node:` typings, and multiplicity/location-aware baseline comparison. |
| `dependency-graph.ts` | Resolved-import dependency grouping of candidate files and bounded diagnostic-to-unit attribution; diagnostics that cannot be safely attributed fail the whole staged batch. |
| `integration-validation.ts` | Cross-language audit orchestration (on by default). It groups generated files using structured ProjectMemory relationships, validates exact audit JSON against real group paths, permits one repair per named target, verifies once, and rejects unresolved groups. Large components are split into bounded relationship neighborhoods. |
| `project-blueprint.ts` | The shared contract agreed once per run before any file is generated: strict bounded parser for the planning JSON, plus per-target rendering. Every path is checked against real planned targets; a credential-bearing blueprint is discarded. |
| `unit-todos.ts` | Per-unit todo parsing, the deterministic `todoCoverage` check, and the `contractRegression` ratchet that discards a refinement unless it preserves everything the previous pass produced. |
| `reference-validation.ts` | Deterministic cross-file reference checking over generated HTML/CSS/JS with zero model requests: missing script selectors and assets are blocking; markup/stylesheet naming drift is advisory. Includes a CSS rule scanner and specificity comparator. |
| `staged-validation.ts` | Orchestrates overlay build, combined program validation, group rejection, and the bounded per-unit repair budget (secret-scanned repair context, injected repair callback). Produces per-unit accept/reject results for the CLI. |
| `file-memory.ts` | Ephemeral declaration memory, replacement normalization, candidate-validation retry isolation, and sequential per-file generation. |
| `project-memory.ts` | Ephemeral codebase context for direct generation. Stores current and projected path inventories, planned source-to-output mappings, target-relative companion/asset paths, language package-module guidance, and secret-aware compact contracts. Renders a deterministic bounded subset per target and learns accepted candidate contracts for later generation/repair requests; it never executes source or persists a cache. |
| `project-contracts.ts` | Static language-aware summarizers used by ProjectMemory and by cross-file reference checking. Exposes structured `htmlFacts`/`cssFacts`/`javaScriptFacts` with the `*Contract` renderers formatting over them — one parser, two consumers. Extracts: imports/includes/declarations, HTML references/ids/classes/elements/inline handler calls/control labels, CSS imports/URLs/custom properties/selectors, JavaScript DOM selectors, and limited package metadata. Credential-bearing content produces no contract. |
| `language-relationships.ts` | Declarative/extensible language relationship profiles for scripts/modules, Python, Rust, Go, Java, C/C++, C#, Ruby, HTML/CSS/assets, and same-language fallbacks. Integration orchestration consumes only their structured role/path/reference output. |
| `generation-client.ts` | Direct provider requests through OpenAI-compatible chat or Ollama: one conversion request per unit plus optional bounded integration and compiler-repair requests, always using the central prompt builders. |
| `presentation.ts` | Stable conversion receipt and unambiguous single-code-block extraction; rejects multiple or unterminated fences. |
| `application.ts` | Stale-safe inline replacement plus exclusive, rollback-protected whole-file batch creation that never overwrites a sibling or knowingly leaves an earlier batch create behind after a later failure. |
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
| `test/project-memory.test.ts` | Current/projected inventory, exact web companion references, structured Python/Rust relationships, cross-request generated-contract learning, privacy filtering, hard rendering bounds, and conversion/repair prompt policy. |
| `test/integration-validation.test.ts` | Opt-in static-web link diagnostics, zero-request success, bounded reconciliation, group rejection, and integration-prompt isolation. |
| `test/direct-reliability.test.ts` | Regression coverage for direct issues 02 and 04–11: JSDoc, output cleanup, validation, overwrite/staleness/indent guards, regex memory, C-family declarations, and discovery notices. |
| `test/staged-validation.test.ts` | Issue 12 coverage: calculator-style cross-file rejection, consistent-candidate acceptance, bounded repair success and exhaustion, named-import/member/union/arity detection, baseline tolerance and multiplicity comparison, dependency-group isolation, and overlay write guards. |
| `test/cli.test.ts` | Command surface and exit codes. |
| `test/package-smoke.mjs` | Packed-tarball install, public import, installed-CLI invocation (`npm run package:check`). |
