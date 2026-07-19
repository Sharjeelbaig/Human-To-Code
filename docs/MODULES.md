# Module guide

A quick per-file map of `src/`, grouped by layer. If you're new, start with
[CODEBASE_TOUR.md](CODEBASE_TOUR.md) — it explains the product journeys, the
folder culture, and how these files actually work together. Come back here
afterward when you just need to look something up. The layers and dependency
rules are in [ARCHITECTURE.md](ARCHITECTURE.md). Tests live in `test/` and mirror
these modules by name.

## Entry points (`src/`)

| Module | What it does |
| --- | --- |
| `index.ts` | The stable public API for embedding the pipeline. Re-exports each layer's surface, grouped and commented by layer. Ships as `dist/index.js`. |
| `cli.ts` | The `human-to-code` binary: direct conversion plus the guided `analyze`, `plan`, `context`, `generate`, `validate`, `apply`, `rollback`, `check`, `migrate-config`, and `--init` commands. Owns argument parsing, exit codes (0–6), and human-readable output. All the real work is handed off to agents and deterministic services. Ships as `dist/cli.js`. |

## `src/core/` — shared primitives

| Module | What it does |
| --- | --- |
| `types.ts` | The small shared types used all over the pipeline: `Config`, `ProviderConfig`, `ProviderName`, `SourceFile`, `SourceKind`, `DiscoveryResult`, `TargetLanguage`. |
| `languages.ts` | The shared code-extension-to-language registry, used by both strict config validation and direct discovery. |
| `contracts.ts` | The versioned artifact vocabulary: `ChangeContractV1`, `PatchSetV1` (plus `PatchOperation`), `ValidationPlanV1`, `RunRecordV1`, and the rest. Also the exact-key validators (`validateChangeContractV1`, `validatePatchSetV1`, `validateRunRecordV1`, …), canonical JSON (`canonicalJson`, `hashCanonical`), and hashing helpers (`sha256Text`, `sha256Bytes`). Throws `ArtifactValidationError`. Deliberately depends on no LLM or SDK. |

## `src/config/` — operator policy coming in

| Module | What it does |
| --- | --- |
| `config.ts` | Strict schema-v1 `human-to-code.config.json` handling: `validateConfig`, `DEFAULT_CONFIG`, `CONFIG_FILENAME`, enabled languages, exact `humanFileExtensions` routing, provider/pricing/privacy/sandbox/budget policy, the default-on `direct.reconcileIntegrations` switch, endpoint trust rules, and explicit alpha-config migration. Unknown keys and credential-looking values get rejected, and credentials are environment-variable names only. |
| `discovery.ts` | Fail-closed discovery of `.human` sources and protected secret files (`discoverHumanInstructionSources`, `DiscoveryError`, `secretsTrackedError`, plus a deprecated `discover` alias). Never follows symlinks, and never lets a partial scan look like an empty success. |

## `src/analysis/` — static project intelligence

| Module | What it does |
| --- | --- |
| `analyzer.ts` | `analyzeProject`: deterministic, read-only multi-workspace profiling. Runs every ecosystem adapter over a bounded file inventory and produces a `ProjectProfileV1` with diagnostics. Falls back to the ungrounded `general` workspace only when configured to. Re-exports the analysis surface that `index.ts` consumes. |
| `analyzer-types.ts` | Versioned analyzer output types (`ProjectProfileV1`, `WorkspaceProfileV1`, `EcosystemAdapter`, `AnalyzerContext`, plus the evidence, diagnostic, and validation-command types) and `PROJECT_PROFILE_SCHEMA_VERSION`. |
| `analyzer-utils.ts` | The shared adapter infrastructure: bounded repository scanning, hashing, evidence collection, diagnostics, and `finalizeWorkspace`. |
| `support-matrix.ts` | The declared capability matrix (`SUPPORT_MATRIX`, `SUPPORT_MATRIX_VERSION`, `supportFor`) — every recognized ecosystem/variant/version profile and its tier (`certified`, `preview`, `legacy`, …). Support gets declared here. It is never inferred. |
| `adapters/node.ts` | Static recognition of React (Vite, Next, CRA, libraries, Nx) and NestJS (standalone, CLI monorepo, Nx) workspaces, with version evidence and candidate validation commands. |
| `adapters/python.ts` | Static recognition of FastAPI applications: environment manager, router and dependency layout, Pydantic, sync/async signals. |
| `adapters/rust.ts` | Static recognition of Cargo crates and workspaces: edition, toolchain, features, targets, `unsafe`/FFI, build scripts, proc macros, native dependencies. |
| `adapters/general.ts` | The ungrounded `general` fallback workspace (`buildGeneralWorkspace`). Not a peer adapter — it's a deliberate lowest-trust last resort with an empty validation plan, pinned to `INCONCLUSIVE`. |

