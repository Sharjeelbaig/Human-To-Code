# Feature and code workflows

This guide traces every shipped CLI feature from command-line input to the
functions, variables, artifacts, and side effects that implement it. Use it
when a feature fails and you need to answer: **which function owns this stage,
what value did it receive, and where did that value go next?**

For the meaning of a term, see [GLOSSARY.md](GLOSSARY.md). For why the layers
are separated, see [ARCHITECTURE.md](ARCHITECTURE.md). For naming and comment
rules, see [CODE_CLARITY.md](CODE_CLARITY.md).

## How to read the flows

The notation:

```text
input variable
  → function(input variable)
  → returned value saved as anotherVariable
  → nextFunction(anotherVariable)
```

`→` means data or control passes to the next step. A name in backticks is the
real source symbol whenever practical. “Writes” means a persistent filesystem
change; snapshots and run-store artifacts are identified separately from the
user's working tree.

## Feature index

All commands enter through [`runHumanToCodeCli`](../src/cli.ts). The default
path is selected when the first positional argument is not a recognized command.

| User feature | CLI handler | Main owner | Working-tree effect |
| --- | --- | --- | --- |
| `npx human-to-code .` | `buildCommand` | [`src/agents/direct/`](../src/agents/direct) | Writes accepted whole-file and inline conversions after confirmation. |
| `human-to-code build [root]` | `buildCommand` | [`src/agents/direct/`](../src/agents/direct) | Alias of the default direct flow. |
| `human-to-code convert [root]` | `buildCommand` | [`src/agents/direct/`](../src/agents/direct) | Alias of the default direct flow. |
| `human-to-code guided [root]` | `guided` | [`agents/guided/workflow.ts`](../src/agents/guided/workflow.ts) | Creates/reuses a contract, generates a patch, and validates; it does not apply automatically. |
| `human-to-code analyze [root]` | inline dispatch | [`analysis/analyzer.ts`](../src/analysis/analyzer.ts) | Read-only. |
| `human-to-code plan <file.human>` | `planCommand` | [`pipeline/planner.ts`](../src/pipeline/planner.ts) | Writes a review-blocked `.strict.human.json` contract draft. |
| `human-to-code context <contract> --explain` | `contextCommand` | [`context/context.ts`](../src/context/context.ts) | Read-only preview; may populate the documentation cache unless offline. |
| `human-to-code generate <contract>` | `generateCommand` | `generateGuidedCodeChangeRun` | Writes private run artifacts, never the working tree. |
| `human-to-code validate <run-id>` | `validateCommand` | `validateGuidedCodeChangeRun` | Uses disposable snapshots and writes validation artifacts, never the working tree. |
| `human-to-code apply <run-id>` | `applyCommand` | `applyVerifiedCodeChangeRun` | Applies only an eligible `VERIFIED` patch and writes rollback provenance first. |
| `human-to-code rollback <run-id>` | `rollbackCommand` | `rollbackAppliedCodeChangeRun` | Restores exact pre-apply contents when post-apply hashes still match. |
| `human-to-code check [root]` | `checkCommand` | discovery + planner | Read-only contract freshness check. |
| `human-to-code migrate-config [root]` | `migrateConfigCommand` | [`config/config.ts`](../src/config/config.ts) | Backs up and replaces the configuration file. |
| `human-to-code --init [root]` | `initConfig` | [`config/config.ts`](../src/config/config.ts) | Creates configuration exclusively; never overwrites. |
| `human-to-code --help` | `runHumanToCodeCli` | [`cli.ts`](../src/cli.ts) | Read-only. |

## Common CLI entry and dispatch

```text
process.argv.slice(2)
  → runHumanToCodeCli(argv)
  → parse(argv)
  → cli: CliOptions

cli.positionals[0]
  → recognized by COMMANDS?
  → command + args
  → command handler
  → numeric exit code
```

| Step | Input | Function | Output / next use | Debug here when |
| --- | --- | --- | --- | --- |
| Parse options | `argv` | `parse` in [`cli.ts`](../src/cli.ts) | `cli: CliOptions` | A flag is rejected, defaulted incorrectly, or mapped to the wrong field. |
| Resolve command | `cli.positionals` + `COMMANDS` | `runHumanToCodeCli` | `command`, `args` | A command routes to the wrong feature. |
| Resolve project root | `cli.root`, positional fallback | `projectRoot` or handler-local `resolve` | absolute `root` | `--root` and positional roots behave differently. |
| Format output | domain result + `cli.json` | `output`, `profileText`, `outcomeText` | stdout | Human and JSON output disagree. |
| Map status | `ProjectProfileV1` or `WorkflowOutcome` | `analysisExit`, `outcomeExit` | exit code | Correct work produces the wrong process exit code. |
| Map exceptions | typed error | `runHumanToCodeCli` catch block | exit code 1–6 | An error is reported under the wrong category. |

