# Security Policy

`human-to-code` reads repositories an attacker may control, sends selected
evidence to an LLM provider, and can execute project validation commands. So it
treats repository content, model output, documentation, provider endpoints, and
build/test tooling as untrusted. All of it.

The `0.1.x` line is a preview. The ecosystem and provider/model combinations
that ship aren't certified, which means guided generated runs never reach
`VERIFIED` through the CLI, and guided automatic application and rollback stay
unavailable for normal generated runs. The default direct converter is a
separate convenience path  -  it writes accepted units to your working tree after
you confirm, and it never claims `VERIFIED`. Please don't weaken either boundary
just to make a preview run look successful.

## Trust boundaries

The design assumes every one of these could be malicious, or simply wrong:

- A `.human` request, source comment, README, fixture, log, diagnostic,
  manifest, lockfile, generated file, installed dependency, or documentation
  page.
- An LLM response, tool call, model-reported usage value, resolved model
  identifier, or provider error.
- A configured custom endpoint, a redirect, a DNS answer, or a service claiming
  to be local Ollama.
- An npm script, Python packaging hook, application import, test, formatter,
  code generator, Cargo build script, proc macro, native dependency, or linker
  invocation.
- A concurrent process changing the working tree after analysis or generation.

What stays trusted: you the operator, the operating system, the Docker/Podman
runtime and daemon, the configured public provider, and the reviewed change
contract. A compromised container runtime, host kernel, account, or provider is
outside what this isolation can promise.

## Security invariants

### Static analysis does not execute the project

The analyzer reads bounded regular files and statically recognizes React,
NestJS, FastAPI, and Cargo workspace signals. It does not import application
modules, evaluate JavaScript/TypeScript or Python configuration, run framework
CLIs, execute `setup.py`, or invoke Cargo while discovering. It does not follow
symlinks.

Unreadable roots, non-directories, symlinked roots, scan truncation, conflicting
project managers, multiple plausible targets, and unsupported dynamic metadata
all have to return a non-success status. An empty or partial scan must never be
mistaken for a supported project.

### Direct conversion has guarded writes, not sandbox verification

The direct converter treats model text as untrusted before it writes anything.
It accepts at most one unambiguous fenced code block, validates the complete
candidate's new syntax and structure diagnostics against the unchanged baseline,
refuses existing sibling targets using both discovery checks and exclusive
creation, re-verifies the exact inline marker bytes at apply time, and preserves
marker indentation. Invalid or stale units get retried within the bounded
generation policy, then skipped without touching anything.

JavaScript/TypeScript units go through staged combined validation on top of
that: the generated files form an in-memory candidate overlay while your working
tree stays untouched. The TypeScript Compiler API type-checks TypeScript, and
JavaScript semantic checking runs only when `checkJs` or `@ts-check` explicitly
opts in  -  plain JavaScript never gets rewritten to satisfy a TypeScript policy
you didn't ask for. Newly introduced cross-file diagnostics (wrong imports or
exports, missing members, argument counts, literal unions, object shapes,
readonly violations, incompatible calls) reject the whole dependency-connected
group during validation. If safe isolation can't be proven, the entire staged
batch is rejected before application. A failing whole-file unit can get one
bounded repair request using the same provider and model, and the repair context
holds only generated candidate content, normalized compiler diagnostics, and
bounded ProjectMemory  -  all of it treated as untrusted data. Generated candidate
content gets secret-scanned before it's allowed to leave the host. No project
code is imported or executed, and no project scripts run during this validation.

Whole-file direct outputs have a final batch barrier. One failed whole-file
candidate withholds every whole-file output in that run. The successful ones are
then exclusively created as a rollback-protected batch, and if a later create
fails, only the files that batch created get removed. Inline markers keep their
own separate stale-range and per-marker behavior.

Direct ProjectMemory is rebuilt from the static discovery inventory on every
run. It can send project-relative filenames and compact source-derived contracts
to the selected model  -  declarations, imports and includes, modules, packages
and namespaces, language-specific references, markup/style/asset contracts where
those apply, and limited package metadata. It also carries the planned
post-conversion output tree and the purposes of other `.human` files, so the
model can coordinate across them. Protected paths, configured ignored and
excluded paths, oversized or unreadable files, and credential-bearing contracts
are all left out; individual renders are bounded, and source is never executed.
This is not the provenance-rich guided `ContextManifestV1`, and the direct engine
has no `context --explain` preview. That's why remote direct conversion stays
blocked until you give explicit project-level remote-provider consent. If this
compact context isn't something you want transmitted, use local Ollama or the
guided flow.