## `src/security/` — the fail-closed guards

| Module | What it does |
| --- | --- |
| `secret-scan.ts` | The repository-wide first-party credential scan that runs before any provider access (`scanProjectForSecrets`, `ProjectSecretScanError`). Reports path, line, and kind — never the matched value. Partial scans fail closed. |
| `pinned-http.ts` | `pinnedHttpFetch`: dependency-free HTTPS transport whose socket is pinned to a DNS-vetted address while TLS keeps the reviewed hostname. Blocks userinfo, private networks, unsafe redirects, and DNS rebinding. Carries both provider and documentation traffic. |

## `src/context/` — what the model is allowed to see

| Module | What it does |
| --- | --- |
| `context.ts` | Deterministic, secret-aware context selection (`selectContext`, `hashContextManifest`). Ranks the relevant definitions, tests, and config plus dependency evidence into a `ContextManifestV1` where every item records its location, range, SHA-256, reason, and redactions. Also home to the `scanSecrets` pattern primitive reused at every trust boundary, and to `ContextSecurityError`. |
| `documentation.ts` | `OfficialDocumentationClient`: allowlisted, exact-version official documentation retrieval (built-in `docs.rs`, plus operator `officialSources`), with a version-and-content-hash cache, strict offline mode, and safe redirect/DNS revalidation. |
| `compiler-skills.ts` | `COMPILER_SKILLS` and `skillsForEcosystems`: immutable, non-executable ecosystem policy packs (React, NestJS, FastAPI, Rust, core contract scope) handed to the compiler agent. Data, not authority. |
| `compiler-tools.ts` | `CompilerToolExecutor`: the bounded read-only context-request executor, advertised only to verified loopback-local providers. At most eight host-validated requests across four kinds, and every response lands in the final manifest. |

## `src/providers/` — what the model is allowed to do

| Module | What it does |
| --- | --- |
| `provider.ts` | The provider-neutral contract: `ProviderAdapter`, `JsonSchemaV1`, budget accounting (pessimistic pre-request reservation, then usage reconciliation), normalized `ProviderError`s, bounded retries, and the schema gate `generateValidated`. |
| `providers.ts` | The bundled dependency-free HTTP adapters: `createOpenAIProvider` (Responses API, strict JSON schema) and `createOllamaProvider` (loopback-local native `format`, or Cloud/custom prompt-constrained). Endpoint-bound credentials, manual redirects, bounded response bodies. |
| `certification.ts` | The fail-closed WRITE gate (`evaluateProviderCertification`, `providerProfileId`, `CERTIFIED_EVIDENCE`). A run can only become `VERIFIED` with host-owned, re-scored benchmark evidence for that exact provider/model profile and ecosystem. It ships empty in the preview, which is precisely why `VERIFIED` is unreachable right now. |
| `schemas.ts` | JSON Schema documents for every persisted v1 artifact, including `PATCH_SET_SCHEMA_V1` — the provider-bound wire schema for structured patch output. |

## `src/prompts/` — what the model gets told

Every piece of model-facing prose is built here, by pure functions. Prompt
modules take typed, already-reviewed data and do no I/O and no mutation.

| Module | What it does |
| --- | --- |
| `direct-conversion.ts` | One-target system and user messages for whole-file and inline direct conversion. The prompt contract separates the authoritative current task from untrusted FileMemory/ProjectMemory evidence, demands exact project-relative integration paths, freezes output scope to a single target, and closes with a small-model-friendly silent checklist. |
| `direct-integration.ts` | Cross-language integration prompts: a read-only strict-JSON audit over bounded generated contracts and relationships, plus a separate one-target raw-code repair. File purposes, contracts, audit messages, related candidates, and ProjectMemory all stay untrusted evidence. |
| `direct-repair.ts` | Bounded cross-file repair messages for one generated JS/TS unit: the original instruction, the current candidate, normalized compiler diagnostics, related generated files, and that target's ProjectMemory — all of it treated as untrusted data. |
| `guided-patch.ts` | Structured patch-generation messages: reviewed contract, target profile, immutable snapshot hash, compiler skills, and wrapped untrusted evidence. |
| `guided-repair.ts` | Bounded repair messages that freeze the contract, snapshot, validation plan, paths, operations, and scope. |
| `provider-output.ts` | The host-enforced JSON output-contract message, used only when a provider has no native JSON Schema support. |
| `index.ts` | The prompt-builder export surface. |

## `src/agents/` — the services that use a model

### `src/agents/direct/`