Configuration overrides shared by provider-using commands flow as:

```text
loadConfig(root).config
  → overrideConfig(config, cli)
  → validated ConfigV1
  → resolveWorkspaceConfig(...) when a reviewed contract selects workspaces
  → providerFor(config)
  → ProviderAdapter
```

Edit [`config/config.ts`](../src/config/config.ts) for configuration meaning,
`overrideConfig` for CLI overrides, and `providerFor` for provider construction.

## Default direct conversion

Command: `npx human-to-code .`, `human-to-code build`, or
`human-to-code convert`.

This is the largest single CLI workflow. It discovers instructions, optionally
plans shared names, generates candidates, performs static checks, and only then
writes accepted code.

### Direct data flow

```text
rootInput + cli.root
  → resolve(...)
  → root

loadConfig(root)
  → config
  → overrideConfig(config, cli)
  → effective: ConfigV1

discoverDirectUnits(root, effective.languages, effective.humanFileExtensions)
  → discovery: DirectDiscoveryResult
  → discovery.units saved as units
  → discovery.notices shown to user
  → discovery.scannedPaths passed to ProjectMemory and reference checks

units + provider/model
  → renderReceipt(...) or JSON plan
  → confirmation / --yes / --dry-run gate

buildProjectMemory(root, units, { scannedPaths, privacy limits })
  → projectMemory: ProjectMemory

optional generateBlueprint(...)
  → raw blueprint text
  → parseProjectBlueprint(raw, allowedPaths)
  → blueprint
  → projectMemory.adoptBlueprint(blueprint)

generateConversionUnits(units, generatorCallback, options)
  → each unit + UnitGenerationContext
  → generateCode(unit.prompt, provider options + memory)
  → validateGeneratedUnit(unit, candidateCode)
  → generated: GeneratedConversionUnit[]

optional collectReferenceFindings(referenceFiles)
  → referenceFindings

optional reconcileGeneratedIntegrations(generated, callbacks)
  → integrated.results
  → generated reassigned to integrated.results

validateCandidateProject(root, generated, repair callback)
  → staged.results
  → generated reassigned to staged.results

generated sorted into ordered
  → wholeFiles + inline units
  → applyWholeFileBatch(...) and applyUnit(...)
  → written[] + skipped[]
  → DONE / FAILED output
```

### Direct variables and ownership

