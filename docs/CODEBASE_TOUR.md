# A tour of the human-to-code codebase

This one's for the person who just opened the project in VS Code and thought:
**which folder do I go into, why does this file exist, and how does any of it
turn human instructions into code?**

You don't need to learn every type and security term first. Start with the two
ways people actually use the product, then use the folder and file maps as you
explore. The "Important names" column lists the functions, classes, or
types that best explain what a file is for — the tiny private helpers are left
for you to find once the file itself makes sense.

## The conclusion first: how the product works

There are two separate journeys through the product.

### 1. Direct mode: `npx human-to-code .`

Direct mode is the quick path. Most of what makes it work lives in
[`src/agents/direct/`](../src/agents/direct).

```text
You write a .human file or an @human comment
        ↓
The CLI loads configuration
        ↓
direct/discovery.ts finds each instruction and works out its target file
        ↓
ProjectMemory and FileMemory gather small, useful facts about the project
        ↓
prompts/ explains one task to the model
        ↓
generation-client.ts asks the configured model for code
        ↓
the direct validation files reject malformed or conflicting code
        ↓
application.ts writes only what was accepted
```

If `npx human-to-code .` misbehaves, start at [`src/cli.ts`](../src/cli.ts),
find `buildCommand`, then follow the imports out of
[`src/agents/direct/index.ts`](../src/agents/direct/index.ts).

### 2. Guided mode: `npx human-to-code guided .`

Guided mode is the careful, reviewable path. Its coordinator is
[`src/agents/guided/workflow.ts`](../src/agents/guided/workflow.ts), while the
mechanical work happens over in `analysis`, `context`, `providers`, and
`pipeline`.

```text
You write a .human change request
        ↓
analysis/ works out what kind of project this is, without running it
        ↓
pipeline/planner.ts creates or loads the human-reviewed change contract
        ↓
context/ picks the source and documentation the model is allowed to see
        ↓
providers/ asks the model for a structured patch — not arbitrary commands
        ↓
pipeline/patch.ts checks the patch stayed inside the reviewed scope
        ↓
pipeline/validation.ts compares unchanged and changed copies in a sandbox
        ↓
you can then explicitly apply an eligible verified run, or roll it back
```

The guided command generates and validates, but it never quietly applies the
result. The explicit `generate`, `validate`, `apply`, and `rollback` commands
call the same guided functions, one stage at a time.

## Direct and guided are different on purpose

| Question | Direct mode | Guided mode |
| --- | --- | --- |
| Main folder | `src/agents/direct/` | `src/agents/guided/` |
| Main CLI function | `buildCommand` | `guided` |
| Input | `.human` files and `@human` comments | A `.human` change request plus a reviewed contract |
| Model result | Code for one target | A structured `PatchSetV1` |
| Checks | Syntax, static relationships, combined JS/TS checks | Frozen baseline/candidate checks in a strong sandbox |
| Working-tree write | After confirmation and the direct checks | Only through the separate eligible verified apply step |
| Persistent run history | No | Yes, in the private `RunStore` |
| Can claim `VERIFIED` | No | Only when every validation and certification gate allows it |

Please don't fix a direct-mode problem in the guided folder, or a guided
lifecycle problem in the direct folder. They share low-level helpers, but they
share no orchestration and no runtime memory.

## The culture of this project

Once you know these habits, the files stop looking scattered.

1. **The model proposes; host code decides.** Model output never gets trusted
   just because it looks reasonable. Host code checks schemas, paths, hashes,
   syntax, scope, and validation results.
2. **Read before running.** Project analysis reads files statically. It doesn't
   import your application or execute your configuration.
3. **Each folder answers one question.** `analysis` asks "what project is
   this?", `context` asks "what may the model see?", `providers` asks "how do we
   talk to the model?", and `pipeline` asks "how do we safely plan, check,
   store, and apply the result?"
4. **Uncertainty stops the flow.** Missing files, unclear workspaces, partial
   scans, unavailable sandboxes, stale hashes, and unproven certification never
   turn into success.
5. **Names describe lifecycle roles.** Functions like
   `discoverHumanInstructionSources` and `applyVerifiedCodeChangeRun` are long
   on purpose — you should be able to tell which part of human-to-code they
   belong to without opening them. See [CODE_CLARITY.md](CODE_CLARITY.md).