Post-generation integration reconciliation is controlled by
`direct.reconcileIntegrations`, which defaults to `true`. Set it to `false` and
it audits nothing and sends no extra request. Left on, ProjectMemory supplies structured language
relationships and the generic orchestrator forms bounded generated-file groups.
A read-only audit has to return strict JSON whose target and related paths are
members of that exact group. Each reported target gets at most one bounded
repair, followed by one verification audit. Audit and repair bundles are
credential-scanned, and file purposes, contracts, diagnostics, and source are
prompt-isolated as untrusted evidence. Malformed output, invented paths,
exhausted context, or issues that stay unresolved reject the connected opt-in
group before anything is written. This is model-assisted static consistency
checking  -  not compiler, runtime, or sandbox verification.

These controls stop exactly the malformed-output, overwrite, stale-range,
indentation, and cross-file-contract failures they check for. Static compilation
beats syntax parsing, but it doesn't prove runtime behavior, external-API
grounding, project-wide security properties, or test success, and it never
executes the candidate in a sandbox or claims `VERIFIED`. Non-JS/TS languages
normally keep their per-file syntax and structure gates, and the optional
generic reconciliation adds the bounded contract audit described above. When you
need stronger boundaries than that, use the guided contract and validation path.

### The reviewed contract owns authority

The model doesn't get to choose its own target, allowed files, operations,
acceptance criteria, validation commands, or elevated risks. A
`ChangeContractV1` is bound to the `.human` source hash and the static project
fingerprint. Material unresolved questions block generation outright.

Dependencies, lockfiles, migrations, public API breaks,
authentication/authorization changes, validation configuration, unsafe Rust,
FFI, delete, and rename operations all need explicit reviewed authority.
Repository text can't authorize itself.

### The repository is scanned before provider access

Before context selection and before any provider request, a dedicated
fail-closed scanner reads first-party regular files across the repository  - 
including ignored and untracked fixtures, logs, and configuration. It skips
third-party dependency and build stores (`node_modules`, Python virtual
environments, Cargo `target`) and VCS/private tool internals, because those
aren't first-party provider context.

The scan never follows symlinks. A hardlink, special file, read or race error,
or an exhausted file/byte budget becomes `PARTIAL_SCAN`  -  it can't quietly skip
ahead to provider access. A finding reports the project-relative path, the line,
and the kind of secret. Never the matched value. And it returns
`SECURITY_BLOCKED`, with no remote-transmission override anywhere.

### Context is least-privilege and provenance-bound

Only selected evidence makes it into `ContextManifestV1`. Local files are
root-confined regular text files with bounded sizes and exact line ranges and
hashes. Protected names cover environment files, credential stores, private
keys, package-manager credential files, `secrets.human`, VCS internals, and the
private run store.

Detected credential material is blocked before the provider boundary, and
there's no override for sending a detected secret to a remote provider. The
manifest records the redactions and exclusions without ever recording the
credential value itself.

Official documentation is admissible only as allowlisted, versioned,
content-hash-bound evidence. Built-in discovery retrieves exact-version Rust
`docs.rs` evidence and nothing else, selected either by deterministic
pre-provider grounding or requested through a local compiler tool. You can
configure an exact ecosystem/dependency/version `officialSources` URL on an
allowed public HTTPS domain  -  that's a fixed mapping enabled after
installed-version proof, not search and not crawling. Offline mode requires the
exact item to already be in the cache. There is no automatic React, NestJS,
FastAPI, or Python crawler. Generic model memory is not documentation
provenance: recognized external imports and use paths, and the symbols they
name, are rejected without evidence  -  though the static extraction is not a
complete language-semantic proof.

Documentation retrieval is a different network boundary from the LLM provider.
In `local-first` mode it can happen while the preview is being built, before you
consent to a remote provider. The built-in `docs.rs` URL reveals the crate and
version, and a source you configure reveals its requested URL and may encode the
same metadata. No source content is uploaded in that HTTP request. Use
`--offline` or documentation mode `offline` when even that request is off the
table.

The context-request interface is available only to verified loopback-local
providers, and it's bounded to eight requests. It exposes literal symbol search,
one bounded workspace-file read, installed evidence for a proven dependency
(plus the exact Rust `docs.rs` retrieval above), and files named by analyzer
diagnostics. That's the complete list. No shell, no arbitrary filesystem, no write,
no general network, no browser, no Git, no install, no process, no environment,
no secret access. Remote providers receive no context tool definitions at all.

### Prompt injection is data, not policy

Repository and documentation content is wrapped as untrusted evidence.
Instructions hiding inside that evidence must never manage to:

