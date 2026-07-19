# Architecture glossary

Plain-English definitions of terms used in the `human-to-code` codebase and
documentation. Emojis are visual memory aids, not part of the technical names.
The related-code columns point contributors to the main implementation files
and symbols; some concepts intentionally span more than one layer.
For rules governing those source names and comments, see
[CODE_CLARITY.md](CODE_CLARITY.md).
For command-to-function and variable-level traces, see
[WORKFLOWS.md](WORKFLOWS.md).

## Core

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 📜 **Contract** | [`contracts.ts`](../src/core/contracts.ts) | `ARTIFACT_SCHEMA_VERSION`, `ArtifactValidationError` | A strict, versioned JSON record passed between pipeline stages. | It prevents stages from silently changing or misunderstanding a request. |
| 📝 **`ChangeContractV1`** | [`contracts.ts`](../src/core/contracts.ts), [`planner.ts`](../src/pipeline/planner.ts) | `ChangeContractV1`, `validateChangeContractV1`, `createDraftContract` | The reviewed agreement describing the requested change, requirements, risks, allowed files, and acceptance criteria. | It stops the model from expanding its own authority or scope. |
| 🧩 **`PatchSetV1`** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `PatchSetV1`, `PatchOperationV1`, `validatePatchSetV1`, `preparePatch` | A structured collection of proposed file operations such as create or edit. | The host can inspect and validate model output before applying it. |
| 🧪 **`ValidationPlanV1`** | [`contracts.ts`](../src/core/contracts.ts), [`validation.ts`](../src/pipeline/validation.ts) | `ValidationPlanV1`, `ValidationCommandV1`, `validateValidationPlanV1` | The fixed list of commands and manual checks used to evaluate a change. | The generated patch cannot choose or weaken its own tests. |
| 📊 **`ValidationReportV1`** | [`contracts.ts`](../src/core/contracts.ts), [`validation.ts`](../src/pipeline/validation.ts) | `ValidationReportV1`, `validateValidationReportV1`, `validateBaselineAndCandidate` | The results of running the validation plan against the original and changed project. | It records what passed, failed, or could not be verified. |
| 🗂️ **`RunRecordV1`** | [`contracts.ts`](../src/core/contracts.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `RunRecordV1`, `validateRunRecordV1`, `RunStore` | The record of one guided run and its current status. | It connects the contract, patch, validation, provider, and other artifacts. |
| 🔢 **Schema version** | [`contracts.ts`](../src/core/contracts.ts), [`config.ts`](../src/config/config.ts) | `ARTIFACT_SCHEMA_VERSION`, `CONFIG_SCHEMA_VERSION` | A number describing an artifact or configuration format. | Formats can evolve without silently changing the meaning of older data. |
| ✅ **Exact validation** | [`contracts.ts`](../src/core/contracts.ts), [`config.ts`](../src/config/config.ts) | `validateChangeContractV1`, `validatePatchSetV1`, `validateConfig` | Validation that rejects missing, malformed, and unknown fields. | It catches mistakes and prevents hidden input from influencing the workflow. |
| 🗣️ **Language registry** | [`languages.ts`](../src/core/languages.ts) | `CODE_EXTENSION_LANGUAGES`, `languageForCodeExtension` | The shared mapping between source-file extensions and programming languages. | Discovery and validation identify supported files consistently. |
| 📦 **Serialization** | [`contracts.ts`](../src/core/contracts.ts) | `JsonValue`, `canonicalJson` | Converting an in-memory value into text, usually JSON, so it can be stored or transferred. | Artifacts must be saved, compared, sent, and audited. |
| 📐 **Canonical serialization** | [`contracts.ts`](../src/core/contracts.ts) | `canonicalJson`, `hashCanonical` | Converting JSON data into one fixed, predictable representation every time. This project uses RFC 8785-style key ordering with stricter JSON inputs. | Equivalent data produces the same serialized text and therefore the same hash. |
| #️⃣ **Hashing** | [`contracts.ts`](../src/core/contracts.ts) | `sha256Text`, `sha256Bytes`, `hashCanonical` | Producing a fixed-length fingerprint from data; this project uses SHA-256. | It identifies exact contents and reveals later changes. |
| 🔗 **Provenance** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `FileDigestV1`, `contractHash`, `snapshotHash`, `computePatchSnapshotHash` | Information showing where an artifact came from and which inputs produced it. | It prevents a patch or report from being reused with the wrong request or project state. |
| 🧬 **Project fingerprint** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`contracts.ts`](../src/core/contracts.ts) | `ProjectProfileV1.fingerprint`, `ChangeContractV1.projectFingerprint` | A hash representing the statically analyzed project profile. | It binds a reviewed request to the project structure that was analyzed. |