6. **Artifacts are checkpoints.** The contract, context manifest, patch,
   validation plan, and report let you see exactly what went into and came out
   of each guided stage. See [GLOSSARY.md](GLOSSARY.md).
7. **Tests mirror ownership.** A source file usually has a test with a matching
   name. When you change a boundary, the tests should cover the normal case
   *and* the most likely unsafe or ambiguous one.

## How to explore this project in VS Code

For direct mode, open files in this order:

1. [`src/cli.ts`](../src/cli.ts) — find `buildCommand`.
2. [`src/agents/direct/discovery.ts`](../src/agents/direct/discovery.ts) — see
   how instructions become conversion units.
3. [`src/agents/direct/project-memory.ts`](../src/agents/direct/project-memory.ts)
   and [`file-memory.ts`](../src/agents/direct/file-memory.ts) — see what project
   knowledge actually reaches generation.
4. [`src/agents/direct/generation-client.ts`](../src/agents/direct/generation-client.ts)
   and [`src/prompts/direct-conversion.ts`](../src/prompts/direct-conversion.ts)
   — see how the model request gets built.
5. [`src/agents/direct/staged-validation.ts`](../src/agents/direct/staged-validation.ts)
   — see how generated files get checked together.
6. [`src/agents/direct/application.ts`](../src/agents/direct/application.ts) —
   see the final guarded write.

For guided mode, open files in this order:

1. [`src/cli.ts`](../src/cli.ts) — find `guided` or an explicit command handler.
2. [`src/analysis/analyzer.ts`](../src/analysis/analyzer.ts) — see how the
   project profile gets built.
3. [`src/pipeline/planner.ts`](../src/pipeline/planner.ts) — see how a human
   request becomes a reviewed contract.
4. [`src/agents/guided/workflow.ts`](../src/agents/guided/workflow.ts) — follow
   generation, validation, apply, and rollback.
5. [`src/context/context.ts`](../src/context/context.ts) — see how model-visible
   evidence gets selected.
6. [`src/providers/provider.ts`](../src/providers/provider.ts) — see the common
   provider boundary and schema check.
7. [`src/pipeline/patch.ts`](../src/pipeline/patch.ts) and
   [`validation.ts`](../src/pipeline/validation.ts) — see patch safety and the
   sandbox checks.

## Top-level files and folders

| Item | What and why | How it's used |
| --- | --- | --- |
| `Readme.md` | The product introduction and user commands. | Points people toward the right detailed document. |
| `CONTRIBUTING.md` | The rules every contribution has to preserve. | Doubles as the review checklist for safety, testing, and docs. |
| `SECURITY.md` | Trust boundaries and security promises. | Explains why the scans, context limits, sandboxing, and exact apply all exist. |
| `package.json` | Package identity, runtime dependencies, developer commands. | npm uses it to build, test, pack, and expose the CLI binary. |
| `src/` | All the publishable product code. | TypeScript compiles it into `dist/`. |
| `test/` | Tests mirroring the product's responsibilities. | `npm test` runs deterministic unit and integration coverage. |
| `docs/` | Explanations for users and contributors. | Keeps terminology, architecture, configuration, source culture, and file ownership apart. |
| `dist/` | Generated publishable JavaScript and declarations. | Built from `src/`. Don't edit it, don't commit it. |

## `src/`: the two entry points

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/cli.ts`](../src/cli.ts) | `runHumanToCodeCli`; internally `buildCommand`, `guided`, and the command handlers | The reception desk for every terminal command. Its job is deciding where a request goes — not implementing each feature itself. | Parses flags, loads the right handler, formats results, and turns typed outcomes and errors into exit codes. |
| [`src/index.ts`](../src/index.ts) | Re-exports only | The way in for developers importing `human-to-code` as a library. | Re-exports stable functions and types from the folders that own them, adding no behavior. |

## `src/core/`: the shared language of the program

`core` holds the ideas every other folder is allowed to use. It knows nothing
about providers, agents, the CLI, or any specific framework.

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/core/types.ts`](../src/core/types.ts) | `Config`, `ProviderConfig`, `SourceFile`, `DiscoveryResult`, `TargetLanguage` | The small shared shapes for configuration and discovered human instructions. | Defines TypeScript types and nothing else — zero runtime work. |
| [`src/core/languages.ts`](../src/core/languages.ts) | `CODE_EXTENSION_LANGUAGES`, `languageForCodeExtension` | Gives every folder one answer to "which language owns this extension?" | An immutable extension-to-language table plus a small lookup function. |
| [`src/core/contracts.ts`](../src/core/contracts.ts) | `ChangeContractV1`, `PatchSetV1`, `ValidationPlanV1`, `ValidationReportV1`, `canonicalJson`, `hashCanonical`, `validate*` | Defines the guided workflow's official records, and rejects malformed ones. | Exact-key validators, predictable JSON serialization, and SHA-256 hashes, so stored stages can't be quietly altered or mixed up. |