| Variable | Produced by | Contains | Consumed by | Edit when it is wrong |
| --- | --- | --- | --- | --- |
| `effective` | `overrideConfig` | Fully validated direct configuration after CLI overrides. | Discovery, provider setup, privacy budgets, planning, checks. | [`config/config.ts`](../src/config/config.ts) or `overrideConfig` in [`cli.ts`](../src/cli.ts). |
| `discovery` | `discoverDirectUnits` | `units`, notices, and scanned paths. | Receipt, ProjectMemory, generation, reference checks. | [`agents/direct/discovery.ts`](../src/agents/direct/discovery.ts), [`marker-parser.ts`](../src/agents/direct/marker-parser.ts), or [`language-inference.ts`](../src/agents/direct/language-inference.ts). |
| `units` | `discovery.units` | One `ConversionUnit` per `.human` file or real `@human` marker. | Planning and `generateConversionUnits`. | Direct discovery and [`types.ts`](../src/agents/direct/types.ts). |
| `projectMemory` | `buildProjectMemory` | Bounded current/projected tree and compact file relationships. | Blueprint adoption, per-unit prompts, integration and repair. | [`project-memory.ts`](../src/agents/direct/project-memory.ts) and [`project-contracts.ts`](../src/agents/direct/project-contracts.ts). |
| `blueprint` | `parseProjectBlueprint` | Shared target roster and naming vocabulary. | Per-target todo and conversion prompts through `renderBlueprintFor`. | [`project-blueprint.ts`](../src/agents/direct/project-blueprint.ts) and [`prompts/direct-blueprint.ts`](../src/prompts/direct-blueprint.ts). |
| `planningOutcomes` | `generateConversionUnits` callback | Todo/coding request counts and rejected refinements. | Final receipt and usage reporting. | [`unit-todos.ts`](../src/agents/direct/unit-todos.ts) and [`file-memory.ts`](../src/agents/direct/file-memory.ts). |
| `generated` | `generateConversionUnits`, then optional integration/staged reassignment | Candidate code, unit, or per-unit error. | Cross-file checks and application. | Generation: [`generation-client.ts`](../src/agents/direct/generation-client.ts); orchestration: [`file-memory.ts`](../src/agents/direct/file-memory.ts). |
| `referenceFindings` | `collectReferenceFindings` | Deterministic HTML/CSS/JS reference problems. | Progress and final JSON output. | [`reference-validation.ts`](../src/agents/direct/reference-validation.ts). |
| `staged.results` | `validateCandidateProject` | Candidates accepted/rejected after combined JS/TS validation and repair. | Replaces `generated` before writes. | [`staged-validation.ts`](../src/agents/direct/staged-validation.ts), [`program-diagnostics.ts`](../src/agents/direct/program-diagnostics.ts), and [`dependency-graph.ts`](../src/agents/direct/dependency-graph.ts). |
| `ordered` | sort of `generated` | Whole files first; inline markers bottom-to-top per source file. | Application. | Final third of `buildCommand` in [`cli.ts`](../src/cli.ts). |
| `written`, `skipped` | application loop | Final per-path outcomes. | CLI status and summary. | [`application.ts`](../src/agents/direct/application.ts) or final application block in `buildCommand`. |

### Optional direct branches

| Configuration or flag | Branch | Function(s) | If it fails, inspect |
| --- | --- | --- | --- |
| No `--yes` | Confirmation | `confirmYes` | CLI TTY handling. |
| `--dry-run` | Stops after receipt | `buildCommand` | CLI gate before provider setup. |
| `direct.planning.enabled` | Blueprint/todo/refinement passes | `generateBlueprint`, `generateUnitTodos`, `parseProjectBlueprint`, `parseUnitTodoList` | Planning prompts, parsers, or ratchet logic. |
| `direct.crossFileChecks` | Deterministic web references | `collectReferenceFindings` | `reference-validation.ts`. |
| `direct.reconcileIntegrations` | Model audit/repair of related generated files | `reconcileGeneratedIntegrations` | `integration-validation.ts`, `language-relationships.ts`, integration prompts. |
| Generated JS/TS | Combined candidate project validation | `validateCandidateProject` | candidate overlay, TypeScript program diagnostics, dependency grouping. |
| Remote provider | Consent gate | `localProvider`, `effective.privacy.remoteProviderConsent` | `buildCommand` provider/consent block and configuration. |
| Whole-file output | All-or-nothing whole-file batch | `applyWholeFileBatch` | `application.ts`; one failed whole-file candidate withholds the batch. |
| Inline output | Exact stale-safe replacement | `applyUnit`, `replaceInlineMarker` | `application.ts` and `replacement.ts`. |

### Direct troubleshooting map

| Symptom | First function/file to inspect |
| --- | --- |
| A `.human` file or marker is missing | `discoverDirectUnits`, `extractInlineMarkers`. |
| Wrong output extension or language | `inferUnitLanguage`, `resolveLanguageDeclaration`, core/direct language registries. |
| Wrong number of provider calls | `plannedRequestCounts`, planning block in `buildCommand`, `generateConversionUnits`. |
| Model received wrong local context | `ProjectMemory.renderFor`, `FileMemory.contextFor`, prompt builders. |
| Model output parsing fails | `stripCodeFence`, provider generation client. |
| Valid-looking code is skipped | `validateGeneratedUnit`, `validateCandidateProject`, integration/reference findings. |
| Cross-file TypeScript error is blamed on the wrong unit | `attributeDiagnostics`, `buildOverlayDependencyGroups`. |
| Files were generated but not written | Whole-file batch gate and application loop in `buildCommand`. |
| Inline code appears at the wrong location | `replaceInlineMarker` and bottom-to-top `ordered` sorting. |

## All-in-one guided workflow

Command: `human-to-code guided [root]`.

