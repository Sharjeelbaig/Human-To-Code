# Architecture glossary

Plain-English definitions for the terms that show up all over the
`human-to-code` codebase and docs. The emojis are just memory aids  -  they aren't
part of any technical name. The related-code columns point you at the main
implementation files and symbols, and a few concepts deliberately span more than
one layer.

For the rules those source names and comments follow, see
[CODE_CLARITY.md](CODE_CLARITY.md). To see where these terms live and how the
files actually cooperate, read [CODEBASE_TOUR.md](CODEBASE_TOUR.md).

## Core

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 📜 **Contract** | [`contracts.ts`](../src/core/contracts.ts) | `ARTIFACT_SCHEMA_VERSION`, `ArtifactValidationError` | A strict, versioned JSON record handed from one pipeline stage to the next. | So no stage can quietly change or misread a request on its way through. |
| 📝 **`ChangeContractV1`** | [`contracts.ts`](../src/core/contracts.ts), [`planner.ts`](../src/pipeline/planner.ts) | `ChangeContractV1`, `validateChangeContractV1`, `createDraftContract` | The reviewed agreement spelling out the requested change, its requirements, risks, allowed files, and acceptance criteria. | It's what stops the model from handing itself more authority or scope. |
| 🧩 **`PatchSetV1`** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `PatchSetV1`, `PatchOperationV1`, `validatePatchSetV1`, `preparePatch` | A structured set of proposed file operations: create, edit, and so on. | The host can inspect and validate model output before any of it lands. |
| 🧪 **`ValidationPlanV1`** | [`contracts.ts`](../src/core/contracts.ts), [`validation.ts`](../src/pipeline/validation.ts) | `ValidationPlanV1`, `ValidationCommandV1`, `validateValidationPlanV1` | The fixed list of commands and manual checks used to judge a change. | A generated patch doesn't get to pick or weaken its own tests. |
| 📊 **`ValidationReportV1`** | [`contracts.ts`](../src/core/contracts.ts), [`validation.ts`](../src/pipeline/validation.ts) | `ValidationReportV1`, `validateValidationReportV1`, `validateBaselineAndCandidate` | What happened when the validation plan ran against both the original and the changed project. | It records what passed, what failed, and what simply couldn't be verified. |
| 🗂️ **`RunRecordV1`** | [`contracts.ts`](../src/core/contracts.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `RunRecordV1`, `validateRunRecordV1`, `RunStore` | The record of one guided run and where it currently stands. | It's the link between the contract, patch, validation, provider, and every other artifact. |
| 🔢 **Schema version** | [`contracts.ts`](../src/core/contracts.ts), [`config.ts`](../src/config/config.ts) | `ARTIFACT_SCHEMA_VERSION`, `CONFIG_SCHEMA_VERSION` | A number describing an artifact or configuration format. | Formats can evolve without silently changing what older data meant. |
| ✅ **Exact validation** | [`contracts.ts`](../src/core/contracts.ts), [`config.ts`](../src/config/config.ts) | `validateChangeContractV1`, `validatePatchSetV1`, `validateConfig` | Validation that rejects missing, malformed, *and* unknown fields. | It catches honest mistakes and keeps hidden input from steering the workflow. |
| 🗣️ **Language registry** | [`languages.ts`](../src/core/languages.ts) | `CODE_EXTENSION_LANGUAGES`, `languageForCodeExtension` | The shared mapping from source-file extensions to programming languages. | Discovery and validation identify supported files the same way. |
| 📦 **Serialization** | [`contracts.ts`](../src/core/contracts.ts) | `JsonValue`, `canonicalJson` | Turning an in-memory value into text  -  usually JSON  -  so it can be stored or sent. | Artifacts have to be saved, compared, transmitted, and audited. |
| 📐 **Canonical serialization** | [`contracts.ts`](../src/core/contracts.ts) | `canonicalJson`, `hashCanonical` | Turning JSON into one fixed, predictable representation every time. This project uses RFC 8785-style key ordering with stricter JSON inputs. | Equivalent data serializes identically, which means it hashes identically. |
| #️⃣ **Hashing** | [`contracts.ts`](../src/core/contracts.ts) | `sha256Text`, `sha256Bytes`, `hashCanonical` | A fixed-length fingerprint of some data. SHA-256 here. | It pins down exact contents and makes later changes obvious. |
| 🔗 **Provenance** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `FileDigestV1`, `contractHash`, `snapshotHash`, `computePatchSnapshotHash` | The record of where an artifact came from and which inputs produced it. | It stops a patch or report from being reused against the wrong request or project state. |
| 🧬 **Project fingerprint** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`contracts.ts`](../src/core/contracts.ts) | `ProjectProfileV1.fingerprint`, `ChangeContractV1.projectFingerprint` | A hash standing in for the statically analyzed project profile. | It ties a reviewed request to the exact project structure that got analyzed. |