## `src/config/`: project-owner choices and human-file discovery

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/config/config.ts`](../src/config/config.ts) | `ConfigV1`, `DEFAULT_CONFIG`, `validateConfig`, `loadConfig`, `migrateLegacyConfig`, `defaultConfigJson` | Owns what a project operator is allowed to configure. | Reads strict versioned JSON, fills in safe defaults, rejects unknown and credential-looking fields, and validates providers, budgets, privacy, sandbox, languages, and workspace overrides. |
| [`src/config/discovery.ts`](../src/config/discovery.ts) | `discoverHumanInstructionSources`, `secretsTrackedError`, `sourceContentHash` | Finds guided `.human` requests and protected secret files, safely. | Walks regular files without following symlinks, respects bounded ignore rules for normal sources, still finds protected secrets, and hashes the exact source bytes. |

## `src/analysis/`: understand the project without running it

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/analysis/analyzer.ts`](../src/analysis/analyzer.ts) | `analyzeProject`, `DEFAULT_ECOSYSTEM_ADAPTERS` | Coordinates project recognition for guided mode. | Builds one bounded inventory, hands it to every ecosystem adapter, combines the workspaces and diagnostics, and produces a stable profile fingerprint. |
| [`src/analysis/analyzer-types.ts`](../src/analysis/analyzer-types.ts) | `ProjectProfileV1`, `WorkspaceProfileV1`, `EcosystemAdapter`, `AnalyzerContext`, `AnalyzerDiagnostic` | Gives the analyzer modules a common vocabulary. | Defines the evidence, workspace, support, command, and diagnostic shapes that adapters and consumers share. |
| [`src/analysis/analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `scanProject`, `createAnalyzerContext`, `finalizeWorkspace`, `evidenceFor`, parsing and path helpers | Stops every adapter from reinventing risky file walking and parsing. | Bounded scans, normalized paths, simple JSON/TOML fact parsing, evidence hashing, sorted output, and absolute-root details stripped from fingerprints. |
| [`src/analysis/support-matrix.ts`](../src/analysis/support-matrix.ts) | `SUPPORT_MATRIX`, `supportFor` | Keeps support claims honest and reviewable. | Looks up declared ecosystem/version entries and returns a tier, instead of guessing from confidence. |
| [`src/analysis/adapters/node.ts`](../src/analysis/adapters/node.ts) | `NodeEcosystemAdapter`, `nodeEcosystemAdapter` | Recognizes React and NestJS projects. | Reads manifests, lockfiles, workspaces, framework signals, routes, and scripts — without importing or executing any of them. |
| [`src/analysis/adapters/python.ts`](../src/analysis/adapters/python.ts) | `FastApiEcosystemAdapter`, `fastApiEcosystemAdapter` | Recognizes FastAPI projects and Python environment choices. | Reads dependency files and source signals for routers, Pydantic, dependency injection, and sync/async patterns. |
| [`src/analysis/adapters/rust.ts`](../src/analysis/adapters/rust.ts) | `RustEcosystemAdapter`, `rustEcosystemAdapter` | Recognizes Cargo crates and workspaces. | Reads Cargo and toolchain files, detecting editions, targets, features, build scripts, proc macros, unsafe code, and FFI signals. |
| [`src/analysis/adapters/general.ts`](../src/analysis/adapters/general.ts) | `normalizeGeneralLanguage`, `buildGeneralWorkspace` | The explicit lowest-trust fallback for ecosystems nobody recognized. | Creates a preview-only workspace with no validation plan, so the run stays inconclusive rather than pretending it understood everything. |

## `src/security/`: the guards used across boundaries

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/security/secret-scan.ts`](../src/security/secret-scan.ts) | `scanProjectForSecrets`, `ProjectSecretScanError` | Catches repository credentials before any provider request goes out. | Scans first-party regular files, skips dependency and build stores, reports only path/line/kind, and fails if the scan came up partial. |
| [`src/security/pinned-http.ts`](../src/security/pinned-http.ts) | `pinnedHttpFetch`, `PinnedDestination` | Makes outbound provider and documentation requests without trusting DNS twice. | Checks resolved addresses, blocks private and unsafe destinations, pins the socket to the address it checked, verifies the TLS hostname, and rechecks redirects. |

