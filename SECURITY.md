# Security Policy

`human-to-code` reads attacker-controlled repositories, sends selected evidence to an LLM provider, and may execute project validation commands. The project therefore treats repository content, model output, documentation, provider endpoints, and build/test tooling as untrusted.

Version `0.1.21` is a preview. The shipped ecosystem and provider/model combinations are not certified, so guided generated runs do not reach `VERIFIED` through the CLI and guided automatic application/rollback remain unreachable for normal generated runs. The default direct converter is a separate convenience path that writes accepted units to the working tree after confirmation; it never claims `VERIFIED`. Do not weaken either boundary to make a preview run appear successful.

## Trust boundaries

The security design assumes all of the following may be malicious or simply wrong:

- A `.human` request, source comment, README, fixture, log, diagnostic, manifest, lockfile, generated file, installed dependency, or documentation page.
- An LLM response, tool call, model-reported usage value, resolved model identifier, or provider error.
- A configured custom endpoint, redirect, DNS answer, or service presenting itself as local Ollama.
- An npm script, Python packaging hook, application import, test, formatter, code generator, Cargo build script, proc macro, native dependency, or linker invocation.
- A concurrent process changing the working tree after analysis or generation.

The operator, operating system, Docker/Podman runtime and daemon, configured public provider, and reviewed change contract remain trusted. A compromised container runtime, host kernel, account, or provider is outside the isolation guarantee.

## Security invariants

### Static analysis does not execute the project

The analyzer reads bounded regular files and statically recognizes React, NestJS, FastAPI, and Cargo workspace signals. It does not import application modules, evaluate JavaScript/TypeScript or Python configuration, run framework CLIs, execute `setup.py`, or invoke Cargo during discovery. It does not follow symlinks.

Unreadable roots, non-directories, symlinked roots, scan truncation, conflicting project managers, multiple plausible targets, or unsupported dynamic metadata must return a non-success status. An empty or partial scan must never look like a supported project.

### Direct conversion has guarded writes, not sandbox verification

The direct converter treats model text as untrusted before writing: it accepts
at most one unambiguous fenced code block, validates the complete candidate's
new syntax/structure diagnostics relative to the unchanged baseline, refuses
existing sibling targets using both discovery checks and exclusive creation,
verifies exact inline marker bytes again at apply time,
and preserves marker indentation. Invalid or stale units are retried within the
bounded generation policy and then skipped without mutation.

JavaScript/TypeScript units additionally pass staged combined validation: the
generated files form an in-memory candidate overlay and the working tree stays
unchanged. The TypeScript Compiler API type-checks TypeScript, while JavaScript
semantic checking runs only when `checkJs` or `@ts-check` explicitly opts in;
plain JavaScript is not rewritten to satisfy an unrequested TypeScript policy.
Newly introduced cross-file
diagnostics (wrong imports/exports, missing members, argument counts, literal
unions, object shapes, readonly violations, incompatible calls) reject the
whole dependency-connected group during validation; if safe isolation cannot
be proven, the entire staged batch is rejected before application. A failing
whole-file unit may receive one bounded repair request using the same provider and model;
repair context contains only generated candidate content and normalized
compiler diagnostics plus bounded ProjectMemory, all treated as untrusted
data. Generated candidate
content is secret-scanned before it may leave the host. No project code is
imported or executed and no project scripts run during this validation.

Whole-file direct outputs have a final batch barrier. Any failed whole-file
candidate withholds every whole-file output in that run. Successful candidates
are then exclusively created as a rollback-protected batch; if a later create
fails, only files created by that batch are removed. Inline markers retain
their separate stale-range and per-marker behavior.

Direct ProjectMemory is rebuilt from the static discovery inventory for each
run. It may send project-relative filenames and compact source-derived
contracts (declarations/imports/includes, modules/packages/namespaces,
language-specific references, markup/style/asset contracts where relevant,
and limited package metadata) to the selected model. It also
contains the planned post-conversion output tree and other `.human` purposes so
the model can coordinate files. Protected paths, configured ignored/excluded
paths, oversized/unreadable files, and credential-bearing contracts are
omitted; individual renders are bounded and source is never executed. This is
not the provenance-rich guided `ContextManifestV1`, and the direct engine has
no `context --explain` preview. Remote direct conversion therefore remains
blocked until explicit project-level remote-provider consent; use local Ollama
or the guided flow when this compact context is not appropriate to transmit.