## Human instructions and discovery

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 📄 **`.human` file** | [`types.ts`](../src/core/types.ts), [`discovery.ts`](../src/config/discovery.ts), [`discovery.ts`](../src/agents/direct/discovery.ts) | `SourceFile`, `discoverHumanInstructionSources`, `discoverDirectUnits` | A file containing a natural-language code request. | It provides a separate, reviewable source for a generation task. |
| 💬 **`@human` marker** | [`marker-parser.ts`](../src/agents/direct/marker-parser.ts) | `InlineMarker`, `extractInlineMarkers` | A natural-language instruction inside a supported source-code comment. | It places an inline request close to the code it concerns. |
| 🔍 **Discovery** | [`discovery.ts`](../src/config/discovery.ts), [`discovery.ts`](../src/agents/direct/discovery.ts) | `discoverHumanInstructionSources`, `DiscoveryError`, `discoverUnits` | Finding `.human` files and valid `@human` comment markers without running project code. | It determines which instructions should be processed. |
| 🧭 **Output routing** | [`discovery.ts`](../src/agents/direct/discovery.ts), [`language-inference.ts`](../src/agents/direct/language-inference.ts) | `discoverDirectUnits`, `inferUnitLanguage` | Rules that decide the output language, filename, and destination for a request. | Generated code goes to the intended location and file type. |
| 🚫 **Protected file** | [`discovery.ts`](../src/config/discovery.ts), [`context.ts`](../src/context/context.ts), [`contracts.ts`](../src/core/contracts.ts) | `secretsTrackedError`, `isProtectedContextPath`, `isHardProtectedPatchPath` | A file that must not be read, transmitted, generated, or modified, such as a credentials file. | Sensitive and internal files stay outside the generation process. |