## `src/context/`: decide what the model may see

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/context/context.ts`](../src/context/context.ts) | `ContextManifestV1`, `selectContext`, `scanSecrets`, `validateContextManifestV1`, `hashContextManifest`, `ContextRequestSession` | Picks the smallest useful, auditable context for guided generation. | Ranks candidate evidence, enforces path/range/byte/token budgets, blocks or records redactions, hashes every item, and validates any later context request. |
| [`src/context/documentation.ts`](../src/context/documentation.ts) | `OfficialDocumentationClient`, `DocumentationError` | Adds exact-version official docs when the project's own source isn't enough. | Allowlisted URLs, pinned HTTPS, bounded responses, a hash-aware cache, conditional revalidation, and strict offline behavior. |
| [`src/context/compiler-skills.ts`](../src/context/compiler-skills.ts) | `COMPILER_SKILLS`, `skillsForEcosystems` | Gives the model stable framework conventions without giving it new powers. | Stores immutable React, NestJS, FastAPI, Rust, and core guidance as plain policy data, selected by ecosystem. |
| [`src/context/compiler-tools.ts`](../src/context/compiler-tools.ts) | `CompilerToolExecutor`, `compilerToolPolicy` | Lets approved local providers ask a few extra read-only context questions. | Validates four request kinds, confines reads to the root, caps calls at eight, and returns evidence that gets added to the manifest. |

## `src/providers/`: talk to models, and distrust what they say

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/providers/provider.ts`](../src/providers/provider.ts) | `ProviderAdapter`, `ProviderBudgetTracker`, `generateValidated`, `withProviderRetries`, `ProviderError` | Defines one model-provider contract for the whole product. | Normalizes messages, results, and errors, reserves token and cost budgets before requests, limits retries, scans boundaries, and validates structured output locally. |
| [`src/providers/providers.ts`](../src/providers/providers.ts) | `OpenAIResponsesProvider`, `OllamaProvider`, `createOpenAIProvider`, `createOllamaProvider` | Implements the actual OpenAI and Ollama network formats. | Translates common provider requests into bounded HTTP calls, binds credentials to endpoints, handles local versus cloud Ollama, and returns normalized results. |
| [`src/providers/schemas.ts`](../src/providers/schemas.ts) | `PATCH_SET_SCHEMA_V1`, the other `*_SCHEMA_V1`, `ARTIFACT_SCHEMAS_V1` | Describes the JSON shapes a provider is expected to send back. | Keeps provider-facing JSON Schema next to provider code, while the host validators stay in `core/contracts.ts`. |
| [`src/providers/certification.ts`](../src/providers/certification.ts) | `CERTIFICATION_POLICY`, `CERTIFIED_EVIDENCE`, `evaluateProviderCertification`, `providerProfileId` | Stops marketing confidence from turning into `VERIFIED`. | Revalidates benchmark evidence for that exact provider/model/ecosystem profile, and fails closed when the evidence isn't there. |

## `src/prompts/`: what the model gets told