| Module | What it does |
| --- | --- |
| `types.ts` | Direct-agent request, unit, progress, result, and provider-option types. |
| `languages.ts` | Maps languages to default extensions and human-readable prompt labels, leaving extension ownership to the shared core registry. |
| `marker-parser.ts` | A lightweight lexical scanner for real line, block, JSDoc, and HTML `@human` comment markers. HTML scanning is tag-aware and handles script and style comments too. Quoted attributes, strings, visible-text apostrophes, and already-commented examples all stay inert. |
| `discovery.ts` | Bounded file walking and conversion-unit creation. Output routing prefers exact config mappings, then a consumed first-line extension or canonical language-name declaration, then inner filename extensions, then deterministic inference. Conflicts, existing targets, and unsupported markers produce notices. |
| `declarations.ts` | Language-aware extraction of declared identifiers, including type-led C, C++, C#, and Java declarations. |
| `replacement.ts` | Exact inline-marker byte verification plus newline-preserving indentation formatting, shared by memory and application. |
| `candidate-validation.ts` | The baseline-aware pre-write syntax gate: TypeScript parser diagnostics for JS/TS, deterministic structure checks for other programming languages, and non-empty/fence gates for HTML and CSS. Inline units are rejected only for diagnostics they newly introduced. It claims no semantic or sandbox verification. |
| `candidate-overlay.ts` | The in-memory candidate overlay combining whole-file outputs and inline replacements for staged validation. The working tree stays untouched, and stale or conflicting units are excluded fail-closed. |
| `program-diagnostics.ts` | Combined TypeScript Compiler API validation over the candidate overlay. TypeScript gets checked semantically; JavaScript follows explicit project `checkJs` or file `@ts-check` policy. Includes an overlay-aware compiler host, bundled `node:` typings, and multiplicity- and location-aware baseline comparison. |
| `dependency-graph.ts` | Groups candidate files by resolved imports and attributes diagnostics back to units within bounds. Any diagnostic that can't be attributed safely fails the whole staged batch. |
| `integration-validation.ts` | Cross-language audit orchestration (on by default). Groups generated files using structured ProjectMemory relationships, validates exact audit JSON against real group paths, allows one repair per named target, verifies once, and rejects groups that stay unresolved. Large components get split into bounded relationship neighborhoods. |
| `project-blueprint.ts` | The shared contract agreed once per run, before any file is generated: a strict bounded parser for the planning JSON, plus per-target rendering. Every path is checked against real planned targets, and a blueprint carrying credentials is discarded. |
| `unit-todos.ts` | Per-unit todo parsing, the deterministic `todoCoverage` check, and the `contractRegression` ratchet that throws away a refinement unless it preserved everything the previous pass produced. |
| `reference-validation.ts` | Deterministic cross-file reference checking over generated HTML/CSS/JS with zero model requests. Missing script selectors and assets are blocking; markup and stylesheet naming drift is advisory. Includes a CSS rule scanner and specificity comparator. |
| `staged-validation.ts` | Orchestrates the overlay build, combined program validation, group rejection, and the bounded per-unit repair budget (secret-scanned repair context, injected repair callback). Produces the per-unit accept/reject results the CLI reports. |
| `file-memory.ts` | Ephemeral declaration memory, replacement normalization, candidate-validation retry isolation, and sequential per-file generation. |
| `project-memory.ts` | Ephemeral codebase context for direct generation. Holds current and projected path inventories, planned source-to-output mappings, target-relative companion and asset paths, language package-module guidance, and secret-aware compact contracts. Renders a deterministic bounded subset per target and learns accepted candidate contracts for later generation and repair requests. It never executes source and never persists a cache. |
| `project-contracts.ts` | The static language-aware summarizers used by both ProjectMemory and cross-file reference checking. Exposes structured `htmlFacts`/`cssFacts`/`javaScriptFacts` with `*Contract` renderers formatting over them — one parser, two consumers. Extracts imports/includes/declarations, HTML references/ids/classes/elements/inline handler calls/control labels, CSS imports/URLs/custom properties/selectors, JavaScript DOM selectors, and limited package metadata. Content carrying credentials produces no contract at all. |
| `language-relationships.ts` | Declarative, extensible language relationship profiles for scripts and modules, Python, Rust, Go, Java, C/C++, C#, Ruby, HTML/CSS/assets, and same-language fallbacks. The integration orchestration consumes only their structured role/path/reference output. |
| `generation-client.ts` | Direct provider requests through OpenAI-compatible chat or Ollama: one conversion request per unit, plus optional bounded integration and compiler-repair requests, always through the central prompt builders. |
| `presentation.ts` | The stable conversion receipt, and unambiguous single-code-block extraction that rejects multiple or unterminated fences. |
| `application.ts` | Stale-safe inline replacement, plus exclusive rollback-protected whole-file batch creation that never overwrites a sibling and never knowingly leaves an earlier batch create behind after a later failure. |
| `index.ts` | The direct-agent export surface used by the CLI and package entry point. |

### `src/agents/guided/`

