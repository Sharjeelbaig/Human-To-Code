# Contributing to human-to-code

Thanks for wanting to help. Before you dive in, one thing about how this project
works: it's a preview of the production architecture, so being reliable and
saying "no" honestly matters more than supporting lots of things or looking good
in a demo. A feature that works most of the time and lies about the rest is
worse than having no feature at all.

## Development setup

You'll need Node.js 24 or newer. Dev dependencies and the lockfile are pinned,
and please don't rely on Node's TypeScript type-stripping as the release path.

```bash
git clone https://github.com/sharjeelbaig/human-to-code
cd human-to-code
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

Commands you'll use a lot:

| Command | What it does |
| --- | --- |
| `npm run dev -- --help` | Run the TypeScript CLI while developing. |
| `npm run typecheck` | Type-check source and tests without emitting anything. |
| `npm test` | Run the `node:test` unit and integration suite. |
| `npm run build` | Compile the publishable package into `dist/`. |
| `npm run package:check` | Pack, clean-install, import, and invoke the installed CLI. |
| `npm run clean` | Delete generated `dist/` output. |

Heads up: `package:check` creates a temporary npm tarball while it runs, then
cleans it up afterward.

## Architecture

The production pipeline looks like this:

```text
static project analysis
  -> reviewed ChangeContractV1 (what is allowed to change)
  -> grounded ContextManifestV1 (the context used)
  -> provider-generated PatchSetV1 (the proposed edits)
  -> immutable ValidationPlanV1 (the checks to run)
  -> isolated baseline/candidate ValidationReportV1 (the check results)
  -> explicit apply only after VERIFIED
  -> provenance-bound rollback artifact and exact rollback