Prompt files build messages. That's it. They don't read files, call providers,
or write code. Keeping all the prose here is what makes model instructions easy
to find and review.

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/prompts/direct-conversion.ts`](../src/prompts/direct-conversion.ts) | `buildDirectConversionPrompt` | Explains one direct `.human` or `@human` task to the model. | Combines the instruction, the target, bounded FileMemory/ProjectMemory, any blueprint and todos, and strict output expectations. |
| [`src/prompts/direct-blueprint.ts`](../src/prompts/direct-blueprint.ts) | `buildDirectBlueprintPrompt` | Helps several generated files agree on names before coding starts. | Lists only the planned targets and current tree, then asks for one bounded JSON blueprint. |
| [`src/prompts/direct-todos.ts`](../src/prompts/direct-todos.ts) | `buildDirectTodoPrompt` | Turns one instruction into a checklist the coding pass should cover. | Asks for strict JSON and frames memory and blueprint material as untrusted evidence. |
| [`src/prompts/direct-integration.ts`](../src/prompts/direct-integration.ts) | `buildDirectIntegrationAuditPrompt`, `buildDirectIntegrationRepairPrompt` | Audits and repairs the relationships between generated files. | Keeps read-only JSON auditing separate from one-target raw-code repair, and limits every named path to files that were actually supplied. |
| [`src/prompts/direct-repair.ts`](../src/prompts/direct-repair.ts) | `buildDirectRepairPrompt` | Gives one generated JS/TS file a chance to fix its compiler errors. | Supplies the original request, current code, normalized diagnostics, related files, and that same bounded project memory. |
| [`src/prompts/guided-patch.ts`](../src/prompts/guided-patch.ts) | `buildGuidedPatchPrompt` | Requests a structured guided patch, within reviewed authority. | Supplies the contract, profile, snapshot hash, selected evidence, and compiler skills, while marking repository text untrusted. |
| [`src/prompts/guided-repair.ts`](../src/prompts/guided-repair.ts) | `buildGuidedRepairPrompt` | Requests implementation-only correction after an eligible guided validation failure. | Freezes the contract, snapshot, paths, operations, dependencies, tests, and validation plan around the diagnostic payload. |
| [`src/prompts/provider-output.ts`](../src/prompts/provider-output.ts) | `buildProviderOutputContractPrompt` | Helps providers that can't enforce JSON Schema natively. | Renders the host-owned schema as an output contract. Host validation still decides what's accepted. |
| [`src/prompts/index.ts`](../src/prompts/index.ts) | Re-exports only | Gives callers a single prompt import surface. | Re-exports the builders, adding no I/O and no behavior. |

## `src/pipeline/`: the safe mechanical work both agents share

The pipeline doesn't decide what the model should say. It does the repeatable
planning, snapshot, patch, validation, and storage work.

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/pipeline/planner.ts`](../src/pipeline/planner.ts) | `createDraftContract`, `writeDraftContract`, `loadReviewedContract`, `contractPathForSource` | Turns an informal guided request into a human-review checkpoint. | Builds a conservative draft, binds it to the source and profile hashes, writes it exclusively, and rejects stale or unresolved reviewed contracts. |
| [`src/pipeline/snapshot.ts`](../src/pipeline/snapshot.ts) | `createWorkspaceSnapshot`, `cloneWorkspaceSnapshot`, `disposeWorkspaceSnapshot` | Keeps generation and validation well away from your real working tree. | Copies allowed regular files into content-addressed temporary roots, rejects links and special files, clones disposable candidates, and cleans up after itself. |
| [`src/pipeline/patch.ts`](../src/pipeline/patch.ts) | `preparePatch`, `applyPatchAtomic`, `normalizePatchPath`, `computePatchSnapshotHash` | Treats model edits as an untrusted structured patch. | Checks scope, paths, base hashes, exact edit text, collisions, links, sizes, and protected files before doing per-file atomic writes, restoring on failure. |
| [`src/pipeline/validation.ts`](../src/pipeline/validation.ts) | `strongSandboxAvailable`, `validateBaselineAndCandidate` | Works out whether the generated code introduced failures. | Runs the same frozen commands on unchanged and candidate copies inside Docker/Podman, with no network and restricted resources, then compares. |
| [`src/pipeline/run-store.ts`](../src/pipeline/run-store.ts) | `RunStore`, `defaultRunStoreRoot` | Preserves guided history and stops two things mutating one run at once. | Writes private crash-safe JSON artifacts, scans every write for secrets, rejects links, and hands out per-run exclusive locks. |
| [`src/pipeline/file-memory.ts`](../src/pipeline/file-memory.ts) | `extractStaticFileMemory` | Pulls out reusable declarations for direct FileMemory. | Language-aware static scanning that returns bounded line ranges and signatures without executing your source. |
| [`src/pipeline/simple.ts`](../src/pipeline/simple.ts) | Compatibility re-export | Keeps older direct-mode source imports working. | Re-exports the direct agent. No implementation. |
| [`src/pipeline/workflow.ts`](../src/pipeline/workflow.ts) | Compatibility re-export | Keeps older guided-mode source imports working. | Re-exports the guided agent. No implementation. |