| Module | What it does |
| --- | --- |
| `types.ts` | Guided run inputs, outputs, certification, and stored-validation options. |
| `workspace-policy.ts` | Conservative workspace selection, override merging, and validation-plan construction. |
| `patch-diff.ts` | Stable, review-oriented rendering for structured patch operations. |
| `api-grounding.ts` | Static detection and evidence checks for external APIs a patch introduces. |
| `workflow.ts` | The auditable lifecycle: `generateGuidedCodeChangeRun`, validate and repair, verified apply, and exact rollback. Coordinates deterministic services and contains no prompt prose. |
| `index.ts` | The guided-agent export surface used by the CLI and package entry point. |

## `src/pipeline/` — deterministic execution mechanics

| Module | What it does |
| --- | --- |
| `planner.ts` | Deterministic creation and loading of reviewed `ChangeContractV1` drafts (`foo.strict.human.json`), bound to the source hash and profile fingerprint, with conservative review questions attached. |
| `snapshot.ts` | Isolated content-addressed workspace snapshots (`createWorkspaceSnapshot`, `cloneWorkspaceSnapshot`, `disposeWorkspaceSnapshot`) used for generation and baseline/candidate validation. |
| `patch.ts` | Constrained patch validation and atomic application (`preparePatch`, `applyPatchAtomic`, `PatchSafetyError`, `PatchPolicy`): scope/hash/anchor checks, protected/generated/lockfile refusal, traversal/symlink/binary/collision rejection, per-file atomic writes, and rollback artifacts. |
| `validation.ts` | Strong container-only validation (`validateBaselineAndCandidate`, `strongSandboxAvailable`): a Docker/Podman sandbox with no network, a read-only root, a scrubbed environment, and resource limits. Unchanged baseline runs first, then the candidate, and the output is secret-scanned. |
| `run-store.ts` | `RunStore`: durable, private, crash-safe run metadata (contracts, patches, reports, rollback artifacts) with recursive secret gating on every single write. |
| `file-memory.ts` | Dependency-free static declaration and signature indexing for every language the direct path scans, including JavaScript regex-literal awareness. Produces exact line-range evidence without executing project code. |
| `simple.ts` | A deprecated source-compatibility re-export for `agents/direct/`. No implementation lives here. |
| `workflow.ts` | A deprecated source-compatibility re-export for `agents/guided/`. No implementation lives here. |

## Test map

| Test | What it covers |
| --- | --- |
| `test/analyzer.test.ts`, `test/general.test.ts` | Static analysis, the adapters, and the general fallback. |
| `test/config.test.ts`, `test/discovery.test.ts` | Config schema and migration, plus `.human` discovery. |
| `test/contracts.test.ts` | Artifact validators, canonical JSON, hashing. |
| `test/context.test.ts`, `test/documentation.test.ts` | Context selection and provenance, and documentation retrieval. |
| `test/secret-scan.test.ts` | Repository credential scanning. |
| `test/provider.test.ts`, `test/providers.test.ts` | The provider contract, budgets, and HTTP adapters (with injected fetch/DNS). |
| `test/certification.test.ts`, `test/release-gate.test.ts` | The certification evidence gate and release-status honesty. |
| `test/planner.test.ts`, `test/patch.test.ts`, `test/snapshot.test.ts`, `test/run-store.test.ts`, `test/validation.test.ts`, `test/guided-agent.test.ts` | Guided mechanics and the lifecycle stage by stage, including apply/rollback and repair limits. |
| `test/direct-agent.test.ts` | Lexical marker discovery, FileMemory indexing and normalization, provider prompts, retry isolation, and application. |
| `test/project-memory.test.ts` | Current and projected inventory, exact web companion references, structured Python/Rust relationships, cross-request generated-contract learning, privacy filtering, hard rendering bounds, and conversion/repair prompt policy. |
| `test/integration-validation.test.ts` | Opt-in static-web link diagnostics, zero-request success, bounded reconciliation, group rejection, and integration-prompt isolation. |
| `test/direct-reliability.test.ts` | Regression coverage for direct issues 02 and 04–11: JSDoc, output cleanup, validation, overwrite/staleness/indent guards, regex memory, C-family declarations, and discovery notices. |
| `test/staged-validation.test.ts` | Issue 12 coverage: calculator-style cross-file rejection, consistent-candidate acceptance, bounded repair success and exhaustion, named-import/member/union/arity detection, baseline tolerance and multiplicity comparison, dependency-group isolation, and overlay write guards. |
| `test/cli.test.ts` | The command surface and exit codes. |
| `test/source-clarity.test.ts` | Required module responsibility headers, and rejection of context-free exported names unless they're documented compatibility aliases. |
| `test/codebase-guide.test.ts` | That every `src/` file is still represented in the newcomer `docs/CODEBASE_TOUR.md`, including both product journeys. |
| `test/package-smoke.mjs` | Packed-tarball install, public import, and installed-CLI invocation (`npm run package:check`). |