Post-generation integration reconciliation is a separate explicit opt-in
(`direct.reconcileIntegrations`, default `false`). When disabled, it performs
no audit and sends no additional request. When enabled, ProjectMemory supplies
structured language relationships and the generic orchestrator forms bounded
generated-file groups. A read-only audit must return strict JSON whose target
and related paths are members of that exact group. Each reported target may
receive one bounded repair followed by one verification audit. Audit/repair
bundles are credential-scanned; file purposes, contracts, diagnostics, and
source are prompt-isolated as untrusted evidence. Malformed output, invented
paths, exhausted context, or unresolved issues reject the connected opt-in
group before writing. This is model-assisted static consistency checking, not
compiler, runtime, or sandbox verification.

These controls prevent the specific malformed-output, overwrite, stale-range,
indentation, and cross-file-contract failures they check. Static compilation
is stronger than syntax parsing, but it does not prove runtime behavior,
external-API grounding, project-wide security properties, or test success,
and it never executes the candidate in a sandbox or claims `VERIFIED`. Other
direct programming languages keep their per-file structural validation level;
Non-JS/TS languages normally keep their per-file syntax/structure gates; the
optional generic reconciliation adds the bounded contract audit described
above. Use the guided contract and validation path when stronger boundaries
are required.

### The reviewed contract owns authority

The model cannot choose its own target, allowed files, operations, acceptance criteria, validation commands, or elevated risks. A `ChangeContractV1` is bound to the `.human` source hash and static project fingerprint. Material unresolved questions block generation.

Dependencies, lockfiles, migrations, public API breaks, authentication/authorization changes, validation configuration, unsafe Rust, FFI, delete, and rename operations require explicit reviewed authority. Repository text cannot authorize itself.

### The repository is scanned before provider access

Before context selection or any provider request, a dedicated fail-closed scanner reads first-party regular files across the repository, including ignored and untracked fixtures, logs, and configuration. It excludes third-party dependency/build stores (`node_modules`, Python virtual environments, Cargo `target`) and VCS/private tool internals because those are not first-party provider context.

The scan never follows symlinks. A hardlink, special file, read/race error, or file/byte budget exhaustion becomes `PARTIAL_SCAN`; it cannot silently skip to provider access. A finding reports only project-relative path, line, and secret kind. It never includes the matched value and returns `SECURITY_BLOCKED`. There is no remote-transmission override.

### Context is least-privilege and provenance-bound

Only selected evidence enters `ContextManifestV1`. Local files are root-confined regular text files with bounded sizes and exact line ranges/hashes. Protected names include environment files, credential stores, private keys, package-manager credential files, `secrets.human`, VCS internals, and the private run store.

Detected credential material is blocked before the provider boundary. There is no override for sending a detected secret to a remote provider. The manifest records redactions and exclusions without recording the credential value.

Official documentation is admissible only as allowlisted, versioned, content-hash-bound evidence. Built-in discovery retrieves only exact-version Rust `docs.rs` evidence selected by deterministic pre-provider grounding or requested through a local compiler tool. An operator may configure an exact ecosystem/dependency/version `officialSources` URL on an allowed public HTTPS domain; this is a fixed mapping after installed-version proof, not search or crawling. Offline mode requires the exact item in the cache. There is no automatic React, NestJS, FastAPI, or Python crawler. Generic model memory is not documentation provenance. Recognized external imports/use paths and named imported symbols without evidence are rejected, but the static extraction is not complete language-semantic proof.

Documentation retrieval is a separate network boundary from the LLM provider. In `local-first` mode it can occur while constructing the preview, before remote-provider consent. The built-in `docs.rs` URL reveals crate/version; an operator-configured source reveals its requested URL and may encode the same metadata. It does not upload source content in that HTTP request. Use `--offline` or documentation mode `offline` when even that request is prohibited.

The context-request interface is available only to verified loopback-local providers and is bounded to eight requests. It exposes only literal symbol search, one bounded workspace-file read, installed evidence for a proven dependency (plus the exact Rust `docs.rs` retrieval above), and files named by analyzer diagnostics. It provides no shell, arbitrary filesystem, write, general network, browser, Git, install, process, environment, or secret access. Remote providers receive no context tool definitions.