## `src/agents/direct/`: the default `npx human-to-code .` product

### Discover the work

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/direct/index.ts`](../src/agents/direct/index.ts) | Re-exports only | Gives the CLI one place to import direct features from. | Re-exports the folder's public functions and types. |
| [`src/agents/direct/types.ts`](../src/agents/direct/types.ts) | `ConversionUnit`, `GeneratedConversionUnit`, `DirectDiscoveryResult`, `GenerateOptions` | Defines what one direct task looks like as it travels through discovery, generation, validation, and application. | TypeScript types only. No runtime behavior. |
| [`src/agents/direct/discovery.ts`](../src/agents/direct/discovery.ts) | `discoverDirectUnits`, `walkDirectFiles`, plus the compatibility `discoverUnits` | Turns files and comments into runnable tasks with target paths and languages. | Walks bounded files, calls the marker parser, reads `.human` declarations, prevents overwrites and conflicts, and returns units plus notices. |
| [`src/agents/direct/marker-parser.ts`](../src/agents/direct/marker-parser.ts) | `extractInlineMarkers` | Finds real `@human` comments without mistaking examples or strings for instructions. | A lightweight lexical scanner for line, block, JSDoc, HTML, script, and style comments that skips quoted regions. |
| [`src/agents/direct/language-inference.ts`](../src/agents/direct/language-inference.ts) | `inferUnitLanguage` | Decides an instruction's language when configuration hasn't already decided it. | Checks explicit first-line declarations, file extensions, configured languages, and bounded vocabulary signals — in a fixed priority order. |
| [`src/agents/direct/languages.ts`](../src/agents/direct/languages.ts) | `LANGUAGE_PROFILES`, `languageProfile`, `resolveLanguageDeclaration` | Converts language names into the extensions and labels direct mode uses. | Leaves extension ownership to core, then adds prompt labels and the accepted declaration spellings. |

### Give generation enough project memory

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/direct/declarations.ts`](../src/agents/direct/declarations.ts) | `declaredIdentifiers` | Helps catch accidental redeclaration across a lot of languages. | Extracts declared names using defensive language-aware patterns. |
| [`src/agents/direct/file-memory.ts`](../src/agents/direct/file-memory.ts) | `FileMemory`, `generateConversionUnits` | Runs generation one unit at a time while remembering the declarations already accepted in that file. | Builds bounded context, calls the generator, validates output, retries once, rejects conflicting redeclarations, and keeps per-unit failures isolated. |
| [`src/agents/direct/project-contracts.ts`](../src/agents/direct/project-contracts.ts) | `compactFileContract`, `htmlFacts`, `cssFacts`, `javaScriptFacts` | Summarizes project relationships without shipping whole files. | Extracts imports, declarations, manifests, HTML references, CSS selectors and assets, and DOM selectors into compact secret-checked text and facts. |
| [`src/agents/direct/project-memory.ts`](../src/agents/direct/project-memory.ts) | `ProjectMemory`, `buildProjectMemory` | Gives each generation request a small view of the relevant current and planned files. | Indexes discovered paths by directory and relationship, renders bounded nearby contracts, tracks planned outputs, and learns contracts from accepted candidates. |
| [`src/agents/direct/project-blueprint.ts`](../src/agents/direct/project-blueprint.ts) | `ProjectBlueprint`, `parseProjectBlueprint`, `renderBlueprintFor`, `blueprintNames` | Lets separately generated files share a target list and a naming vocabulary. | Strictly parses bounded JSON, rejects invented paths and names, and renders only the part relevant to one target. |
| [`src/agents/direct/unit-todos.ts`](../src/agents/direct/unit-todos.ts) | `parseUnitTodoList`, `todoCoverage`, `contractRegression`, `acceptsRefinement` | Measures whether a coding response actually covered the instruction, and stops a refinement from losing earlier work. | Parses bounded todo JSON, checks for expected artifacts in the code, and compares compact before/after contracts as a one-way quality ratchet. |