## Human instructions and discovery

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 📄 **`.human` file** | [`types.ts`](../src/core/types.ts), [`discovery.ts`](../src/config/discovery.ts), [`discovery.ts`](../src/agents/direct/discovery.ts) | `SourceFile`, `discoverHumanInstructionSources`, `discoverDirectUnits` | A file holding a natural-language code request. | It gives a generation task its own separate, reviewable source. |
| 💬 **`@human` marker** | [`marker-parser.ts`](../src/agents/direct/marker-parser.ts) | `InlineMarker`, `extractInlineMarkers` | A natural-language instruction sitting inside a supported source-code comment. | It puts the request right next to the code it's about. |
| 🔍 **Discovery** | [`discovery.ts`](../src/config/discovery.ts), [`discovery.ts`](../src/agents/direct/discovery.ts) | `discoverHumanInstructionSources`, `DiscoveryError`, `discoverUnits` | Finding `.human` files and valid `@human` comment markers without running any project code. | It decides which instructions actually get processed. |
| 🧭 **Output routing** | [`discovery.ts`](../src/agents/direct/discovery.ts), [`language-inference.ts`](../src/agents/direct/language-inference.ts) | `discoverDirectUnits`, `inferUnitLanguage` | The rules picking the output language, filename, and destination for a request. | Generated code ends up in the file and format you meant. |
| 🚫 **Protected file** | [`discovery.ts`](../src/config/discovery.ts), [`context.ts`](../src/context/context.ts), [`contracts.ts`](../src/core/contracts.ts) | `secretsTrackedError`, `isProtectedContextPath`, `isHardProtectedPatchPath` | A file that must never be read, transmitted, generated, or modified  -  a credentials file, for instance. | Sensitive and internal files stay completely outside generation. |