### Prompt injection is data, not policy

Repository and documentation content is wrapped as untrusted evidence. Instructions inside that evidence must never:

- Request credentials or environment values.
- Expand context outside the reviewed workspace or protected-path policy.
- Add tools, commands, dependencies, network access, or provider requests.
- Change budgets, validation commands, acceptance criteria, or contract scope.
- Weaken/remove tests, guards, tenancy checks, ownership checks, or safety gates.
- Declare a run successful.

A model tool call is schema-validated and independently authorized by the host. An unknown tool or an unavailable/out-of-scope request is rejected.

### Provider credentials and endpoints are bound

Configuration may contain only an environment-variable name such as `OPENAI_API_KEY` or `OLLAMA_API_KEY`; credential values in configuration are rejected. Errors, run artifacts, context manifests, and prompts must not persist environment values.

Remote context transmission requires explicit `privacy.remoteProviderConsent: true`. The exact context can be reviewed with:

```bash
human-to-code context <contract> --explain
```

For a remote provider, that output is the complete provider-bound envelope for the current project/config state. Re-run it after changing project files, private documentation, workspace overrides, or context policy. OpenAI, Ollama Cloud, and custom cloud endpoints receive no compiler context tools, so they cannot add a file or documentation item after consent. If the preview is insufficient, generation stops. Local Ollama may use the bounded context tools because source/context stays on the verified loopback endpoint; its final manifest records any additions. An online dependency-documentation tool request can still disclose dependency/version metadata to an approved documentation host as described above.

Provider and model selection are explicit and are never silently changed. Credentials are bound to that provider endpoint:

- OpenAI defaults to the official HTTPS Responses API and `OPENAI_API_KEY`.
- Local Ollama defaults to `http://localhost:11434/api`, must resolve entirely to loopback, and must not receive an API key.
- Ollama Cloud/custom endpoints require explicit trust. Official `https://ollama.com/api` uses `OLLAMA_API_KEY` by default; custom public HTTPS endpoints must name their own `apiKeyEnv`.

Every remote provider configuration must also include model-specific `pricing` input/output USD-per-million-token upper bounds. The host pessimistically charges a conservative input-token bound plus the maximum output allowance before each request and refuses the request when that reservation would exceed cumulative `maxCostUsd`; successful usage reconciles the reservation, while failed/in-flight attempts remain conservatively charged. Loopback-local Ollama is treated as zero remote API usage cost. Both remote rates can be zero only with an explicit `unmetered: true` operator assertion. Pricing values and that assertion are not a live price feed or independently verified. Understated rates or inaccurate provider usage can undercount real charges, so provider-side spend limits remain required defense in depth.

Endpoint validation rejects embedded credentials, query strings, fragments, non-HTTPS remote URLs, unsafe/private/link-local/multicast/documentation-network destinations, suspicious local domains, unsafe redirects, and DNS answers that change during a request. Plain HTTP is allowed only for explicitly trusted loopback Ollama. In production, provider and documentation HTTP(S) sockets connect to a vetted resolved address while preserving the approved hostname for TLS; DNS safety is not only an unpinned preflight check. Injected fetch functions are test seams and remain trusted test code.

Remote provider responses are size-bounded and locally parsed. Local Ollama receives a native JSON schema. Ollama Cloud receives a schema-constrained prompt because its native structured-output mode is unavailable; malformed or out-of-schema JSON is terminal in both cases.

Only timeout, rate-limit, and provider-server failures are retryable, at most twice. Authentication, cancellation, refusal, safety, schema, configuration, and budget failures are terminal. Provider/model fallback is prohibited.

The run record stores the configured model string, the identifier reported by the provider response, and request IDs. Those fields provide audit provenance, not independent attestation of model weights: OpenAI aliases and Ollama tags can move, and the Ollama response used here does not include a model-blob digest. Select an immutable provider version or digest where available when exact reproduction matters.

### Model output is an untrusted patch artifact

The model returns a `PatchSetV1`, not a shell script or arbitrary diff. Before any candidate execution, the host checks the contract/snapshot hashes, base-file hashes, requirement mappings, allowed paths and operations, protected paths, exact edit anchors, duplicate/overlapping operations, operation/byte limits, binary content, case collisions, path traversal, and symlink/hardlink escapes.