### Ask the model and present the plan

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/direct/generation-client.ts`](../src/agents/direct/generation-client.ts) | `generateCode`, `generateBlueprint`, `generateUnitTodos`, `generateIntegrationAudit`, `generateIntegrationRepairCode`, `generateRepairCode` | The direct agent's only gateway to model requests. | Picks the matching prompt builder, sends OpenAI-compatible or Ollama requests, bounds the output, and hands text back to the caller for host validation. |
| [`src/agents/direct/presentation.ts`](../src/agents/direct/presentation.ts) | `renderReceipt`, `plannedRequestCounts`, `conditionalRequestAllowance`, `stripCodeFence` | Shows you what direct mode plans to do, and safely digs the code out of the model's presentation. | Builds a stable receipt and request estimate, and accepts either raw code or exactly one complete fenced block. |

### Check generated files before writing

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/direct/candidate-validation.ts`](../src/agents/direct/candidate-validation.ts) | `validateGeneratedUnit`, `candidateTextForUnit` | Rejects obviously malformed single-file output early. | Compares inline output against baseline diagnostics, uses TypeScript parsing for JS/TS, and structural/non-empty checks for everything else. |
| [`src/agents/direct/candidate-overlay.ts`](../src/agents/direct/candidate-overlay.ts) | `buildCandidateOverlay`, `unitParticipatesInProjectValidation`, `overlayPathKey` | Builds the project as it *would* look after all accepted JS/TS changes, without writing any of it. | Combines whole-file candidates and inline replacements in memory, leaving out stale and conflicting units. |
| [`src/agents/direct/program-diagnostics.ts`](../src/agents/direct/program-diagnostics.ts) | `createValidationProgramContext`, `collectProjectDiagnostics`, `newlyIntroducedProjectDiagnostics` | Finds the cross-file TypeScript and opted-in JavaScript problems. | Creates a TypeScript program over the overlay and compares candidate diagnostics against the unchanged baseline. |
| [`src/agents/direct/dependency-graph.ts`](../src/agents/direct/dependency-graph.ts) | `buildOverlayDependencyGroups`, `attributeDiagnostics` | Decides which generated files should fail together when imports connect them. | Resolves imports into groups and maps diagnostics back to the smallest safe set of conversion units. |
| [`src/agents/direct/staged-validation.ts`](../src/agents/direct/staged-validation.ts) | `validateCandidateProject` | Coordinates combined project checking plus one bounded repair per failing whole-file unit. | Builds the overlay, runs program diagnostics, groups the failures, calls the repair callback, rebuilds a fresh overlay, and returns accepted/rejected results. |
| [`src/agents/direct/reference-validation.ts`](../src/agents/direct/reference-validation.ts) | `collectReferenceFindings`, `scanCssRules`, `selectorSpecificity`, `hasBlockingFindings` | Catches the deterministic browser-file mistakes that compilation would miss. | Cross-checks HTML assets/ids/classes, CSS selectors/imports/URLs, JavaScript selectors, and reveal/hidden cascade rules. |
| [`src/agents/direct/language-relationships.ts`](../src/agents/direct/language-relationships.ts) | `LANGUAGE_RELATIONSHIP_RULES`, `languageRelationshipRole`, `relationshipReferenceDescription` | Describes which files in different languages are likely to work together. | Declarative extension, path, and reference rules — rather than ecosystem branches hard-coded into the orchestration. |
| [`src/agents/direct/integration-validation.ts`](../src/agents/direct/integration-validation.ts) | `reconcileGeneratedIntegrations`, `parseIntegrationAuditOutput`, `generatedRelationshipsFor` | Asks the model to audit and repair the relationships between generated files. | Builds bounded related groups, validates strict audit JSON against real paths, allows one repair per target, verifies again, and rejects groups that stay unresolved. |