## Configuration

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 🛠️ **Configuration validation** | [`config.ts`](../src/config/config.ts) | `validateConfig`, `ConfigError`, `CONFIG_SCHEMA_VERSION` | Checking configuration fields, types, values, and schema version. | Unsafe, misspelled, or unknown settings fail before anything gets generated. |
| 📋 **`human-to-code.config.json`** | [`config.ts`](../src/config/config.ts) | `CONFIG_FILENAME`, `ConfigV1`, `loadConfig` | Project-level policy covering languages, providers, privacy, budgets, sandboxing, and the rest. | The project owner decides how the tool behaves, explicitly. |
| 🏭 **Default configuration** | [`config.ts`](../src/config/config.ts) | `DEFAULT_CONFIG`, `defaultConfigJson`, `defaultModelFor` | The safe settings used when you leave an optional value out. | Behavior stays predictable without quietly switching on sensitive capabilities. |
| 🌐 **Provider configuration** | [`config.ts`](../src/config/config.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderConfigV1`, `validateProviderBaseUrl`, `createOpenAIProvider`, `createOllamaProvider` | The settings choosing a model provider, model, endpoint, and credential environment variable. | Model access and endpoint trust stay explicit rather than implied. |
| 💰 **Budget policy** | [`config.ts`](../src/config/config.ts), [`provider.ts`](../src/providers/provider.ts) | `BudgetConfigV1`, `ProviderBudgetTracker`, `DEFAULT_PROVIDER_BUDGETS` | Limits on requests, tokens, response sizes, and estimated cost. | It puts a limit on provider activity and on unexpected cost. |
| 🔐 **Environment-only credentials** | [`config.ts`](../src/config/config.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderConfigV1.apiKeyEnv`, `validateConfig` | Config stores the *name* of an environment variable, never an API key value. | Credentials are far less likely to end up in source control or run artifacts. |

## Static analysis

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 🔬 **Static analyzer** | [`analyzer.ts`](../src/analysis/analyzer.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `analyzeProject`, `DEFAULT_ECOSYSTEM_ADAPTERS` | Code that examines project files without importing or running the project. | It learns the project's structure without executing code that might not be safe. |
| 🔌 **Ecosystem adapter** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`adapters/`](../src/analysis/adapters) | `EcosystemAdapter`, `DEFAULT_ECOSYSTEM_ADAPTERS` | A read-only analyzer for one ecosystem  -  Node.js, FastAPI, Rust, and so on. | It recognizes framework structure, versions, workspaces, and possible checks. |
| 🗺️ **Project profile** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer.ts`](../src/analysis/analyzer.ts) | `ProjectProfileV1`, `WorkspaceProfileV1`, `analyzeProject` | A structured description of the workspaces, ecosystems, versions, evidence, and validation options that were detected. | Later stages get one stable understanding of the target project. |
| 🏢 **Workspace** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`workspace-policy.ts`](../src/agents/guided/workspace-policy.ts) | `WorkspaceProfileV1`, `targetWorkspaces`, `resolveWorkspaceConfig` | One application, package, crate, or service inside a project or monorepo. | Analysis, context, and validation stay pointed at the right part of the repo. |
| 📚 **Support matrix** | [`support-matrix.ts`](../src/analysis/support-matrix.ts) | `SUPPORT_MATRIX`, `SUPPORT_MATRIX_VERSION`, `supportFor` | The declared list of recognized ecosystems, variants, versions, and support levels. | The analyzer reports support from written-down policy instead of guessing. |
| 🟡 **Preview support** | [`support-matrix.ts`](../src/analysis/support-matrix.ts) | `SupportMatrixEntry.tier`, `supportFor` | Functionality that's implemented but hasn't passed the full certification standard. | We can tell you something exists without promising more than it can do. |
| 🌫️ **General fallback** | [`general.ts`](../src/analysis/adapters/general.ts), [`analyzer.ts`](../src/analysis/analyzer.ts) | `buildGeneralWorkspace`, `analyzeProject` | The lowest-trust profile, used when no known ecosystem turns up and config allows it. | It can still produce a reviewable patch  -  it just can't claim real verification. |
| 🧾 **Evidence** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `AnalysisEvidenceV1`, `evidenceFor`, `finalizeWorkspace` | The locations, hashes, versions, and facts behind an analyzer conclusion. | Analysis stays explainable and auditable after the fact. |
| ⚠️ **Diagnostic** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `AnalyzerDiagnostic`, `compareDiagnostics` | A structured warning or error about ambiguity, missing information, or unsupported behavior. | The tool can tell you *why* it stopped instead of guessing and moving on. |

## Security

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 🔎 **Secret scan** | [`secret-scan.ts`](../src/security/secret-scan.ts), [`context.ts`](../src/context/context.ts) | `scanProjectForSecrets`, `scanSecrets`, `ProjectSecretScanError` | A repository-wide scan for credential-looking values before any provider access. | It cuts the risk of shipping passwords, tokens, API keys, or private keys somewhere. |
| 🧱 **Fail-closed** | [`secret-scan.ts`](../src/security/secret-scan.ts), [`analyzer.ts`](../src/analysis/analyzer.ts), [`certification.ts`](../src/providers/certification.ts) | `ProjectSecretScanError`, `analyzeProject`, `evaluateProviderCertification` | Refusing to continue when a safety check is incomplete, ambiguous, or unavailable. | Uncertainty never gets mistaken for safety or success. |
| 🌐 **Pinned HTTPS** | [`pinned-http.ts`](../src/security/pinned-http.ts) | `pinnedHttpFetch`, `PinnedDestination` | HTTPS that connects to a DNS-vetted address while TLS verifies the reviewed hostname. | It blocks private-network access, unsafe redirects, and DNS rebinding. |
| 🚧 **Trust boundary** | [`context.ts`](../src/context/context.ts), [`provider.ts`](../src/providers/provider.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `scanSecrets`, `generateValidated`, `RunStore` | A point where data crosses between areas with different levels of trust. | Data gets scanned and validated before it's allowed across. |
| 🎭 **Prompt injection** | [`guided-patch.ts`](../src/prompts/guided-patch.ts), [`guided-repair.ts`](../src/prompts/guided-repair.ts) | `buildGuidedPatchPrompt`, `buildGuidedRepairPrompt` | Untrusted text trying to talk the model into ignoring policy or claiming authority. | Repository text and documentation stay evidence  -  never instructions the model has to follow. |
| ✂️ **Redaction** | [`context.ts`](../src/context/context.ts) | `ContextRedactionV1`, `scanSecrets`, `selectContext` | Removing sensitive content while still recording that something was removed. | Reports stay useful without carrying a secret value around. |
| 🔒 **Root confinement** | [`context.ts`](../src/context/context.ts), [`patch.ts`](../src/pipeline/patch.ts) | `isProtectedContextPath`, `normalizePatchPath`, `preparePatch` | Keeping file access inside the approved project root. | It prevents path traversal out into unrelated files on your machine. |
| 🔗 **Symlink and hardlink protection** | [`discovery.ts`](../src/config/discovery.ts), [`patch.ts`](../src/pipeline/patch.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `discoverHumanInstructionSources`, `preparePatch`, `createWorkspaceSnapshot` | Rejecting file-link tricks that could escape the project or hit unexpected files. | A path that looks safe can't secretly point somewhere else. |

## Context, providers, and prompts

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 🧳 **Context** | [`context.ts`](../src/context/context.ts) | `ContextCandidateV1`, `ContextEvidenceV1`, `selectContext` | The source, tests, configuration, and documentation handed to the model. | The model gets what's relevant without receiving your entire repository. |
| 📑 **`ContextManifestV1`** | [`context.ts`](../src/context/context.ts), [`schemas.ts`](../src/providers/schemas.ts) | `ContextManifestV1`, `validateContextManifestV1`, `CONTEXT_MANIFEST_SCHEMA_V1` | A record of every selected context item  -  its source, location, reason, hash, and redactions. | It shows you exactly what the model was allowed to see. |
| 🎯 **Context selection** | [`context.ts`](../src/context/context.ts) | `selectContext`, `ContextSelectionOptions`, `hashContextManifest` | Ranking and picking the evidence that's actually relevant to the reviewed request. | It limits disclosure, noise, token spend, and injection exposure all at once. |
| 📖 **Official documentation** | [`documentation.ts`](../src/context/documentation.ts) | `OfficialDocumentationClient`, `DocumentationRequestV1`, `DocumentationError` | Allowlisted, exact-version documentation fetched under strict network and caching rules. | Generated API usage can be grounded in the dependency's real docs. |
| 📴 **Offline mode** | [`config.ts`](../src/config/config.ts), [`documentation.ts`](../src/context/documentation.ts) | `DocumentationMode`, `DocumentationConfigV1`, `OfficialDocumentationClient` | A mode that forbids online documentation retrieval outright. | You can guarantee grounding touches the network zero times. |
| 🧰 **Compiler skills** | [`compiler-skills.ts`](../src/context/compiler-skills.ts) | `COMPILER_SKILLS`, `CompilerSkillV1`, `skillsForEcosystems` | Fixed, non-executable ecosystem guidance handed to the model. | It communicates conventions without granting a scrap of extra authority. |
| 🔧 **Compiler tools** | [`compiler-tools.ts`](../src/context/compiler-tools.ts), [`provider.ts`](../src/providers/provider.ts) | `CompilerToolExecutor`, `compilerToolPolicy`, `COMPILER_CONTEXT_TOOLS` | Bounded, read-only context requests, available only to approved local providers. | A little extra inspection stays root-confined and auditable. |
| 📏 **Context budget** | [`context.ts`](../src/context/context.ts) | `ContextBudgetV1`, `DEFAULT_CONTEXT_BUDGET`, `ContextRequestSession` | Limits on context files, bytes, and estimated tokens. | It caps disclosure, processing, and cost together. |
| 🤖 **Provider** | [`provider.ts`](../src/providers/provider.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderAdapter`, `OpenAIResponsesProvider`, `OllamaProvider` | The service or local runtime running the language model  -  OpenAI, Ollama, and so on. | It's what actually generates code or structured patch proposals. |
| 🔌 **Provider adapter** | [`provider.ts`](../src/providers/provider.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderAdapter`, `createOpenAIProvider`, `createOllamaProvider` | One common interface wrapped around provider-specific APIs and response formats. | The pipeline uses providers consistently without depending on one vendor. |
| 📨 **Prompt** | [`prompts/`](../src/prompts) | `buildDirectConversionPrompt`, `buildGuidedPatchPrompt`, `buildGuidedRepairPrompt` | The structured instructions and evidence sent to the model. | It states the task and the boundaries the model has to stay inside. |
| 🧾 **JSON Schema** | [`schemas.ts`](../src/providers/schemas.ts), [`provider.ts`](../src/providers/provider.ts) | `PATCH_SET_SCHEMA_V1`, `ARTIFACT_SCHEMAS_V1`, `JsonSchemaV1` | A machine-readable description of the JSON response shape that's required. | Provider output gets constrained to the patch format we expect. |
| 🪪 **Model identity** | [`contracts.ts`](../src/core/contracts.ts), [`provider.ts`](../src/providers/provider.ts) | `ProviderIdentityV1`, `ProviderGenerationResultV1.resolvedModel` | The provider and model identifier reported back for a request. | A run records which model produced it, without overclaiming weight reproducibility. |
| 🏅 **Provider certification** | [`certification.ts`](../src/providers/certification.ts) | `CERTIFICATION_POLICY`, `CERTIFIED_EVIDENCE`, `evaluateProviderCertification` | Benchmark evidence for one exact provider, model profile, and ecosystem. | Only eligible certified results are ever allowed to reach `VERIFIED`. |
| 🔁 **Bounded retry** | [`provider.ts`](../src/providers/provider.ts) | `withProviderRetries`, `RetryProviderOptions`, `normalizeProviderError` | A small, fixed number of retries, only for approved temporary failures. | Temporary errors can recover without uncontrolled requests or cost. |

## Pipeline and generation

| Term | Where it lives | Key names | What it is | Why it's there |
| --- | --- | --- | --- | --- |
| 🗺️ **Planner** | [`planner.ts`](../src/pipeline/planner.ts) | `createDraftContract`, `writeDraftContract`, `loadReviewedContract` | Builds a draft `ChangeContractV1` from a `.human` request plus the project profile. | It turns informal language into a precise artifact a human can review. |
| 📸 **Snapshot** | [`snapshot.ts`](../src/pipeline/snapshot.ts) | `WorkspaceSnapshot`, `createWorkspaceSnapshot`, `cloneWorkspaceSnapshot`, `disposeWorkspaceSnapshot` | An isolated copy of the project at one particular state. | Generation and validation work on stable files without touching your real project. |
| 🟢 **Baseline** | [`validation.ts`](../src/pipeline/validation.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `ValidationComparisonOptions.baselineRoot`, `validateBaselineAndCandidate` | The unchanged project snapshot. | It reveals the failures that were already there before the proposed change. |
| 🟠 **Candidate** | [`validation.ts`](../src/pipeline/validation.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `ValidationComparisonOptions.candidateRoot`, `cloneWorkspaceSnapshot` | A separate snapshot with the proposed patch applied. | Changed code gets tested without your working tree being involved. |
| 🧯 **Patch safety checks** | [`patch.ts`](../src/pipeline/patch.ts), [`contracts.ts`](../src/core/contracts.ts) | `preparePatch`, `PatchSafetyError`, `validatePatchSetV1` | Checks on paths, hashes, anchors, sizes, operation types, and protected files. | Unsafe, stale, malformed, or out-of-scope patches are rejected before execution. |
| ⚓ **Edit anchor** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `EditPatchOperationV1.oldText`, `preparePatch` | The exact existing text marking where an edit is allowed to happen. | It keeps a fuzzy edit from landing on the wrong code. |
| 🧪 **Validation** | [`validation.ts`](../src/pipeline/validation.ts) | `validateBaselineAndCandidate`, `ValidationComparisonOptions`, `ValidationError` | Running the approved checks against both baseline and candidate. | It spots regressions and evaluates the automated acceptance criteria. |
| 📦 **Strong sandbox** | [`validation.ts`](../src/pipeline/validation.ts) | `StrongSandboxOptions`, `strongSandboxAvailable`, `validateBaselineAndCandidate` | An isolated container with no network, restricted permissions, limited resources, and a disposable workspace. | Tests and build scripts run without normal access to your host. |
| 🗃️ **Run store** | [`run-store.ts`](../src/pipeline/run-store.ts) | `RunStore`, `defaultRunStoreRoot`, `RunStoreError` | Private storage for guided-run artifacts. | Contracts, patches, reports, and rollback data stay auditable. |
| ✅ **Apply** | [`patch.ts`](../src/pipeline/patch.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `applyPatchAtomic`, `applyVerifiedCodeChangeRun`, `ApplyResult` | Explicitly writing an eligible verified patch into the real project. | Generation and validation never quietly change your files. |
| ↩️ **Rollback** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `rollbackAppliedCodeChangeRun`, `RollbackArtifactV1`, `RunStore` | Restoring the exact pre-apply contents from a recorded rollback artifact. | An applied change can be reversed safely, as long as file provenance still matches. |
| 🔧 **Repair loop** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`guided-repair.ts`](../src/prompts/guided-repair.ts) | `validateGuidedCodeChangeRun`, `RepairAttemptV1`, `buildGuidedRepairPrompt` | A limited attempt to fix implementation content after an eligible validation failure. | The candidate can improve without the approved scope or checks shifting. |
| ⚡ **Direct mode** | [`index.ts`](../src/agents/direct/index.ts), [`cli.ts`](../src/cli.ts) | `discoverUnits`, `generateConversionUnits` | The default `npx human-to-code .` workflow for `.human` files and `@human` markers. | Fast generation with guarded writes  -  but no guided sandbox verification. |
| 🧭 **Guided mode** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`cli.ts`](../src/cli.ts) | `generateGuidedCodeChangeRun`, `validateGuidedCodeChangeRun`, `applyVerifiedCodeChangeRun`, `rollbackAppliedCodeChangeRun` | The `npx human-to-code guided .` contract, context, patch, validation, and explicit-apply workflow. | This is the auditable, safety-first lifecycle. |
| 🧠 **FileMemory** | [`file-memory.ts`](../src/agents/direct/file-memory.ts), [`file-memory.ts`](../src/pipeline/file-memory.ts) | `FileMemory`, `generateConversionUnits` | Temporary knowledge of the declarations and signatures already in a file. | Direct generation reuses existing names instead of declaring them twice. |
| 🗂️ **ProjectMemory** | [`project-memory.ts`](../src/agents/direct/project-memory.ts) | `ProjectMemory`, `buildProjectMemory` | Temporary, bounded knowledge of current and planned files and how they relate. | Independently generated files can still agree on paths, imports, and names. |
| 📝 **Blueprint** | [`project-blueprint.ts`](../src/agents/direct/project-blueprint.ts), [`direct-blueprint.ts`](../src/prompts/direct-blueprint.ts) | `ProjectBlueprint`, `parseProjectBlueprint`, `buildDirectBlueprintPrompt` | A shared direct-mode plan that fixes the file roster and naming vocabulary before any file is generated. | It's the one chance separate generation requests get to agree with each other. |
| 🔗 **Integration validation** | [`integration-validation.ts`](../src/agents/direct/integration-validation.ts), [`language-relationships.ts`](../src/agents/direct/language-relationships.ts) | `reconcileGeneratedIntegrations`, `generatedRelationshipsFor` | Checking that generated files actually refer to each other consistently. | It catches missing imports, assets, selectors, and cross-language relationships. |

## Run statuses

| Status | Where it lives | Main type or variable | What it means |
| --- | --- | --- | --- |
| ✅ **`VERIFIED`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | Every required check and eligibility gate passed. The only success status a generated run has. |
| ❓ **`NEEDS_INPUT`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | A human decision is needed, or something's missing. |
| 🚫 **`UNSUPPORTED`** | [`contracts.ts`](../src/core/contracts.ts), [`analyzer-types.ts`](../src/analysis/analyzer-types.ts) | `RunStatus`, `ProjectAnalysisStatus` | The project, feature, or condition asked about isn't supported. |
| 🌫️ **`INCONCLUSIVE`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | The available evidence can't prove success or failure either way. |
| ❌ **`FAILED`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | Generation, or a required validation step, failed. |
| 🔐 **`SECURITY_BLOCKED`** | [`contracts.ts`](../src/core/contracts.ts), [`secret-scan.ts`](../src/security/secret-scan.ts) | `RunStatus`, `ProjectSecretScanError` | A security rule stopped the run. |

## Guided workflow at a glance

📝 **Approved request** -> 📑 **selected context** -> 🧩 **proposed edits** ->
🧪 **fixed checks** -> 📊 **results** -> ✅ **explicit apply** -> ↩️ **exact rollback if needed**