```

**New here?** Those are review records that guided mode creates  -  you don't
normally write them by hand. The change contract records the approved request,
the context manifest records which files and documentation got selected, the
patch set records the proposed edits, the validation plan records the checks
everyone agreed on, and the validation report records how they went.

For plain-English definitions of these and other terms, see the
[architecture glossary](docs/GLOSSARY.md). For a friendly walkthrough of the two
product journeys, the project culture, the folders and files, the important
functions, and who owns what when you're debugging, see the
[codebase tour](docs/CODEBASE_TOUR.md). Source names and comments follow the
intent-first rules in [docs/CODE_CLARITY.md](docs/CODE_CLARITY.md).

One framing that matters: the LLM generates structured code edits. It is *not* a
deterministic `strict -> code` compiler, and the docs must never claim it is.
Determinism lives in discovery, profiling, contract and schema validation,
context selection, patch safety checks, validation-plan selection, provenance
hashes, and application.

## Project layout

Source sits in layered domain folders. A module can import from its own layer or
from a layer above it in this table  -  never below. For the full dependency
rules see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for the newcomer tour see
[docs/CODEBASE_TOUR.md](docs/CODEBASE_TOUR.md); for a tight per-file reference
see [docs/MODULES.md](docs/MODULES.md); for terminology see
[docs/GLOSSARY.md](docs/GLOSSARY.md).

| Path | What lives there |
| --- | --- |
| `src/core/` | Shared primitives. `types.ts` holds public option/result types; `contracts.ts` holds versioned artifact types, exact validators, canonical serialization, and hashes. |
| `src/config/` | `config.ts` for strict schema-v1 configuration, endpoint policy, defaults, and alpha migration; `discovery.ts` for fail-closed `.human` discovery and protected secret-file detection. |
| `src/analysis/` | `analyzer.ts` and `analyzer-*.ts` handle root validation, bounded inventory, and deterministic multi-workspace profiling; `support-matrix.ts` holds versioned capability declarations and preview/certification tiers. |
| `src/analysis/adapters/` | Static React/NestJS, FastAPI/Python, Cargo/Rust, and ungrounded-general ecosystem adapters. |
| `src/security/` | `secret-scan.ts` runs the fail-closed first-party repository credential scan before any provider access; `pinned-http.ts` does DNS-vetted, address-pinned HTTPS fetching. |
| `src/context/` | `context.ts` for secret-aware, provenance-bound context selection; `documentation.ts` for allowlisted exact-version documentation retrieval, caching, and revalidation; `compiler-skills.ts` for non-executable ecosystem policy packs; `compiler-tools.ts` for the bounded read-only context-request executor. |
| `src/providers/` | `provider.ts` for provider-neutral schemas, budgets, normalized errors, and retry policy; `providers.ts` for the dependency-free OpenAI Responses and Ollama local/cloud HTTP adapters; `certification.ts` for the fail-closed provider/model certification gate; `schemas.ts` for provider-bound JSON output schemas. |
| `src/agents/` | `direct/` owns marker discovery, prompt calls, syntax gating, FileMemory, and guarded working-tree application. `guided/` owns reviewed generation, validation, apply, and rollback policy. |
| `src/pipeline/` | The deterministic mechanics both agents share: planning, snapshots, patch safety, sandbox validation, run storage, and declaration scanning. `simple.ts` and `workflow.ts` are compatibility re-exports and nothing else. |
| `src/index.ts` | The stable public embedding API, grouped by layer. |
| `src/cli.ts` | Guided and explicit command-line interfaces with fixed exit codes. |
| `test/` | Unit, adversarial, integration, and clean-package smoke tests. |
| `docs/` | Architecture, module guide, and scalability/engineering practices. |

## Non-negotiable safety invariants

Whatever you change, these have to survive it:

1. **`VERIFIED` is the only success for a generated run.** Missing checks,
   unavailable prerequisites, baseline failures, flakiness, manual checks,
   preview profiles or models, and incomplete scans can never turn into exit
   code `0` for generation.
2. **Analysis stays static.** Adapters don't import project modules, evaluate
   configuration, spawn framework tools, or follow symlinks.
3. **The reviewed contract owns scope.** Models can't add paths, operations,
   risks, dependencies, validation commands, acceptance criteria, or budgets.
4. **Repository and documentation text is untrusted data.** It can't change
   policy or tool authority  -  not in a comment, not in a diagnostic, not in a
   README, not in an installed dependency, not on an official-looking page.
5. **A credential found at a trust boundary never reaches a provider, cache,
   report, error, telemetry event, or test snapshot.** Scan first-party
   repository files before provider access, throw away credential-bearing
   validation output before it's persisted, and recursively gate run-store
   writes. Tests use values that are unmistakably synthetic and assert that raw
   values never escape.
6. **Credentials stay environment-only and endpoint-bound.** A config stores
   `apiKeyEnv` and nothing more, and a custom endpoint never inherits another
   provider's key.
7. **No arbitrary model tools.** Compiler tools stay read-only, root-confined,
   bounded, schema-validated, and auditable. Remote providers get no context
   tools at all, which is what makes their reviewed outbound envelope complete.
   Local tools must never gain shell, process, general network, install, Git,
   arbitrary-read, or write authority.
8. **Patch checks run before execution.** Reject the whole artifact on stale
   hashes, fuzzy anchors, scope violations, protected/generated/lockfile
   changes, path escapes, symlink or hardlink tricks, binary content,
   collisions, or operation/size bombs.
9. **Project commands are arbitrary code.** They run in the strong
   candidate/baseline sandbox, never in the working tree and never in the
   analyzer.
10. **Apply and rollback are separate and exact.** Apply needs `VERIFIED`,
    unchanged provenance and base hashes, a same-run lock, per-file atomic
    writes, and a pre-apply rollback artifact. Rollback needs the apply and
    rollback artifacts plus exact post-apply hashes, and it must never overwrite
    drift. Don't describe the multi-file operation as a filesystem transaction.
    Migrations are never applied.
11. **No silent fallback.** Never switch provider, model, version, workspace,
    package manager, router, environment, toolchain, validation command, feature
    set, or network policy automatically.
12. **Certification is evidence, not marketing.** New detection support starts
    at `preview` or `unsupported`. It only becomes `certified` after the
    declared benchmark and the negative fixtures both pass.

If your feature can't preserve one of these, open a design discussion before
writing code. And please don't add a bypass flag just to turn a fail-closed
result into a success.

## Making a change

1. Check existing issues, and open one for anything non-trivial touching
   architecture, schemas, providers, the sandbox, or the support matrix.
2. Keep the patch focused, and leave unrelated work in the repository alone.
3. Add tests for what you intended *and* for the most plausible ways it gets
   misused or fails.
4. When behavior or guarantees change, update `Readme.md`, `SECURITY.md`, public
   types, and schemas in the same change.
5. Run every development check from a clean install.
6. Spell out the security impact, compatibility impact, and remaining
   limitations in the pull request.

Name things for their lifecycle. An exported function should tell you its
action, its domain object, and the stage it belongs to  -  `discoverHumanInstructionSources`,
not `discover`. Boolean names should read as conditions, units should be visible
in the name, and checkpoint comments should explain the human-to-code role or
invariant they're guarding. [docs/CODE_CLARITY.md](docs/CODE_CLARITY.md) has the
complete practice and the compatibility rules.

Prefer focused `apply_patch`-style edits over bulk rewrites where you can. Don't
commit `dist/`, temporary snapshots, provider responses, generated run records,
credentials, private fixtures, or npm tarballs.

## Testing expectations

Tests have to be deterministic. They must not need a real provider, public
network, Docker/Podman daemon, database, cloud account, or developer
credential  -  unless they're clearly isolated optional integration tests.

### Analyzer and discovery changes

Add positive and negative fixtures for:

- Missing, unreadable, symlinked, non-directory, huge, and partially scanned
  roots.
- Nested, ignored, and untracked protected files, plus binary and special files.
- Repository-wide secret findings in ignored/untracked fixtures and logs,
  dependency-store exclusions, symlink confinement, hardlink and special-file
  failure, scan budgets, and value-free diagnostics.
- Conflicting lockfiles, package or environment managers, workspace ownership,
  routers, toolchains, or versions.
- Dynamic metadata that can't be understood safely without executing something.
- Monorepos with several ecosystems and ambiguous target applications.
- Stable ordering, evidence hashes, diagnostics, and profile fingerprints.

An adapter may inspect only the bounded analyzer context. Keep regular
expressions and static parsers defensive against adversarial input and
catastrophic backtracking.

### Schema, contract, context, and patch changes

Use exact-object validation  -  unknown fields must fail. Add tests for malformed
types, missing keys, duplicate IDs, non-canonical paths, stale hashes,
unauthorized inferred risk, material questions, scope expansion, prompt
injection, secret detection and redaction, content-hash mismatch, exact-version
`docs.rs` and configured `officialSources` retrieval/revalidation/offline
misses, import and use grounding plus its opaque language cases, token and file
limits, path traversal, symlink and hardlink races, case collisions, and patch
bombs.

Schema semantics are versioned. Reinterpreting something in a breaking way needs
a new schema version and an explicit migration  -  never silently reinterpret an
alpha or older artifact.

### Provider changes

Provider tests use injected fetch, DNS, environment, request-ID, clock, and
cancellation implementations. Cover:

- The exact request endpoint, model, schema, messages, tool definitions, and
  credential header.
- A missing or invalid environment variable, without exposing its value.
- Response byte limits, malformed JSON, schema mismatch, truncation, refusal,
  cancellation, and invalid usage.
- Timeout, rate-limit, and server retries bounded to two, with non-retryable
  failures staying terminal.
- Redirect handling, public-address checks, loopback checks, private-network
  rejection, DNS rebinding, and proof that production provider and documentation
  transports connect to the vetted pinned address while test fetch seams stay
  explicit.
- Exact configured and provider-reported model identity with no provider or
  model fallback. Tests must never treat a provider name or tag as proof of
  immutable model weights.
- Missing or malformed remote pricing, explicit unmetered-zero assertions,
  worst-case pre-request cost reservation, cumulative cost refusal before fetch,
  provider-reported usage reconciliation, conservatively charged
  failed/interrupted attempts, and loopback-local zero-API-cost behavior.
- Complete remote outbound context: OpenAI, Ollama Cloud, and custom providers
  receive no context tools, while verified loopback-local Ollama may receive
  only the bounded compiler tool schema.

For Ollama, keep separate cases for unauthenticated loopback native structured
output and authenticated Cloud/custom prompt-constrained output. Malformed JSON
from Ollama Cloud stays terminal after local validation.

### Validation, repair, and apply changes

Test command argv/cwd/timeout validation, shell and implicit-downloader
rejection, scrubbed environment, Docker/Podman/auto selection, unavailable
strong runtimes, no-network flags, locally installed image inspection,
immutable image-ID execution, pull prohibition, resource limits, output
truncation, timeout cleanup, baseline failures, candidate regressions,
fail-then-pass flakiness, pending manual checks, credential-bearing
stdout/stderr discard, drift, same-run locking and stale-lock recovery,
cross-run races, interruption, rollback-artifact provenance and loss, exact
post-apply rollback, mode restoration, and refusal to apply outside Git.

Repair tests need to cover healthy-baseline eligibility; refusal on security,
infrastructure, timeout, signal, flaky, truncated, or unavailable-prerequisite
results; the two-attempt and configured budget caps; cumulative request, token,
and cost accounting; immutable provider/model/provenance; frozen operations,
paths, dependencies, lockfiles, tests, and validation configuration; fresh
candidates; request-ID uniqueness; checkpoint validation; crash allowance
preservation; exact-config programmatic continuation; and the standalone CLI's
no-provider behavior.

Sandbox tests must never mount developer credentials, agents, sockets,
package-manager homes, or the actual repository as a writable candidate.

## Adding or changing an ecosystem profile

An ecosystem adapter reports evidence and ambiguity. It does not guess. Preserve
whatever framework architecture is already there instead of introducing a
competing router, state library, UI system, ORM, Python environment manager,
async runtime, Rust feature policy, or test convention.

Write down:

- The exact supported version range, and how declared or resolved versions get
  proven.
- Static signals, workspace ownership, source/test/generated/protected roots,
  aliases, routes/entries/exports, and validation commands.
- The dynamic cases that stay opaque, and which status and diagnostic they
  produce.
- Elevated-risk capabilities and the manual acceptance they require.
- At least 25 realistic positive and negative certification tasks before you
  propose `certified`.

Every negative fixture has to fail safely. Certification has zero tolerance for
secret transmission, scope escape, host mutation, unauthorized network access,
lockfile hand-editing, auth or tenant bypass, or a false `VERIFIED`.

## Adding a provider

Implement the provider-neutral adapter contract instead of wiring workflow code
to a vendor SDK. A provider has to expose structured generation, capabilities,
cancellation, provider-reported model identity, finish reason, usage, normalized
errors, and bounded request/response behavior. A remote adapter also needs a
conservative pre-request cost upper bound, has to account for actual reported
usage at operator-reviewed rates, and must fail before touching the network if
that policy is missing. Document whether an identifier is immutable, and never
present a moving alias or Ollama tag as a verified weight digest.

Remote providers require project consent and a complete outbound context
preview. They receive no compiler context tools, and they can't expand the
envelope after consent. A custom base URL requires explicit trust and its own
`apiKeyEnv`. Don't implement a convenience fallback to another provider or
model.

An uncertified provider/model pair can produce a reviewable patch. It cannot
produce a certified run status.

## Documentation standards

Lead with the real outcome and the current limitations. Specifically:

- Don't call any preview ecosystem, provider, or model certified.
- Don't say a generated patch "works" when validation is missing or
  inconclusive.
- Keep static analyzer status `SUPPORTED` distinct from run status `VERIFIED`.
- Keep local Ollama distinct from remote Ollama Cloud and custom endpoints.
- Describe official retrieval precisely: built-in exact-version Rust `docs.rs`
  evidence plus exact operator-configured dependency/version mappings  -  not
  unrestricted browsing and not complete language knowledge. Say that online
  preview and tool retrieval can disclose dependency and version metadata before
  provider consent, and that offline mode forbids it.
- Don't present a configured source mapping or content hash as independent proof
  of publisher identity or version semantics, and don't present the syntax
  grounding gate as complete API verification.
- Say that context tools are bounded and local-only, and that remote provider
  previews are complete and can't grow after consent.
- Keep provider-reported model provenance distinct from reproducible
  model-weight identity, and container image tags distinct from the immutable
  local image ID that actually runs.
- Describe remote pricing as operator-supplied conservative policy, not a live
  quote or an invoice, and keep the provider-side spend-limit warning.
- Describe apply as per-file atomic and rollback-backed, not as a multi-file
  filesystem transaction, and say that locks are scoped to a single run ID.
- Keep every CLI command, option, status name, exit code, Node requirement, and
  config example in sync with the implementation tests.

## Preview release gates

These limitations stay visible until the evidence behind them actually changes:

- Every shipped ecosystem profile is still `preview` or `legacy`, and no CLI
  provider/model certification entry exists  -  so generated runs can't become
  `VERIFIED`.
- Apply and rollback are implemented, but stay gated behind that unavailable
  certified status for normal preview runs.
- Built-in official web discovery is Rust `docs.rs` only, either
  deterministically precomputed or started by a local tool. Exact
  operator-configured sources work too, and remote providers can't request
  missing context.
- Guided validation has a two-attempt, scope-frozen repair loop with provenance
  checkpoints. Standalone `validate <run-id>` has no provider authority, and
  programmatic continuation needs the exact original provider and config.
- There's no dependency, toolchain, or service provisioning, and mixed
  ecosystems need an explicit trusted multi-toolchain image.
- The working HTTP provider integrations are OpenAI and Ollama. The other alpha
  config names exist for migration compatibility.

Don't remove a limitation because a positive fixture passed once. Certification
requires the declared cross-ecosystem benchmark, three-run
provider/model/profile results, and every negative fixture failing safely.

## Pull-request checklist

- [ ] Scope is focused and public behavior is documented.
- [ ] `npm ci` succeeds from the committed lockfile.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, including new negative cases.
- [ ] `npm run build` passes.
- [ ] `npm run package:check` passes from a clean tarball install.
- [ ] No credentials, private paths, provider responses, or run artifacts got included.
- [ ] New dependencies are justified, pinned, lockfile-reviewed, and checked for
      license and security issues.
- [ ] No success or certification claim goes beyond the evidence.
- [ ] New names and comments satisfy the source-clarity checklist, and any
      deprecated aliases are compatibility-only.

## Reporting security issues

Please don't open a public issue for a vulnerability. Use the
[private security advisory process](SECURITY.md#reporting-a-vulnerability)
instead.