### Write accepted code

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/direct/replacement.ts`](../src/agents/direct/replacement.ts) | `formatInlineReplacement`, `replaceInlineMarker` | Replaces exactly the comment that held an `@human` instruction, and nothing else. | Verifies the original marker bytes haven't changed, then applies newline and indentation formatting to the replacement. |
| [`src/agents/direct/application.ts`](../src/agents/direct/application.ts) | `applyWholeFileBatch`, `applyUnit`, `pathExists` | Does the final direct-mode write to your working tree. | Creates whole files exclusively with rollback if a later create fails, and applies inline replacements only after the stale-range checks pass. |

## `src/agents/guided/`: coordinate the reviewed lifecycle

| File | Important names | What and why | How it does the job |
| --- | --- | --- | --- |
| [`src/agents/guided/index.ts`](../src/agents/guided/index.ts) | Re-exports only | Gives the CLI and library one guided import surface. | Re-exports the guided types, policy, diff, grounding, and workflow functions. |
| [`src/agents/guided/types.ts`](../src/agents/guided/types.ts) | `GenerateRunOptions`, `ValidateStoredRunOptions`, `WorkflowOutcome`, the certification types | Defines what callers hand in and get back for each guided stage. | Typed options and outcomes, so the workflow never depends on CLI parsing. |
| [`src/agents/guided/workspace-policy.ts`](../src/agents/guided/workspace-policy.ts) | `targetWorkspaces`, `resolveWorkspaceConfig`, `createValidationPlan`, `collectUniqueValues` | Freezes one consistent workspace/provider/context/validation policy before generation starts. | Matches reviewed workspace IDs, merges overrides conservatively, rejects conflicts, and builds commands from analyzer evidence. |
| [`src/agents/guided/api-grounding.ts`](../src/agents/guided/api-grounding.ts) | `assertExternalApisGrounded` | Stops a patch from introducing external APIs with no matching project or docs evidence. | Extracts the introduced imports and uses, then compares them against workspace dependencies and the context manifest. |
| [`src/agents/guided/patch-diff.ts`](../src/agents/guided/patch-diff.ts) | `renderPatchDiff` | Gives people a stable review view of structured operations. | Renders create, edit, delete, and rename operations in deterministic order — without applying any of them. |
| [`src/agents/guided/workflow.ts`](../src/agents/guided/workflow.ts) | `buildGuidedContextPreview`, `generateGuidedCodeChangeRun`, `validateGuidedCodeChangeRun`, `applyVerifiedCodeChangeRun`, `rollbackAppliedCodeChangeRun` | The guided coordinator. It decides the order of the trusted checkpoints, not the internals of each one. | Creates run records and snapshots, persists artifacts, calls the context/provider/patch/validation services, manages bounded repairs, checks provenance and certification, writes rollback data before apply, and reverses exactly the operations that were applied. |

## Where should you make a change?

| What feels wrong to the user? | Start in |
| --- | --- |
| A CLI flag, command, output, or exit code | [`src/cli.ts`](../src/cli.ts) |
| A `.human` or `@human` request wasn't found | Direct discovery and the marker parser; guided configuration discovery |
| Wrong output filename or language | Direct discovery, language inference, the language registries |
| The model didn't understand the request | The matching file in [`src/prompts/`](../src/prompts), then whatever produces its memory or context |
| A model request or provider format failed | The direct generation client, or [`src/providers/`](../src/providers) |
| Generated code was wrongly accepted or rejected | Direct candidate/staged/integration/reference validation, or the guided patch/validation pipeline |
| A project type or framework was detected wrong | The [`src/analysis/`](../src/analysis) adapter and the support matrix |
| The wrong files or docs reached guided generation | [`src/context/`](../src/context) |
| A patch escaped scope, went stale, or applied wrong | [`src/pipeline/patch.ts`](../src/pipeline/patch.ts) |
| The sandbox/build/test comparison is wrong | [`src/pipeline/validation.ts`](../src/pipeline/validation.ts) |
| A guided status, repair, apply, or rollback is wrong | [`src/agents/guided/workflow.ts`](../src/agents/guided/workflow.ts) |
| A stored run is missing, corrupt, or locked | [`src/pipeline/run-store.ts`](../src/pipeline/run-store.ts) |
| Naming or comments are unclear | [CODE_CLARITY.md](CODE_CLARITY.md) and the file that owns them |

## A final reading habit

When you open a file you don't know:

1. Read the header comment at the top — it should tell you what the file is for.
2. Look at the imports to see which earlier layer feeds it.
3. Look at the exports to see what a later layer can ask it to do.
4. Find the test with the matching name before you change any behavior.
5. Ask whether this file **reads**, **generates**, **validates**, **stores**, or
   **writes**. A file should normally own exactly one of those.

That's the culture this project is going for: lots of small, explicit boundaries
so you can always see where human intent becomes model input, where model output
becomes candidate code, and where candidate code finally gets allowed — or
refused — to become real code in your project.