Fuzzy patching is prohibited. Generated files and lockfiles may not be hand-edited by the model. A rejected operation rejects the entire patch.

### Validation treats project commands as arbitrary code

Validation occurs only in private baseline/candidate snapshots. Commands are immutable argv arrays selected before generation; shell wrappers and implicit downloaders such as `npx` are blocked. No command is run on the host project tree.

The current strong sandbox uses a Docker-compatible CLI through Docker or Podman. `sandbox.engine: "auto"` probes Docker first and then Podman; either can be selected explicitly. The sandbox provides:

- No network for the validation container.
- A read-only container root filesystem.
- A scrubbed home and environment with credential-like variables blocked.
- Dropped Linux capabilities and `no-new-privileges`.
- Bounded CPU, memory, process count, time, disk-backed snapshot, and captured output.

The snapshot is writable inside the container because compilers/tests need build output. Host environment values, credential agents, and host sockets are not mounted; known credential-bearing filenames are excluded. Repository content can still contain an unknown sensitive format, so it remains untrusted. Treat the container runtime, daemon, host kernel, and installed validation image as privileged trusted computing base.

Validation never pulls an image. The configured reference must already be installed and inspectable, is resolved to a local immutable content ID, and executes with `--pull never`; failure to prove that state is `INCONCLUSIVE` and runs no project command. Default names are mutable tags, so operators who need repeatability across hosts should preload and select a reviewed digest explicitly. The writable snapshot has byte/operation limits on model patches and output limits, but no hard filesystem quota for compiler/test build artifacts in this preview.

Captured stdout/stderr is scanned before report or run-store persistence. If either stream contains credential-like content, both raw streams are discarded, only a constant security diagnostic is retained, and the run becomes `SECURITY_BLOCKED`. The run store also recursively scans every artifact string and refuses a detected credential before its atomic write.

The unchanged baseline runs before the candidate. Missing Docker/Podman support, pending manual checks, an unhealthy baseline, output truncation, missing prerequisites, and a fail-then-pass flaky check prevent verification. The tool must not ask an LLM to rewrite code merely to hide a missing linker, target, database, browser harness, cloud service, or private registry.

### Diagnostic repair is bounded and scope-frozen

The guided flow can request at most two repairs, capped further by `budgets.maxRepairs`, only when a healthy strong-sandbox baseline proves a deterministic candidate regression. Security findings, baseline failures, missing prerequisites, error/skipped commands, timeouts, signals, flaky or truncated results, and resource/infrastructure diagnostics are not repair prompts. Validation output is untrusted data inside the repair message.

A repair must retain the immutable contract/context/snapshot/plan provenance, provider and reported model identity, operation kinds and paths, requirement coverage, and existing test obligations. It cannot add or modify dependencies, lockfiles, tests, migrations, generated files, validation configuration, or other frozen operations. Every candidate is rechecked and run in fresh snapshot copies. Provenance-bound checkpoints record attempts, provider request IDs, and cumulative budgets before output interpretation so interruption cannot restore spent allowance. Standalone CLI validation makes no provider call; programmatic continuation requires the exact original provider and persisted config.

### Apply is separate, exact, and rollback-backed

Generation and validation do not modify the working tree. `human-to-code apply <run-id>` requires all of the following:

- Run status `VERIFIED`.
- A Git-backed project and intact private rollback artifacts; Git presence is a gate, not the rollback transaction.
- Unchanged contract, context, patch, report, project profile, snapshot, and touched-file hashes.
- Exclusive locking against another action on the same run ID.

Before application, the private run store receives a provenance-bound `rollback.json` containing the patch hash, prior file content and modes, created paths, and expected post-apply hashes. A successful apply then records `apply.json`. Application uses exact preflight checks, per-file atomic replacement, and best-effort in-process rollback on failure; it is not one filesystem-wide transaction.

`human-to-code rollback <run-id>` requires both artifacts, takes the exclusive run lock, verifies the current post-apply hashes, reverses operations, restores file modes, and records `rollback-result.json`. Any drift returns `INCONCLUSIVE` instead of overwriting subsequent work. Non-Git projects may be analyzed and receive reviewable patches, but automatic apply is disabled. Database migrations are never executed.

## Secrets and privacy guidance

Automated secret detection is defense in depth, not proof that arbitrary data is non-sensitive. Novel credential formats, proprietary identifiers, customer data, and business-sensitive code may not resemble a known token.

