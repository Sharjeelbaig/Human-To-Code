# Contributing to human-to-code

Thanks for helping build `human-to-code`. The project is a production-architecture preview: contributions are welcome, but reliability and honest refusal take priority over breadth or impressive demos.

## Development setup

Use Node.js 24 or newer. Development dependencies and the lockfile are pinned; do not rely on Node's TypeScript type-stripping as the release path.

```bash
git clone https://github.com/sharjeelbaig/human-to-code
cd human-to-code
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev -- --help` | Run the TypeScript CLI during development. |
| `npm run typecheck` | Type-check source and tests without emitting files. |
| `npm test` | Run the `node:test` unit/integration suite. |
| `npm run build` | Compile the publishable package into `dist/`. |
| `npm run package:check` | Pack, clean-install, import, and invoke the installed CLI. |
| `npm run clean` | Remove generated `dist/` output. |

`package:check` may create a temporary npm tarball while it runs and removes it afterward.

## Architecture

The production pipeline is:

```text
static project analysis
  → reviewed ChangeContractV1 (what is allowed to change)
  → grounded ContextManifestV1 (the context used)
  → provider-generated PatchSetV1 (the proposed edits)
  → immutable ValidationPlanV1 (the checks to run)
  → isolated baseline/candidate ValidationReportV1 (the check results)
  → explicit apply only after VERIFIED
  → provenance-bound rollback artifact and exact rollback
```

**New here?** These are review records created by guided mode; you do not normally write them yourself. The change contract records the approved request, the context manifest records the relevant files and documentation selected, the patch set records proposed edits, the validation plan records the agreed checks, and the validation report records their results.

See the [architecture glossary](docs/GLOSSARY.md) for plain-English definitions of these and other project terms.
See the [feature and code workflows](docs/WORKFLOWS.md) to trace each CLI command through its functions, variables, artifacts, and failure points.
Source names and comments follow the intent-first rules in [docs/CODE_CLARITY.md](docs/CODE_CLARITY.md).

The LLM generates structured code edits. It is not a deterministic `strict → code` compiler, and documentation must not claim that it is. Determinism belongs to discovery, profiling, contract/schema validation, context selection, patch safety checks, validation-plan selection, provenance hashes, and application.

## Project layout