```text
root
  → loadConfigAndAnalyzeProject(root)
  → { profile, loadedConfig }
  → analysisExit(profile)

loadedConfig + CLI overrides
  → config

discoverInstructionSourcesAndRejectTrackedSecrets(root, config)
  → sources
  → sources.human saved as selected
  → optional --file filter

selected[0]
  → source
  → contractPathForSource(root, source)
  → contractPath

loadReviewedContract(root, contractPath, profile)
  → reviewed
  OR createDraftContract(...) → draft → writeDraftContract(draft) → NEEDS_INPUT

resolveWorkspaceConfig(config, profile, reviewed.contract)
  → effectiveConfig
providerFor(effectiveConfig)
  → provider

generateGuidedCodeChangeRun({ root, profile, contract, config, provider })
  → generated: WorkflowOutcome

generated.runId + same provider/config
  → validateGuidedCodeChangeRun(...)
  → validated: WorkflowOutcome
  → output + exit code
```

The all-in-one command generates and validates. It deliberately does **not**
call `applyVerifiedCodeChangeRun`; application remains a separate command.
If validation is eligible for bounded repair, this path can reuse the exact
provider and configuration because it passes them into validation.

Edit `guided` in [`cli.ts`](../src/cli.ts) for selection/orchestration,
[`pipeline/planner.ts`](../src/pipeline/planner.ts) for the review gate, and
[`agents/guided/workflow.ts`](../src/agents/guided/workflow.ts) for generation,
validation, repair, apply, or rollback policy.

## Static analysis

Command: `human-to-code analyze [root]`.

```text
root argument
  → resolve(...)
  → analyzeProject(root)
  → profile: ProjectProfileV1
  → profileText(profile) or JSON
  → analysisExit(profile)
```

Inside `analyzeProject`:

```text
root + AnalyzerOptions
  → scanProject(...)
  → bounded AnalyzerInventory
  → createAnalyzerContext(...)
  → each DEFAULT_ECOSYSTEM_ADAPTER.analyze(context)
  → WorkspaceProfileV1[]
  → supportFor(...) decisions
  → fingerprint(profile data)
  → ProjectProfileV1
```

| Problem | Edit |
| --- | --- |
| File inventory, paths, hashes | [`analyzer-utils.ts`](../src/analysis/analyzer-utils.ts). |
| React/Nest recognition | [`adapters/node.ts`](../src/analysis/adapters/node.ts). |
| FastAPI recognition | [`adapters/python.ts`](../src/analysis/adapters/python.ts). |
| Cargo/Rust recognition | [`adapters/rust.ts`](../src/analysis/adapters/rust.ts). |
| General fallback | [`adapters/general.ts`](../src/analysis/adapters/general.ts). |
| Support tier/version | [`support-matrix.ts`](../src/analysis/support-matrix.ts). |
| CLI rendering/exit code | `profileText` and `analysisExit` in [`cli.ts`](../src/cli.ts). |

## Contract planning

Command: `human-to-code plan <file.human> [--root <root>]`.

```text
sourceInput
  → relativeInside(root, sourceInput)
  → relPath
  → source: SourceFile

loadConfigAndAnalyzeProject(root)
  → profile

createDraftContract(root, source, profile)
  → draft: DraftContractResult
  → draft.contract + draft.contractPath

writeDraftContract(draft)
  → <name>.strict.human.json
  → NEEDS_INPUT
```

The draft intentionally contains a material review question. If the generated
scope, requirements, or target workspace is wrong, edit
[`pipeline/planner.ts`](../src/pipeline/planner.ts). If a reviewed file is later
reported stale, trace `sourceContentHash`, the project fingerprint, and
`loadReviewedContract`.

## Context preview

Command: `human-to-code context <contract> --explain`.

```text
contractInput
  → loadContractFor(root, contractInput)
  → loaded = { profile, config, contract }

overrideConfig + resolveWorkspaceConfig
  → config

buildGuidedContextPreview(root, profile, contract.contract, config, offline)
  → manifest: ContextManifestV1
  → print evidence, ranges, hashes, exclusions, redactions
```

Inside `buildGuidedContextPreview`:

```text
root
  → scanProjectForSecrets(root)
  → targetWorkspaces(profile, contract)
  → precomputeContractContext(...)
  → candidates
  → selectContext({ candidates, budget, secretPolicy: "block" })
  → ContextManifestV1
```