- Request credentials or environment values.
- Expand context outside the reviewed workspace or the protected-path policy.
- Add tools, commands, dependencies, network access, or provider requests.
- Change budgets, validation commands, acceptance criteria, or contract scope.
- Weaken or remove tests, guards, tenancy checks, ownership checks, or safety
  gates.
- Declare a run successful.

Every model tool call is schema-validated and independently authorized by the
host. An unknown tool, or a request that's unavailable or out of scope, gets
rejected.

### Provider credentials and endpoints are bound

Configuration may contain an environment-variable name  -  `OPENAI_API_KEY`,
`OLLAMA_API_KEY`  -  and that's it. Credential values in configuration are
rejected. Errors, run artifacts, context manifests, and prompts must never
persist environment values.

Remote context transmission requires an explicit
`privacy.remoteProviderConsent: true`. You can review exactly what would go out
with:

```bash
human-to-code context <contract> --explain
```

For a remote provider, that output is the complete provider-bound envelope for
the current project and config state. Re-run it after changing project files,
private documentation, workspace overrides, or context policy. OpenAI, Ollama
Cloud, and custom cloud endpoints get no compiler context tools, so they can't
add a file or a documentation item after you've consented. If the preview isn't
enough, generation stops rather than quietly widening. Local Ollama is allowed
to use the bounded context tools, because source and context stay on the
verified loopback endpoint, and its final manifest records every addition. An
online dependency-documentation tool request can still disclose dependency and
version metadata to an approved documentation host, as described above.

Provider and model selection are explicit and never silently changed.
Credentials are bound to that provider endpoint:

- OpenAI defaults to the official HTTPS Responses API and `OPENAI_API_KEY`.
- Local Ollama defaults to `http://localhost:11434/api`, has to resolve entirely
  to loopback, and must not be given an API key.
- Ollama Cloud and custom endpoints require explicit trust. Official
  `https://ollama.com/api` uses `OLLAMA_API_KEY` by default; custom public HTTPS
  endpoints have to name their own `apiKeyEnv`.

Every remote provider configuration also needs model-specific `pricing` input
and output USD-per-million-token upper bounds. Before each request the host
pessimistically charges a conservative input-token bound plus the maximum output
allowance, and refuses the request if that reservation would push past
cumulative `maxCostUsd`. Successful usage reconciles the reservation, while
failed or in-flight attempts stay conservatively charged. Loopback-local Ollama
counts as zero remote API cost. Both remote rates can be zero only with an
explicit `unmetered: true` operator assertion. Neither the pricing values nor
that assertion is a live price feed or independently verified  -  understated
rates or inaccurate provider usage reporting can undercount what you're actually
charged, which is why provider-side spend limits remain required defense in
depth.

Endpoint validation rejects embedded credentials, query strings, fragments,
non-HTTPS remote URLs, unsafe/private/link-local/multicast/documentation-network
destinations, suspicious local domains, unsafe redirects, and DNS answers that
change mid-request. Plain HTTP is allowed only for explicitly trusted loopback
Ollama. In production, provider and documentation HTTP(S) sockets connect to a
vetted resolved address while keeping the approved hostname for TLS  -  DNS safety
here is not just an unpinned preflight check. Injected fetch functions are test
seams and stay trusted test code.

Remote provider responses are size-bounded and parsed locally. Local Ollama gets
a native JSON schema. Ollama Cloud gets a schema-constrained prompt instead,
since its native structured-output mode isn't available. In both cases,
malformed or out-of-schema JSON is terminal.

Only timeout, rate-limit, and provider-server failures are retryable, at most
twice. Authentication, cancellation, refusal, safety, schema, configuration, and
budget failures are terminal. Provider and model fallback is prohibited.

The run record stores the configured model string, the identifier the provider
response reported, and the request IDs. Those give you audit provenance  -  not
independent attestation of model weights. OpenAI aliases and Ollama tags can
move, and the Ollama response used here doesn't include a model-blob digest.
Pick an immutable provider version or digest where one exists if exact
reproduction matters to you.

### Model output is an untrusted patch artifact

The model returns a `PatchSetV1`  -  not a shell script, not an arbitrary diff.
Before any candidate execution, the host checks contract and snapshot hashes,
base-file hashes, requirement mappings, allowed paths and operations, protected
paths, exact edit anchors, duplicate and overlapping operations, operation and
byte limits, binary content, case collisions, path traversal, and symlink or
hardlink escapes.

Fuzzy patching is prohibited. The model may not hand-edit generated files or
lockfiles. One rejected operation rejects the entire patch.