Before enabling a remote provider:

1. Review the contract and run `human-to-code context <contract> --explain`.
2. Keep credential/config artifacts outside the repository, use `privacy.excludedPaths` for other sensitive initial context, and confirm every exclusion in the manifest. The preview is complete for remote providers; review the final manifest as well when local Ollama uses context tools.
3. Use a least-privilege provider key dedicated to the selected endpoint.
4. Do not place real credentials, personal data, production logs, database dumps, or customer fixtures in `.human` files or source context.
5. Rotate a credential immediately if you believe it entered any provider request, cache, log, report, or test fixture.

Telemetry is disabled by default. This preview does not implement a telemetry sender. Future telemetry work must also honor `DO_NOT_TRACK` and must never include prompts, code, paths, diffs, environment values, provider responses, credentials, or stable project identity.

## Residual risks and non-goals

- Static framework graphs cannot completely understand arbitrary dynamic configuration, reflection, macros, runtime dependency injection, or generated code. Ambiguity must remain non-success.
- External-API grounding recognizes bounded import/use syntax and named symbols; it cannot prove every dynamic import, alias, member/property call, macro expansion, or reflective API. Documentation presence and content hashes do not replace compiler/typechecker/tests.
- An operator-configured `officialSources` entry asserts that its URL content applies to the exact installed version. The host verifies the mapping key, transport, and content hash, but not publisher ownership or semantic/version accuracy; do not map an unversioned or untrusted page as exact evidence.
- A valid, in-scope patch may still be semantically wrong. Strong validation and human review are both required, especially for UI behavior, authorization, tenancy, data migrations, unsafe Rust, FFI, and public APIs.
- Container isolation does not defend against a compromised container runtime, daemon, host kernel, validation image, or hardware/firmware.
- A malicious or compromised remote provider receives the exact context that the operator approved. Endpoint safety does not make the provider trustworthy.
- Local Ollama keeps traffic on the configured loopback endpoint, but the Ollama service and selected model can still read the supplied context.
- Denial of service through large repositories, slow compilers, or adversarial tests is reduced by limits, not eliminated.
- Secret recognition is pattern-based. Novel sensitive formats, personal data, proprietary identifiers, and business-sensitive code still require operator classification and exclusion.
- Built-in official web discovery is currently limited to exact Rust `docs.rs` evidence precomputed into the reviewable preview or requested by local Ollama; exact operator-configured mappings are also supported. Remote providers cannot expand their context after preview.
- The per-run lock does not serialize a different run ID or an external editor. Concurrent cross-run application can race after preflight; operators must serialize repository mutation themselves.
- A process/host crash during multi-file application can leave partial changes. The prewritten `rollback.json` preserves recovery material, but the CLI rollback command requires the completion-only `apply.json`, so interrupted application may require manual recovery.
- Rollback material is stored in the private platform-cache run store, not in a Git commit or index transaction. Cache cleanup can destroy recovery data; retain `HUMAN_TO_CODE_CACHE/runs` on protected durable storage before relying on apply/rollback.
- Diagnostic repair is implemented only in the guided flow or embedding API with the exact original provider/config. Standalone `validate <run-id>` does not initiate or resume provider repair.
- Sandbox dependency/toolchain/service provisioning is not implemented in this preview.
- This tool does not deploy code, install global dependencies, apply database migrations, manage production secrets, or replace a security review.

## Reporting a vulnerability

Please do not open a public issue or include a live credential in a report.

Use this repository's [private GitHub security advisory form](https://github.com/sharjeelbaig/human-to-code/security/advisories/new). Include:

- A concise description and realistic impact.
- A minimal reproduction against the newest release or main branch.
- Affected platform, Node version, provider mode, and sandbox runtime.
- Whether secret disclosure, host mutation, scope escape, unauthorized network access, false `VERIFIED`, auth/tenant bypass, unsafe patch application, or rollback overwrite/drift occurred.
- Suggested mitigations, if known.

Use synthetic credentials and minimized sample repositories. If the advisory form is unavailable, contact the repository owner through their GitHub profile to request a private channel without disclosing vulnerability details publicly.

Maintainers will coordinate investigation, remediation, release timing, and disclosure with the reporter. Do not test against infrastructure or accounts you do not own or have explicit permission to assess.