Inspect [`context/context.ts`](../src/context/context.ts) for ranking, budgets,
redaction, and manifest validation; [`context/documentation.ts`](../src/context/documentation.ts)
for official documentation; and [`security/secret-scan.ts`](../src/security/secret-scan.ts)
when preview stops before provider access.

## Guided patch generation

Command: `human-to-code generate <contract>`.

The CLI prepares `loaded`, `config`, and `provider`, then calls
`generateGuidedCodeChangeRun`.

```text
input: GenerateRunOptions
  → options with resolved workspace config
  → root + store + random runId
  → store.create(runRecord)

validateChangeContractV1(options.contract)
  → contract
targetWorkspaces(profile, contract)
  → workspaces
createValidationPlan(profile, contract)
  → validationPlan
createWorkspaceSnapshot(root)
  → baseline with snapshotHash
buildGuidedContextPreview(...)
  → manifest

buildGuidedPatchPrompt({ profile, contract, manifest, snapshotHash, workspaces })
  → request.messages
generateValidated(provider, request, patch schema)
  → generated = { value, result }
  → validatePatchSetV1(generated.value, contract)
  → patch

preparePatch(baseline.root, patch, policy)
  → safety-approved patch (still not applied)
renderPatchDiff(patch)
  → diff
certificationFor(...)
  → certification
RunStore.writeArtifact(...)
  → persisted run artifacts
  → WorkflowOutcome with runId and diff
```

Local tool-capable providers may return a context-tool request. In that branch,
`CompilerToolExecutor.execute` returns more evidence, `selectContext` rebuilds
`manifest`, and generation repeats within the eight-request and budget limits.
Remote providers receive no context tools.

| Failure | Inspect |
| --- | --- |
| Contract/profile stale | `validateChangeContractV1`, `loadReviewedContract`, analyzer fingerprint. |
| Remote consent stops generation | privacy configuration and consent branch in `generateGuidedCodeChangeRun`. |
| Provider output is malformed | `generateValidated`, provider adapter, `PATCH_SET_SCHEMA_V1`. |
| Patch is out of scope or stale | `validatePatchSetV1`, `preparePatch`. |
| New API is not grounded | `assertExternalApisGrounded`, manifest evidence. |
| Patch exists but cannot be `VERIFIED` | certification evidence and later validation; generation alone is `INCONCLUSIVE`. |

## Guided validation and bounded repair

Command: `human-to-code validate <run-id>`.

```text
runId
  → validateGuidedCodeChangeRun({ runId, sandbox options })
  → RunStore.exclusive(runId, validateStoredRunLocked)

RunStore.read/readArtifact
  → record, storedProfile, storedConfig, contract, context, patch, plan, certification
  → exact validators + provenance hashes

analyzeProject(root)
  → currentProfile
createWorkspaceSnapshot(root)
  → baseline
cloneWorkspaceSnapshot(baseline)
  → validationBaseline + candidate
applyPatchAtomic(candidate.root, patch, policy)
  → candidate snapshot contains proposed code

validateBaselineAndCandidate(executionPlan, sandbox roots/options)
  → report: ValidationReportV1
  → validation-report-attempt-0.json

optional bounded repair loop
  → buildGuidedRepairPrompt(...)
  → generateValidated(...)
  → repaired patch
  → assertRepairPatchConstraints(...)
  → fresh candidate + fresh report

final patch + report + provenance
  → RunStore artifacts and status
  → WorkflowOutcome
```

The standalone `validate` command does not pass a provider or configuration,
so it cannot make repair requests. The all-in-one `guided` path can repair
because it supplies the exact generation provider/configuration.

| Problem | Inspect |
| --- | --- |
| Docker/Podman or image selection | `sandboxBinary`, `sandboxImage`, [`pipeline/validation.ts`](../src/pipeline/validation.ts). |
| Baseline/candidate command difference | `validateBaselineAndCandidate`. |
| Candidate patch application | `preparePatch`, `applyPatchAtomic`. |
| Repair unexpectedly allowed/refused | `repairableValidationFailure`, `assertRepairPatchConstraints`. |
| Repair budget/provenance | repair checkpoint functions and `ProviderBudgetTracker`. |
| Final status | final status calculation in `validateStoredRunLocked` plus certification. |

## Apply

Command: `human-to-code apply <run-id>`.