### Validation treats project commands as arbitrary code

Validation happens only in private baseline and candidate snapshots. Commands
are immutable argv arrays chosen before generation, and shell wrappers plus
implicit downloaders like `npx` are blocked. No command is ever run on the host
project tree.

The current strong sandbox drives a Docker-compatible CLI through Docker or
Podman. `sandbox.engine: "auto"` probes Docker first and then Podman, or you can
select one explicitly. The sandbox gives you:

- No network for the validation container.
- A read-only container root filesystem.
- A scrubbed home and environment, with credential-like variables blocked.
- Dropped Linux capabilities and `no-new-privileges`.
- Bounded CPU, memory, process count, time, disk-backed snapshot, and captured
  output.

The snapshot is writable inside the container because compilers and tests need
somewhere to put build output. Host environment values, credential agents, and
host sockets are not mounted, and known credential-bearing filenames are
excluded. Repository content can still hold a sensitive format nobody
recognizes, so it stays untrusted. Treat the container runtime, its daemon, the
host kernel, and the installed validation image as privileged trusted computing
base.

Validation never pulls an image. The configured reference has to already be
installed and inspectable, gets resolved to a local immutable content ID, and
executes with `--pull never`. Failing to prove that state is `INCONCLUSIVE` and
runs no project command. Default names are mutable tags, so if you need
repeatability across hosts, preload and select a reviewed digest explicitly. The
writable snapshot has byte and operation limits on model patches plus output
limits, but there's no hard filesystem quota for compiler and test build
artifacts in this preview.

Captured stdout and stderr get scanned before the report or the run store
persists anything. If either stream holds credential-like content, both raw
streams are thrown away, only a constant security diagnostic is kept, and the
run becomes `SECURITY_BLOCKED`. The run store also recursively scans every
artifact string and refuses a detected credential before its atomic write.

The unchanged baseline runs before the candidate. Missing Docker/Podman support,
pending manual checks, an unhealthy baseline, output truncation, missing
prerequisites, and a fail-then-pass flaky check all prevent verification. And
the tool must never ask an LLM to rewrite code just to hide a missing linker,
target, database, browser harness, cloud service, or private registry.

### Diagnostic repair is bounded and scope-frozen

The guided flow can request at most two repairs, capped further by
`budgets.maxRepairs`, and only when a healthy strong-sandbox baseline has proven
a deterministic candidate regression. Security findings, baseline failures,
missing prerequisites, errored or skipped commands, timeouts, signals, flaky or
truncated results, and resource/infrastructure diagnostics are never repair
prompts. Validation output is untrusted data inside the repair message.

A repair has to keep the immutable contract, context, snapshot, and plan
provenance, the provider and reported model identity, the operation kinds and
paths, requirement coverage, and existing test obligations. It cannot add or
modify dependencies, lockfiles, tests, migrations, generated files, validation
configuration, or any other frozen operation. Every candidate is rechecked and
run in fresh snapshot copies. Provenance-bound checkpoints record attempts,
provider request IDs, and cumulative budgets *before* output is interpreted, so
an interruption can't give back an allowance that was already spent. Standalone CLI validation makes
no provider call at all; programmatic continuation requires the exact original
provider and persisted config.

### Apply is separate, exact, and rollback-backed

Generation and validation don't modify your working tree.
`human-to-code apply <run-id>` requires every one of these:

- Run status `VERIFIED`.
- A Git-backed project and intact private rollback artifacts. Git presence is a
  gate, not the rollback transaction.
- Unchanged contract, context, patch, report, project profile, snapshot, and
  touched-file hashes.
- Exclusive locking against another action on the same run ID.

Before it applies anything, the private run store receives a provenance-bound
`rollback.json` holding the patch hash, prior file content and modes, created
paths, and expected post-apply hashes. A successful apply then records
`apply.json`. Application uses exact preflight checks, per-file atomic
replacement, and best-effort in-process rollback on failure  -  it is not one
filesystem-wide transaction.

`human-to-code rollback <run-id>` needs both artifacts, takes the exclusive run
lock, verifies the current post-apply hashes, reverses the operations, restores
file modes, and records `rollback-result.json`. Any drift returns
`INCONCLUSIVE` instead of overwriting work that came after. Non-Git projects can
be analyzed and can receive reviewable patches, but automatic apply is disabled
for them. Database migrations are never executed.

## Secrets and privacy guidance

Automated secret detection is defense in depth. It is not proof that arbitrary
data is non-sensitive  -  novel credential formats, proprietary identifiers,
customer data, and business-sensitive code often look nothing like a known
token.