## Configuration

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 🛠️ **Configuration validation** | [`config.ts`](../src/config/config.ts) | `validateConfig`, `ConfigError`, `CONFIG_SCHEMA_VERSION` | Checking configuration fields, types, values, and schema version. | Unsafe, misspelled, or unknown settings fail before generation. |
| 📋 **`human-to-code.config.json`** | [`config.ts`](../src/config/config.ts) | `CONFIG_FILENAME`, `ConfigV1`, `loadConfig` | Project-level policy for languages, providers, privacy, budgets, sandboxing, and related behavior. | The project owner explicitly controls how the tool operates. |
| 🏭 **Default configuration** | [`config.ts`](../src/config/config.ts) | `DEFAULT_CONFIG`, `defaultConfigJson`, `defaultModelFor` | Safe settings used when an optional value is not supplied. | Behavior remains predictable without enabling sensitive capabilities implicitly. |
| 🌐 **Provider configuration** | [`config.ts`](../src/config/config.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderConfigV1`, `validateProviderBaseUrl`, `createOpenAIProvider`, `createOllamaProvider` | Settings that select a model provider, model, endpoint, and credential environment variable. | Model access and endpoint trust remain explicit. |
| 💰 **Budget policy** | [`config.ts`](../src/config/config.ts), [`provider.ts`](../src/providers/provider.ts) | `BudgetConfigV1`, `ProviderBudgetTracker`, `DEFAULT_PROVIDER_BUDGETS` | Limits for requests, tokens, response sizes, and estimated cost. | It bounds provider activity and unexpected expense. |
| 🔐 **Environment-only credentials** | [`config.ts`](../src/config/config.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderConfigV1.apiKeyEnv`, `validateConfig` | Configuration stores an environment-variable name rather than an API-key value. | Credentials are less likely to enter source control or run artifacts. |

## Static analysis

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 🔬 **Static analyzer** | [`analyzer.ts`](../src/analysis/analyzer.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `analyzeProject`, `DEFAULT_ECOSYSTEM_ADAPTERS` | Code that examines project files without importing or running the project. | It learns project structure without executing potentially unsafe code. |
| 🔌 **Ecosystem adapter** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`adapters/`](../src/analysis/adapters) | `EcosystemAdapter`, `DEFAULT_ECOSYSTEM_ADAPTERS` | A read-only analyzer for an ecosystem such as Node.js, FastAPI, or Rust. | It recognizes framework structure, versions, workspaces, and possible checks. |
| 🗺️ **Project profile** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer.ts`](../src/analysis/analyzer.ts) | `ProjectProfileV1`, `WorkspaceProfileV1`, `analyzeProject` | A structured description of detected workspaces, ecosystems, versions, evidence, and validation options. | Later stages receive a stable understanding of the target project. |
| 🏢 **Workspace** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`workspace-policy.ts`](../src/agents/guided/workspace-policy.ts) | `WorkspaceProfileV1`, `targetWorkspaces`, `resolveWorkspaceConfig` | One application, package, crate, or service in a project or monorepo. | Analysis, context, and validation stay scoped to the correct project area. |
| 📚 **Support matrix** | [`support-matrix.ts`](../src/analysis/support-matrix.ts) | `SUPPORT_MATRIX`, `SUPPORT_MATRIX_VERSION`, `supportFor` | The declared list of recognized ecosystems, variants, versions, and support levels. | The analyzer reports support from explicit policy rather than guessing. |
| 🟡 **Preview support** | [`support-matrix.ts`](../src/analysis/support-matrix.ts) | `SupportMatrixEntry.tier`, `supportFor` | Implemented functionality that has not passed the complete certification standard. | Availability can be described without overstating reliability. |
| 🌫️ **General fallback** | [`general.ts`](../src/analysis/adapters/general.ts), [`analyzer.ts`](../src/analysis/analyzer.ts) | `buildGeneralWorkspace`, `analyzeProject` | A lowest-trust profile used when no known ecosystem is identified and configuration permits it. | It may produce a reviewable patch but cannot claim complete verification. |
| 🧾 **Evidence** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `AnalysisEvidenceV1`, `evidenceFor`, `finalizeWorkspace` | Locations, hashes, versions, and facts supporting an analyzer conclusion. | Analysis stays explainable and auditable. |
| ⚠️ **Diagnostic** | [`analyzer-types.ts`](../src/analysis/analyzer-types.ts), [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts) | `AnalyzerDiagnostic`, `compareDiagnostics` | A structured warning or error for ambiguity, missing information, or unsupported behavior. | The system can explain why it stopped instead of guessing. |

## Security

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 🔎 **Secret scan** | [`secret-scan.ts`](../src/security/secret-scan.ts), [`context.ts`](../src/context/context.ts) | `scanProjectForSecrets`, `scanSecrets`, `ProjectSecretScanError` | A repository-wide scan for credential-like values before provider access. | It reduces the risk of transmitting passwords, tokens, API keys, or private keys. |
| 🧱 **Fail-closed** | [`secret-scan.ts`](../src/security/secret-scan.ts), [`analyzer.ts`](../src/analysis/analyzer.ts), [`certification.ts`](../src/providers/certification.ts) | `ProjectSecretScanError`, `analyzeProject`, `evaluateProviderCertification` | Refusing to continue when a safety check is incomplete, ambiguous, or unavailable. | Uncertainty is not treated as safety or success. |
| 🌐 **Pinned HTTPS** | [`pinned-http.ts`](../src/security/pinned-http.ts) | `pinnedHttpFetch`, `PinnedDestination` | HTTPS connected to a DNS-vetted address while TLS verifies the reviewed hostname. | It helps block private-network access, unsafe redirects, and DNS rebinding. |
| 🚧 **Trust boundary** | [`context.ts`](../src/context/context.ts), [`provider.ts`](../src/providers/provider.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `scanSecrets`, `generateValidated`, `RunStore` | A point where data moves between areas with different levels of trust. | Data is scanned and validated before crossing the boundary. |
| 🎭 **Prompt injection** | [`guided-patch.ts`](../src/prompts/guided-patch.ts), [`guided-repair.ts`](../src/prompts/guided-repair.ts) | `buildGuidedPatchPrompt`, `buildGuidedRepairPrompt` | Untrusted text that tries to make the model ignore policy or gain authority. | Repository text and documentation must remain evidence, not controlling instructions. |
| ✂️ **Redaction** | [`context.ts`](../src/context/context.ts) | `ContextRedactionV1`, `scanSecrets`, `selectContext` | Removing sensitive content while recording that something was removed. | Reports can remain useful without preserving a secret value. |
| 🔒 **Root confinement** | [`context.ts`](../src/context/context.ts), [`patch.ts`](../src/pipeline/patch.ts) | `isProtectedContextPath`, `normalizePatchPath`, `preparePatch` | Restricting file access to paths inside the approved project root. | It prevents path traversal into unrelated machine files. |
| 🔗 **Symlink and hardlink protection** | [`discovery.ts`](../src/config/discovery.ts), [`patch.ts`](../src/pipeline/patch.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `discoverHumanInstructionSources`, `preparePatch`, `createWorkspaceSnapshot` | Rejecting file-link tricks that could escape the project or target unexpected files. | A safe-looking path cannot secretly point elsewhere. |

## Context, providers, and prompts

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 🧳 **Context** | [`context.ts`](../src/context/context.ts) | `ContextCandidateV1`, `ContextEvidenceV1`, `selectContext` | Selected source, tests, configuration, and documentation supplied to the model. | The model gets relevant information without receiving the entire repository. |
| 📑 **`ContextManifestV1`** | [`context.ts`](../src/context/context.ts), [`schemas.ts`](../src/providers/schemas.ts) | `ContextManifestV1`, `validateContextManifestV1`, `CONTEXT_MANIFEST_SCHEMA_V1` | A record of each selected context item, including its source, location, reason, hash, and redactions. | It shows exactly what the model was allowed to see. |
| 🎯 **Context selection** | [`context.ts`](../src/context/context.ts) | `selectContext`, `ContextSelectionOptions`, `hashContextManifest` | Ranking and selecting evidence relevant to the reviewed request. | It limits disclosure, noise, token use, and injection exposure. |
| 📖 **Official documentation** | [`documentation.ts`](../src/context/documentation.ts) | `OfficialDocumentationClient`, `DocumentationRequestV1`, `DocumentationError` | Allowlisted, exact-version documentation retrieved under strict network and caching rules. | Generated APIs can be grounded in relevant dependency documentation. |
| 📴 **Offline mode** | [`config.ts`](../src/config/config.ts), [`documentation.ts`](../src/context/documentation.ts) | `DocumentationMode`, `DocumentationConfigV1`, `OfficialDocumentationClient` | A mode that prohibits online documentation retrieval. | The operator can guarantee that grounding performs no network access. |
| 🧰 **Compiler skills** | [`compiler-skills.ts`](../src/context/compiler-skills.ts) | `COMPILER_SKILLS`, `CompilerSkillV1`, `skillsForEcosystems` | Fixed, non-executable ecosystem guidance supplied to the model. | It communicates conventions without granting extra authority. |
| 🔧 **Compiler tools** | [`compiler-tools.ts`](../src/context/compiler-tools.ts), [`provider.ts`](../src/providers/provider.ts) | `CompilerToolExecutor`, `compilerToolPolicy`, `COMPILER_CONTEXT_TOOLS` | Bounded, read-only context requests available only to approved local providers. | Limited extra inspection remains root-confined and auditable. |
| 📏 **Context budget** | [`context.ts`](../src/context/context.ts) | `ContextBudgetV1`, `DEFAULT_CONTEXT_BUDGET`, `ContextRequestSession` | Limits on context files, bytes, and estimated tokens. | It bounds disclosure, processing, and cost. |
| 🤖 **Provider** | [`provider.ts`](../src/providers/provider.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderAdapter`, `OpenAIResponsesProvider`, `OllamaProvider` | The service or local runtime executing the language model, such as OpenAI or Ollama. | It generates code or structured patch proposals. |
| 🔌 **Provider adapter** | [`provider.ts`](../src/providers/provider.ts), [`providers.ts`](../src/providers/providers.ts) | `ProviderAdapter`, `createOpenAIProvider`, `createOllamaProvider` | A common interface around provider-specific APIs and response formats. | The pipeline can use providers consistently without depending on one vendor. |
| 📨 **Prompt** | [`prompts/`](../src/prompts) | `buildDirectConversionPrompt`, `buildGuidedPatchPrompt`, `buildGuidedRepairPrompt` | Structured instructions and evidence sent to the model. | It states the task and the boundaries the model must follow. |
| 🧾 **JSON Schema** | [`schemas.ts`](../src/providers/schemas.ts), [`provider.ts`](../src/providers/provider.ts) | `PATCH_SET_SCHEMA_V1`, `ARTIFACT_SCHEMAS_V1`, `JsonSchemaV1` | A machine-readable description of the required JSON response structure. | Provider output is constrained to the expected patch format. |
| 🪪 **Model identity** | [`contracts.ts`](../src/core/contracts.ts), [`provider.ts`](../src/providers/provider.ts) | `ProviderIdentityV1`, `ProviderGenerationResultV1.resolvedModel` | The provider and model identifier reported for a request. | A run records which model produced it without overstating weight reproducibility. |
| 🏅 **Provider certification** | [`certification.ts`](../src/providers/certification.ts) | `CERTIFICATION_POLICY`, `CERTIFIED_EVIDENCE`, `evaluateProviderCertification` | Benchmark evidence for an exact provider, model profile, and ecosystem. | Only eligible certified results may reach `VERIFIED`. |
| 🔁 **Bounded retry** | [`provider.ts`](../src/providers/provider.ts) | `withProviderRetries`, `RetryProviderOptions`, `normalizeProviderError` | A small, fixed number of retries for approved temporary failures. | Transient errors can recover without uncontrolled requests or cost. |

## Pipeline and generation

| Term | Related file(s) | Main functions, types, or variables | Easy explanation | Why it is needed |
| --- | --- | --- | --- | --- |
| 🗺️ **Planner** | [`planner.ts`](../src/pipeline/planner.ts) | `createDraftContract`, `writeDraftContract`, `loadReviewedContract` | Creates a draft `ChangeContractV1` from a `.human` request and project profile. | It turns informal language into a precise artifact for human review. |
| 📸 **Snapshot** | [`snapshot.ts`](../src/pipeline/snapshot.ts) | `WorkspaceSnapshot`, `createWorkspaceSnapshot`, `cloneWorkspaceSnapshot`, `disposeWorkspaceSnapshot` | An isolated copy of the project at a particular state. | Generation and validation use stable files without changing the working project. |
| 🟢 **Baseline** | [`validation.ts`](../src/pipeline/validation.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `ValidationComparisonOptions.baselineRoot`, `validateBaselineAndCandidate` | The unchanged project snapshot. | It reveals failures that existed before the proposed change. |
| 🟠 **Candidate** | [`validation.ts`](../src/pipeline/validation.ts), [`snapshot.ts`](../src/pipeline/snapshot.ts) | `ValidationComparisonOptions.candidateRoot`, `cloneWorkspaceSnapshot` | A separate snapshot containing the proposed patch. | Changed code can be tested without modifying the working tree. |
| 🧯 **Patch safety checks** | [`patch.ts`](../src/pipeline/patch.ts), [`contracts.ts`](../src/core/contracts.ts) | `preparePatch`, `PatchSafetyError`, `validatePatchSetV1` | Checks for paths, hashes, anchors, sizes, operation types, and protected files. | Unsafe, stale, malformed, or out-of-scope patches are rejected before execution. |
| ⚓ **Edit anchor** | [`contracts.ts`](../src/core/contracts.ts), [`patch.ts`](../src/pipeline/patch.ts) | `EditPatchOperationV1.oldText`, `preparePatch` | Exact existing text identifying where an edit may occur. | It prevents fuzzy edits from changing the wrong code. |
| 🧪 **Validation** | [`validation.ts`](../src/pipeline/validation.ts) | `validateBaselineAndCandidate`, `ValidationComparisonOptions`, `ValidationError` | Running approved checks against the baseline and candidate. | It identifies regressions and evaluates automated acceptance criteria. |
| 📦 **Strong sandbox** | [`validation.ts`](../src/pipeline/validation.ts) | `StrongSandboxOptions`, `strongSandboxAvailable`, `validateBaselineAndCandidate` | An isolated container with no network, restricted permissions, limited resources, and a disposable workspace. | Tests and build scripts run without normal host access. |
| 🗃️ **Run store** | [`run-store.ts`](../src/pipeline/run-store.ts) | `RunStore`, `defaultRunStoreRoot`, `RunStoreError` | Private storage for guided-run artifacts. | Contracts, patches, reports, and rollback data remain auditable. |
| ✅ **Apply** | [`patch.ts`](../src/pipeline/patch.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `applyPatchAtomic`, `applyVerifiedCodeChangeRun`, `ApplyResult` | Explicitly writing an eligible verified patch to the working project. | Generation and validation do not silently change user files. |
| ↩️ **Rollback** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`run-store.ts`](../src/pipeline/run-store.ts) | `rollbackAppliedCodeChangeRun`, `RollbackArtifactV1`, `RunStore` | Restoring exact pre-apply contents from a recorded rollback artifact. | An applied change can be safely reversed when file provenance still matches. |
| 🔧 **Repair loop** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`guided-repair.ts`](../src/prompts/guided-repair.ts) | `validateGuidedCodeChangeRun`, `RepairAttemptV1`, `buildGuidedRepairPrompt` | A limited attempt to fix implementation content after an eligible validation failure. | The candidate can improve without changing approved scope or checks. |
| ⚡ **Direct mode** | [`index.ts`](../src/agents/direct/index.ts), [`cli.ts`](../src/cli.ts) | `discoverUnits`, `generateConversionUnits` | The default `npx human-to-code .` workflow for `.human` files and `@human` markers. | It provides fast generation with guarded writes, but not guided sandbox verification. |
| 🧭 **Guided mode** | [`workflow.ts`](../src/agents/guided/workflow.ts), [`cli.ts`](../src/cli.ts) | `generateGuidedCodeChangeRun`, `validateGuidedCodeChangeRun`, `applyVerifiedCodeChangeRun`, `rollbackAppliedCodeChangeRun` | The `npx human-to-code guided .` contract, context, patch, validation, and explicit-apply workflow. | It provides the auditable, safety-focused lifecycle. |
| 🧠 **FileMemory** | [`file-memory.ts`](../src/agents/direct/file-memory.ts), [`file-memory.ts`](../src/pipeline/file-memory.ts) | `FileMemory`, `generateConversionUnits` | Temporary information about declarations and signatures found in files. | Direct generation can reuse existing names instead of duplicating them. |
| 🗂️ **ProjectMemory** | [`project-memory.ts`](../src/agents/direct/project-memory.ts) | `ProjectMemory`, `buildProjectMemory` | Temporary, bounded information about current and planned files and relationships. | Independently generated files can use consistent paths, imports, and names. |
| 📝 **Blueprint** | [`project-blueprint.ts`](../src/agents/direct/project-blueprint.ts), [`direct-blueprint.ts`](../src/prompts/direct-blueprint.ts) | `ProjectBlueprint`, `parseProjectBlueprint`, `buildDirectBlueprintPrompt` | A shared direct-mode plan fixing the file roster and naming vocabulary before file generation. | Separate generation requests can agree with one another. |
| 🔗 **Integration validation** | [`integration-validation.ts`](../src/agents/direct/integration-validation.ts), [`language-relationships.ts`](../src/agents/direct/language-relationships.ts) | `reconcileGeneratedIntegrations`, `generatedRelationshipsFor` | Checking that generated files refer to one another consistently. | It catches missing imports, assets, selectors, and cross-language relationships. |

## Run statuses

| Status | Related file(s) | Main type or variable | Easy explanation |
| --- | --- | --- | --- |
| ✅ **`VERIFIED`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | All required checks and eligibility gates passed. This is the only generated-run success status. |
| ❓ **`NEEDS_INPUT`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | A human decision or missing information is required. |
| 🚫 **`UNSUPPORTED`** | [`contracts.ts`](../src/core/contracts.ts), [`analyzer-types.ts`](../src/analysis/analyzer-types.ts) | `RunStatus`, `ProjectAnalysisStatus` | The requested project, feature, or condition is not supported. |
| 🌫️ **`INCONCLUSIVE`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | Available evidence cannot prove success or failure. |
| ❌ **`FAILED`** | [`contracts.ts`](../src/core/contracts.ts), [`workflow.ts`](../src/agents/guided/workflow.ts) | `RunStatus`, `RunRecordV1.status` | Generation or a required validation operation failed. |
| 🔐 **`SECURITY_BLOCKED`** | [`contracts.ts`](../src/core/contracts.ts), [`secret-scan.ts`](../src/security/secret-scan.ts) | `RunStatus`, `ProjectSecretScanError` | A security rule stopped the run. |

## Guided workflow at a glance

📝 **Approved request** → 📑 **selected context** → 🧩 **proposed edits** →
🧪 **fixed checks** → 📊 **results** → ✅ **explicit apply** → ↩️ **exact rollback if needed**