```text
runId
  → applyVerifiedCodeChangeRun(runId)
  → store.read(runId)
  → require status === VERIFIED
  → require Git working tree
  → store.exclusive(runId, ...)

stored contract + patch + context + report + certification
  → exact validation and hash comparison
  → preparePatch(record.root, patch, policy)
  → prepared

prepared.operations
  → rollback: RollbackArtifactV1
  → store.writeArtifact("rollback.json", rollback)

applyPatchAtomic(record.root, patch, policy)
  → applied: ApplyResult
  → store.writeArtifact("apply.json", ...)
  → WorkflowOutcome
```

If apply is refused, inspect status/certification/report provenance in
`applyVerifiedCodeChangeRun`. If a file hash or path is stale, inspect
[`pipeline/patch.ts`](../src/pipeline/patch.ts). The rollback artifact is always
persisted before the working tree is changed.

## Rollback

Command: `human-to-code rollback <run-id>`.

```text
runId
  → rollbackAppliedCodeChangeRun(runId)
  → store.exclusive(runId, ...)
  → read contract, patch, apply.json, rollback.json
  → validateApplyArtifact + validateRollbackArtifact

rollback entries reversed
  → operations: inverse PatchSetV1 operations
  → paths: exact allowed rollback paths
  → applyPatchAtomic(root, inverse, rollback policy)
  → restore file modes
  → write rollback-result.json
```

Rollback intentionally refuses drift. Inspect `validateRollbackArtifact` when
stored provenance is rejected, or `applyPatchAtomic` when the current files no
longer match the recorded post-apply hashes.

## Contract freshness check

Command: `human-to-code check [root]`.

```text
root
  → loadConfigAndAnalyzeProject(root)
  → profile + config
  → discoverInstructionSourcesAndRejectTrackedSecrets(root, config)
  → sources

for each sources.human source
  → contractPathForSource(root, source)
  → loadReviewedContract(root, contractPath, profile)
  → success or failures[]

failures.length
  → STALE / exit 2
  OR VERIFIED / exit 0
```

This command does not generate, validate project commands, or apply code. Edit
`checkCommand` for aggregation/output and planner/discovery code for individual
freshness decisions.

## Configuration migration

Command: `human-to-code migrate-config [root]`.

```text
human-to-code.config.json path
  → lstat bounded regular file checks
  → JSON.parse
  → raw
  → migrateLegacyConfig(raw)
  → migrated: ConfigV1

copyFile(path, <path>.alpha.bak, exclusive)
  → backup
writeFile(<path>.migrating, migrated, exclusive)
  → temporary
rename(temporary, path)
  → migrated config replaces original
```

Edit `migrateLegacyConfig` in [`config/config.ts`](../src/config/config.ts) for
schema meaning and `migrateConfigCommand` for backup/replace mechanics.

## Configuration initialization

Command: `human-to-code --init [root]`.

```text
root + CONFIG_FILENAME
  → target
defaultConfigJson()
  → configuration text
writeFile(target, text, { flag: "wx", mode: 0600 })
  → created or EEXIST refusal
```

Edit `DEFAULT_CONFIG` and `defaultConfigJson` for generated content. Edit
`initConfig` only for CLI file-creation behavior.

## Provider request workflow

Direct and guided modes share provider concepts but use different adapters:

```text
ConfigV1.provider
  → providerFor / direct request options
  → createOpenAIProvider or createOllamaProvider
  → ProviderAdapter

typed prompt builder
  → ProviderMessageV1[] / prompt messages
  → withProviderRetries(...)
  → generateValidated(...)
  → adapter.generate(request)
  → provider HTTP implementation
  → raw provider output
  → local schema/shape validation
  → generated value + ProviderGenerationResultV1
```

| Concern | Owner |
| --- | --- |
| Prompt wording | [`src/prompts/`](../src/prompts). |
| Provider-neutral request/result contract | [`providers/provider.ts`](../src/providers/provider.ts). |
| OpenAI/Ollama HTTP translation | [`providers/providers.ts`](../src/providers/providers.ts). |
| Structured artifact schemas | [`providers/schemas.ts`](../src/providers/schemas.ts). |
| Retries, budgets, finish reasons | `withProviderRetries`, `ProviderBudgetTracker`, `generateValidated`. |
| DNS/redirect/network confinement | [`security/pinned-http.ts`](../src/security/pinned-http.ts). |
| Provider/model eligibility for `VERIFIED` | [`providers/certification.ts`](../src/providers/certification.ts). |