Before you enable a remote provider:

1. Review the contract and run `human-to-code context <contract> --explain`.
2. Keep credential and config artifacts outside the repository, use
   `privacy.excludedPaths` for other sensitive initial context, and confirm
   every exclusion in the manifest. The preview is complete for remote
   providers; when local Ollama uses context tools, review the final manifest
   too.
3. Use a least-privilege provider key dedicated to that endpoint.
4. Don't put real credentials, personal data, production logs, database dumps,
   or customer fixtures in `.human` files or source context.
5. Rotate a credential immediately if you think it made it into any provider
   request, cache, log, report, or test fixture.

Telemetry is off by default, and this preview doesn't implement a telemetry
sender at all. If telemetry ever gets built, it has to honor `DO_NOT_TRACK` and
must never include prompts, code, paths, diffs, environment values, provider
responses, credentials, or stable project identity.

## Residual risks and non-goals

- Static framework graphs can't fully understand arbitrary dynamic
  configuration, reflection, macros, runtime dependency injection, or generated
  code. Ambiguity has to stay non-success.
- External-API grounding recognizes bounded import/use syntax and named symbols.
  It can't prove every dynamic import, alias, member or property call, macro
  expansion, or reflective API. Documentation presence and content hashes don't
  replace the compiler, typechecker, and tests.
- An `officialSources` entry you configure asserts that its URL content applies
  to the exact installed version. The host verifies the mapping key, the
  transport, and the content hash  -  but not publisher ownership or semantic and
  version accuracy. Don't map an unversioned or untrusted page as exact
  evidence.
- A patch can be valid, in scope, and still semantically wrong. Strong
  validation and human review are both required, especially for UI behavior,
  authorization, tenancy, data migrations, unsafe Rust, FFI, and public APIs.
- Container isolation doesn't defend against a compromised container runtime,
  daemon, host kernel, validation image, or hardware/firmware.
- A malicious or compromised remote provider receives exactly the context you
  approved. Endpoint safety doesn't make the provider trustworthy.
- Local Ollama keeps traffic on the configured loopback endpoint, but the Ollama
  service and the model you selected can still read the context you supplied.
- Denial of service through enormous repositories, slow compilers, or
  adversarial tests is reduced by limits, not eliminated.
- Secret recognition is pattern-based. Novel sensitive formats, personal data,
  proprietary identifiers, and business-sensitive code still need you to
  classify and exclude them.
- Built-in official web discovery currently covers only exact Rust `docs.rs`
  evidence, either precomputed into the reviewable preview or requested by local
  Ollama. Exact operator-configured mappings work too. Remote providers can't
  expand their context after the preview.
- The per-run lock doesn't serialize a different run ID or an external editor.
  Concurrent cross-run application can race after preflight, so you have to
  serialize repository mutation yourself.
- A process or host crash during multi-file application can leave partial
  changes. The prewritten `rollback.json` preserves the recovery material, but
  the CLI rollback command requires the completion-only `apply.json`  -  so an
  interrupted application may need manual recovery.
- Rollback material lives in the private platform-cache run store, not in a Git
  commit or index transaction. Cache cleanup can destroy recovery data, so put
  `HUMAN_TO_CODE_CACHE/runs` on protected durable storage before you rely on
  apply and rollback.
- Diagnostic repair only exists in the guided flow, or in the embedding API with
  the exact original provider and config. Standalone `validate <run-id>` doesn't
  start or resume provider repair.
- Sandbox dependency, toolchain, and service provisioning isn't implemented in
  this preview.
- This tool doesn't deploy code, install global dependencies, apply database
  migrations, manage production secrets, or replace a security review.

## Reporting a vulnerability

Please don't open a public issue, and please don't put a live credential in a
report.

Use this repository's
[private GitHub security advisory form](https://github.com/sharjeelbaig/human-to-code/security/advisories/new).
Include:

- A short description and the realistic impact.
- A minimal reproduction against the newest release or the main branch.
- The affected platform, Node version, provider mode, and sandbox runtime.
- Whether you saw secret disclosure, host mutation, scope escape, unauthorized
  network access, a false `VERIFIED`, auth or tenant bypass, unsafe patch
  application, or rollback overwrite/drift.
- Suggested mitigations, if you have any.

Use synthetic credentials and minimized sample repositories. If the advisory
form isn't available, contact the repository owner through their GitHub profile
to ask for a private channel  -  without disclosing the vulnerability details
publicly.

Maintainers will coordinate investigation, remediation, release timing, and
disclosure with you. Please don't test against infrastructure or accounts you
don't own or have explicit permission to assess.