Source is organized into layered domain folders; a module may import from its own layer or a layer above it in this table, never below. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full dependency rules, [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for feature call chains, [docs/MODULES.md](docs/MODULES.md) for a per-file guide, and [docs/GLOSSARY.md](docs/GLOSSARY.md) for plain-English terminology.

| Path | Responsibility |
| --- | --- |
| `src/core/` | Shared primitives: `types.ts` public option/result types; `contracts.ts` versioned artifact types, exact validators, canonical serialization, and hashes. |
| `src/config/` | `config.ts` strict schema-v1 configuration, endpoint policy, defaults, and alpha migration; `discovery.ts` fail-closed `.human` discovery and protected secret-file detection. |
| `src/analysis/` | `analyzer.ts` and `analyzer-*.ts` root validation, bounded inventory, deterministic multi-workspace profiling; `support-matrix.ts` versioned capability declarations and preview/certification tiers. |
| `src/analysis/adapters/` | Static React/NestJS, FastAPI/Python, Cargo/Rust, and ungrounded-general ecosystem adapters. |
| `src/security/` | `secret-scan.ts` fail-closed first-party repository credential scan before provider access; `pinned-http.ts` DNS-vetted, address-pinned HTTPS fetch. |
| `src/context/` | `context.ts` secret-aware, provenance-bound context selection; `documentation.ts` allowlisted exact-version documentation retrieval, cache, and revalidation; `compiler-skills.ts` non-executable ecosystem policy packs; `compiler-tools.ts` bounded read-only context-request executor. |
| `src/providers/` | `provider.ts` provider-neutral schemas, budgets, normalized errors, and retry policy; `providers.ts` dependency-free OpenAI Responses and Ollama local/cloud HTTP adapters; `certification.ts` fail-closed provider/model certification gate; `schemas.ts` provider-bound JSON output schemas. |
| `src/agents/` | `direct/` owns marker discovery, prompt calls, syntax gating, FileMemory, and guarded working-tree application; `guided/` owns reviewed generation, validation, apply, and rollback policy. |
| `src/pipeline/` | Deterministic mechanics shared by agents: planning, snapshots, patch safety, sandbox validation, run storage, and declaration scanning. `simple.ts` and `workflow.ts` are compatibility re-exports only. |
| `src/index.ts` | Stable public embedding API, grouped by layer. |
| `src/cli.ts` | Guided and explicit command-line interfaces with fixed exit codes. |
| `test/` | Unit, adversarial, integration, and clean-package smoke tests. |
| `docs/` | Architecture, module guide, and scalability/engineering practices. |

## Non-negotiable safety invariants

Every change must preserve these rules:

1. **Only `VERIFIED` is generated-run success.** Missing checks, unavailable prerequisites, baseline failures, flakiness, manual checks, preview profiles/models, and incomplete scans cannot become exit code `0` for generation.
2. **Analysis remains static.** Adapters do not import project modules, evaluate configuration, spawn framework tools, or follow symlinks.
3. **The reviewed contract owns scope.** Models cannot add paths, operations, risks, dependencies, validation commands, acceptance criteria, or budgets.
4. **Repository and documentation text is untrusted data.** It cannot alter policy or tool authority, even when it appears in comments, diagnostics, a README, installed dependency, or official-looking page.
5. **No credential detected at a trust boundary reaches a provider, cache, report, error, telemetry event, or test snapshot.** Scan first-party repository files before provider access; discard credential-bearing validation output before persistence; recursively gate run-store writes. Tests use unmistakably synthetic values and assert that raw values never escape.
6. **Credentials remain environment-only and endpoint-bound.** A config stores only `apiKeyEnv`; a custom endpoint never inherits another provider's key.
7. **No arbitrary model tools.** Compiler tools stay read-only, root-confined, bounded, schema-validated, and auditable. Remote providers receive no context tools, so their reviewed outbound envelope is complete. Local tools must never add shell, process, general network, install, Git, arbitrary read, or write authority.
8. **Patch checks happen before execution.** Reject the entire artifact on stale hashes, fuzzy anchors, scope violations, protected/generated/lockfile changes, path escapes, symlink/hardlink tricks, binary content, collisions, or operation/size bombs.
9. **Project commands are arbitrary code.** They execute only in the strong candidate/baseline sandbox, never in the working tree or analyzer.
10. **Apply and rollback are separate and exact.** Apply requires `VERIFIED`, unchanged provenance/base hashes, a same-run lock, per-file atomic writes, and a pre-apply rollback artifact. Rollback requires the apply/rollback artifacts and exact post-apply hashes; it must not overwrite drift. Do not describe the multi-file operation as a filesystem transaction. Migrations are never applied.
11. **No silent fallback.** Do not switch provider, model, version, workspace, package manager, router, environment, toolchain, validation command, feature set, or network policy automatically.
12. **Certification is evidence, not marketing.** New detection support starts `preview` or `unsupported`; it becomes `certified` only after the declared benchmark and negative fixtures pass.

If a proposed feature cannot preserve an invariant, open a design discussion before writing code. Do not add a bypass flag merely to turn a fail-closed result into success.

## Making a change

1. Check existing issues and open one for a non-trivial architecture, schema, provider, sandbox, or support-matrix change.
2. Keep the patch focused and preserve unrelated work in the repository.
3. Add tests for the intended behavior and the most plausible misuse/failure cases.
4. Update `Readme.md`, `SECURITY.md`, public types, and schemas together when behavior or guarantees change.
5. Run all development checks from a clean install.
6. Explain security impact, compatibility impact, and remaining limitations in the pull request.

Use lifecycle-oriented names: an exported function should communicate its action, domain object, and relevant stage (for example, `discoverHumanInstructionSources`, not `discover`). Boolean names should read as conditions, units should be visible in names, and checkpoint comments should explain their human-to-code role or invariant. See [docs/CODE_CLARITY.md](docs/CODE_CLARITY.md) for the complete practice and compatibility rules.

Use `apply_patch`-style focused edits rather than bulk rewrites when practical. Do not commit `dist/`, temporary snapshots, provider responses, generated run records, credentials, private fixtures, or npm tarballs.

## Testing expectations

Tests must be deterministic and must not require a real provider, public network, Docker/Podman daemon, database, cloud account, or developer credential unless they are clearly isolated optional integration tests.

### Analyzer and discovery changes

Add positive and negative fixtures for:

- Missing, unreadable, symlinked, non-directory, huge, and partially scanned roots.
- Nested/ignored/untracked protected files and binary/special files.
- Repository-wide secret findings in ignored/untracked fixtures and logs, dependency-store exclusions, symlink confinement, hardlink/special-file failure, scan budgets, and value-free diagnostics.
- Conflicting lockfiles, package/environment managers, workspace ownership, routers, toolchains, or versions.
- Dynamic metadata that cannot be understood safely without execution.
- Monorepos with multiple ecosystems and ambiguous target applications.
- Stable ordering, evidence hashes, diagnostics, and profile fingerprints.

An adapter may inspect only the bounded analyzer context. Keep regular expressions and static parsers defensive against adversarial input and catastrophic backtracking.

### Schema, contract, context, and patch changes

Use exact-object validation: unknown fields must fail. Add tests for malformed types, missing keys, duplicate IDs, non-canonical paths, stale hashes, unauthorized inferred risk, material questions, scope expansion, prompt injection, secret detection/redaction, content-hash mismatch, exact-version `docs.rs` and configured `officialSources` retrieval/revalidation/offline misses, import/use grounding and its opaque language cases, token/file limits, path traversal, symlink/hardlink races, case collisions, and patch bombs.

Schema semantics are versioned. A breaking reinterpretation requires a new schema version and explicit migration; never silently reinterpret an alpha or older artifact.

### Provider changes

Provider tests use injected fetch, DNS, environment, request-ID, clock, and cancellation implementations. Cover:

- Exact request endpoint, model, schema, messages, tool definitions, and credential header.
- Missing/invalid environment variable without exposing its value.
- Response byte limits, malformed JSON, schema mismatch, truncation, refusal, cancellation, and invalid usage.
- Timeout/rate-limit/server retries bounded to two, with non-retryable failures terminal.
- Redirect handling, public-address checks, loopback checks, private-network rejection, DNS rebinding, and proof that production provider/documentation transports connect to the vetted pinned address while test fetch seams stay explicit.
- Exact configured and provider-reported model identity with no provider/model fallback; tests must not treat a provider name/tag as proof of immutable model weights.
- Missing/malformed remote pricing, explicit unmetered-zero assertions, worst-case pre-request cost reservation, cumulative cost refusal before fetch, provider-reported usage reconciliation, conservatively charged failed/interrupted attempts, and loopback-local zero-API-cost behavior.
- Complete remote outbound context: OpenAI/Ollama Cloud/custom providers receive no context tools; verified loopback-local Ollama may receive only the bounded compiler tool schema.

For Ollama, retain separate cases for unauthenticated loopback native structured output and authenticated Cloud/custom prompt-constrained output. Ollama Cloud malformed JSON must remain terminal after local validation.

### Validation, repair, and apply changes

Test command argv/cwd/timeout validation, shell and implicit-downloader rejection, scrubbed environment, Docker/Podman/auto selection, unavailable strong runtimes, no-network flags, locally installed image inspection, immutable image-ID execution, pull prohibition, resource limits, output truncation, timeout cleanup, baseline failures, candidate regressions, fail-then-pass flakiness, pending manual checks, credential-bearing stdout/stderr discard, drift, same-run locking/stale-lock recovery, cross-run races, interruption, rollback-artifact provenance and loss, exact post-apply rollback, mode restoration, and non-Git application refusal.

Repair tests must cover healthy-baseline eligibility; refusal on security, infrastructure, timeout, signal, flaky, truncated, or unavailable-prerequisite results; the two-attempt and configured budget caps; cumulative request/token/cost accounting; immutable provider/model/provenance; frozen operations/paths/dependencies/lockfiles/tests/validation configuration; fresh candidates; request-ID uniqueness; checkpoint validation; crash allowance preservation; exact-config programmatic continuation; and the standalone CLI's no-provider behavior.

Sandbox tests must never mount developer credentials, agents, sockets, package-manager homes, or the actual repository as a writable candidate.

## Adding or changing an ecosystem profile

An ecosystem adapter must report evidence and ambiguity; it must not guess. Preserve existing framework architecture rather than introducing a competing router, state library, UI system, ORM, Python environment manager, async runtime, Rust feature policy, or test convention.

Document:

- Exact supported version range and how declared/resolved versions are proven.
- Static signals, workspace ownership, source/test/generated/protected roots, aliases, routes/entries/exports, and validation commands.
- Dynamic cases that remain opaque and the status/diagnostic they produce.
- Elevated-risk capabilities and required manual acceptance.
- At least 25 realistic positive and negative certification tasks before proposing `certified`.

All negative fixtures must fail safely. Certification has zero tolerance for secret transmission, scope escape, host mutation, unauthorized network access, lockfile hand-editing, auth/tenant bypass, or false `VERIFIED`.

## Adding a provider

Implement the provider-neutral adapter contract instead of coupling workflow code to a vendor SDK. A provider must expose structured generation, capabilities, cancellation, provider-reported model identity, finish reason, usage, normalized errors, and bounded request/response behavior. A remote adapter must also provide a conservative pre-request cost upper bound and account for actual reported usage at operator-reviewed rates; it must fail before network access if that policy is absent. Document whether an identifier is immutable; never present a moving alias or Ollama tag as a verified weight digest.

Remote providers require project consent and a complete outbound context preview. They must receive no compiler context tools and cannot expand the envelope after consent. A custom base URL requires explicit trust and a dedicated `apiKeyEnv`. Do not implement a convenience fallback to another provider or model.

An uncertified provider/model may produce a reviewable patch, but it cannot produce a certified run status.

## Documentation standards

Lead with the real outcome and current limitations. In particular:

- Do not describe any preview ecosystem/provider/model as certified.
- Do not say a generated patch “works” when validation is missing or inconclusive.
- Distinguish static analyzer status `SUPPORTED` from run status `VERIFIED`.
- Distinguish local Ollama from remote Ollama Cloud/custom endpoints.
- Describe current official retrieval precisely: built-in exact-version Rust `docs.rs` evidence plus exact operator-configured dependency/version mappings, not unrestricted browsing or complete language knowledge. State that online preview/tool retrieval can disclose dependency/version metadata before provider consent and that offline mode forbids it.
- Do not present a configured source mapping/content hash as independent proof of publisher identity or version semantics, or the syntax grounding gate as complete API verification.
- State that context tools are bounded and local-only; remote provider previews are complete and cannot grow after consent.
- Distinguish provider-reported model provenance from reproducible model-weight identity, and container image tags from the immutable local image ID actually executed.
- Describe remote pricing as operator-supplied conservative policy, not a live quote or invoice, and retain the provider-side spend-limit warning.
- Describe apply as per-file atomic and rollback-backed, not as a multi-file filesystem transaction; state that locks are scoped to one run ID.
- Keep all CLI commands, options, status names, exit codes, Node requirements, and config examples synchronized with implementation tests.

## Preview release gates

Keep these current limitations visible until their evidence changes:

- Every shipped ecosystem profile remains `preview` or `legacy`; no CLI provider/model certification entry exists, so generated runs cannot become `VERIFIED`.
- Apply and rollback are implemented but remain gated behind that unavailable certified status for normal preview runs.
- Built-in official web discovery is Rust `docs.rs`-only and either deterministically precomputed or local-tool-initiated; exact operator-configured sources are also supported, and remote providers cannot request missing context.
- Guided validation has a two-attempt, scope-frozen repair loop with provenance checkpoints. Standalone `validate <run-id>` has no provider authority; programmatic continuation requires the exact original provider/config.
- Dependency/toolchain/service provisioning is not implemented, and mixed ecosystems require an explicit trusted multi-toolchain image.
- The working HTTP provider integrations are OpenAI and Ollama only; other alpha config names are migration compatibility.

Do not remove a limitation because a positive fixture works once. Certification requires the declared cross-ecosystem benchmark, three-run provider/model/profile results, and all negative fixtures to fail safely.

## Pull-request checklist

- [ ] Scope is focused and public behavior is documented.
- [ ] `npm ci` succeeds from the committed lockfile.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including new negative cases.
- [ ] `npm run build` passes.
- [ ] `npm run package:check` passes from a clean tarball install.
- [ ] No credentials, private paths, provider responses, or run artifacts are included.
- [ ] New dependencies are justified, pinned, lockfile-reviewed, and license/security checked.
- [ ] No success/certification claim exceeds the evidence.
- [ ] New names and comments satisfy the source-clarity checklist; deprecated aliases are compatibility-only.

## Reporting security issues

Do not open a public issue for a vulnerability. Use the [private security advisory process](SECURITY.md#reporting-a-vulnerability).