## Guided run artifacts

These files are private run-store records, not files contributors should commit.

| Artifact | Written by | Read by / purpose |
| --- | --- | --- |
| `profile.json` | `generateGuidedCodeChangeRun` | Validation compares the current profile with generation-time analysis. |
| `run-config.json` | generation | Validation/repair freezes provider, sandbox, budget, and privacy configuration. |
| `contract.json` | generation | Patch validation, repair, apply, and rollback authority. |
| `validation-plan.json` | generation | Baseline/candidate commands frozen before model output. |
| `context.json` | context/generation | Exact evidence shown to the provider and later provenance checks. |
| `patch.json` | generation; replaced only after complete repair validation | Candidate structured change used by validation/apply. |
| `diff.json` | generation/repair | Stable human-review rendering. |
| `certification.json` | generation | Determines whether validated evidence may become `VERIFIED`. |
| `validation-report-attempt-N.json` | validation | Immutable evidence for each candidate attempt. |
| `repair-checkpoint.json` | repair loop | Crash-safe cumulative provider identity, usage, and attempt provenance. |
| `repair-provenance.json` | validation | Final repair attempts and results. |
| `validation-report.json` | validation | Canonical report consumed by apply. |
| `rollback.json` | apply, before mutation | Exact pre-apply contents, modes, and post-apply hashes. |
| `apply.json` | apply, after mutation | Applied paths and patch hash. |
| `rollback-result.json` | rollback | Restored paths and rollback completion time. |

Run-store persistence and locking live in
[`pipeline/run-store.ts`](../src/pipeline/run-store.ts).

## Exit and error workflow

```text
domain function throws typed error or returns WorkflowOutcome
  → command handler
  → runHumanToCodeCli catch/status mapping
  → output(...)
  → process.exitCode
```

| Result | Exit | Primary source |
| --- | ---: | --- |
| Success / eligible `VERIFIED` | 0 | handler result, `analysisExit`, `outcomeExit`. |
| Usage/configuration/discovery error | 1 | `ConfigError`, `PlanningError`, `DiscoveryError`. |
| Stale contract or failed validation | 2 | planner staleness or failed outcome. |
| Needs input, unsupported, inconclusive | 3 | profile or workflow status. |
| Security blocked | 4 | `ContextSecurityError` or security outcome. |
| Provider/documentation dependency failure | 5 | `ProviderError`, `DocumentationError`; direct generation failure. |
| Internal error or partial scan | 6 | unexpected error or `PARTIAL_SCAN`. |

## Where should I make a change?

| Desired change | Start here |
| --- | --- |
| Add/change a CLI command or flag | `parse`, `COMMANDS`, and `runHumanToCodeCli` in [`cli.ts`](../src/cli.ts). |
| Change `.human` or `@human` discovery | Direct: [`agents/direct/discovery.ts`](../src/agents/direct/discovery.ts); guided/config: [`config/discovery.ts`](../src/config/discovery.ts). |
| Change language inference/routing | [`language-inference.ts`](../src/agents/direct/language-inference.ts), language registries. |
| Change direct model instructions | [`src/prompts/direct-*.ts`](../src/prompts). |
| Change direct project context | `ProjectMemory`, file memory, compact contracts. |
| Change direct validation/repair | candidate, integration, reference, and staged validation modules. |
| Add an ecosystem | analyzer adapter + support matrix + compiler skill. |
| Change reviewed contract fields | core contract type/validator + provider schema + planner + docs. |
| Change context selection | [`context/context.ts`](../src/context/context.ts). |
| Change provider behavior | provider contract/adapters, never agent policy inside transport. |
| Change patch safety/application | [`pipeline/patch.ts`](../src/pipeline/patch.ts). |
| Change sandbox checks | [`pipeline/validation.ts`](../src/pipeline/validation.ts). |
| Change guided orchestration/repair | [`agents/guided/workflow.ts`](../src/agents/guided/workflow.ts). |
| Change run persistence/locking | [`pipeline/run-store.ts`](../src/pipeline/run-store.ts). |
| Change names/comments/practices | [CODE_CLARITY.md](CODE_CLARITY.md) and `test/source-clarity.test.ts`. |

When adding a CLI command, update this guide and
`test/workflow-docs.test.ts`. The test checks that every name in `COMMANDS`,
plus the default and `--init` paths, remains represented here.
