<p align="center">
  <img src="assets/banner.svg" alt="human-to-code — write intent in plain language, compile it to real code" width="100%">
</p>

<p align="center">
  <a href="#release-status"><img alt="status: preview" src="https://img.shields.io/badge/status-preview-orange"></a>
  <img alt="node >= 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="CONTRIBUTING.md"><img alt="contributions welcome" src="https://img.shields.io/badge/contributions-welcome-brightgreen"></a>
</p>

`human-to-code` turns natural-language change requests — whole `.human` files or inline `@human` markers — into code. It has two entry points:

- **Direct converter** (the default `npx human-to-code .`): discovers each request and turns it straight into code, with a receipt and confirmation. Fast, works with small local models, and writes to the working tree **without** a change contract or sandbox validation.
- **Guided pipeline** (`human-to-code guided`): the security-constrained, production-architecture path. It statically analyzes the host project, binds the request to a versioned JSON change contract, limits what an LLM can see and request, validates the candidate in an isolated snapshot, and keeps application as a separate explicit action.

The guided pipeline is shown below:

```text
static project analysis
        ↓
reviewed ChangeContractV1 (.strict.human.json)
        ↓
grounded ContextManifestV1 + bounded compiler tools
        ↓
provider-generated PatchSetV1
        ↓
unchanged baseline vs candidate in a strong sandbox
        ↓
reviewed diff ── explicit apply only after VERIFIED ── exact rollback artifact
```

This is not a universal deterministic source-to-source compiler. The LLM writes framework-specific patch operations, but it does not choose its own scope, validation commands, credentials, documentation sources, or acceptance criteria. The `.strict.human.json` change contract, `VERIFIED` status, and `apply`/`rollback` machinery all belong to the guided pipeline — the default direct converter does not use them.

## Release status

> [!WARNING]
> This `0.1.x` release is a production-architecture **preview**, not a certified production release.

The shipped React, NestJS, FastAPI, and Rust profiles are currently `preview` (CRA is `legacy`), and no provider/model certification benchmark entry is enabled by the CLI. Therefore generated runs in this release cannot honestly become `VERIFIED`; even a clean strong-sandbox validation remains `INCONCLUSIVE`, and `apply` (therefore `rollback`) stays unreachable through a normal preview CLI run. This fail-closed behavior is intentional.

When no framework is recognized, the guided flow falls back to an ungrounded **`general`** preview workspace whose language comes from `human-to-code.config.json` (`language`, default `typescript`). General generation exists so a bare `.human` request against an unrecognized project still yields a reviewable patch instead of a hard `UNSUPPORTED` stop — but it is the lowest-trust path the tool offers: API grounding is skipped (there is no dependency evidence to prove), no toolchain is assumed, and every general run is pinned to `INCONCLUSIVE`, never `VERIFIED` and never auto-applied. Standalone `analyze` stays pure recognition and does not emit the general fallback. Provide a recognized project to get grounded, sandbox-validated output.

“Works in any project” means that analysis succeeds inside an explicitly declared capability and refuses ambiguous or unsupported cases. It does not mean that model confidence turns an unknown framework, version, environment, or toolchain into a supported one.

## Quick start

The published-package entry point is:

```bash
npx human-to-code .
```

By default this runs the **direct converter**, not an instruction to rewrite the whole directory. It:

1. Loads config and scans the project for `.human` files and inline `@human` markers, without importing application modules or executing project configuration.
2. Prints a receipt (language, provider, model, and the exact worklist) and asks for confirmation. Nothing is written until you confirm — or pass `-y`/`--yes`. If no request is found it returns `NEEDS_INPUT`.
3. On confirmation, converts each item with one model completion per unit and writes the result: a whole `.human` file becomes a sibling source file; an inline `@human` marker is replaced in place. Each item is independent — a failing one is skipped with a reason rather than aborting the rest.

The direct converter writes code straight to the working tree. It does **not** create a `.strict.human.json` change contract, run sandbox validation, produce a `VERIFIED` run, or perform the guided pipeline's repository-wide secret scan — only the indexed declarations it attaches to an inline prompt as context are secret-scanned (a finding is `SECURITY_BLOCKED`). For the reviewed contract → grounding → sandbox-validation lifecycle — where the `.strict.human.json` contract and the `VERIFIED`/`apply`/`rollback` machinery live — use `human-to-code guided` (see [The reviewed change contract](#the-reviewed-change-contract) and the [CLI](#cli) table).

No configured provider is needed to scan and preview. A default run selects loopback-local Ollama with `qwen2.5-coder:7b`, so a fresh `npx human-to-code .` never transmits code remotely by default. The model must already be installed; the tool never pulls it implicitly. To use another local model, OpenAI, or Ollama Cloud, create and edit a config (the command never overwrites one):

```bash
npx human-to-code --init .
# Edit human-to-code.config.json: select OpenAI, local Ollama, or Ollama Cloud.
```

Remote OpenAI/Ollama Cloud generation needs a config because `privacy.remoteProviderConsent` defaults to `false` and has no consent-enabling CLI flag.

Direct-converter example (inline marker converted in place):

```bash
printf '// @human add a function named health that returns { status: 200 }\n' > health.ts
npx human-to-code . --yes --model qwen2.5-coder:7b
# health.ts now contains the generated function in place of the marker.
```

Guided-pipeline example (reviewed contract, no code written until VERIFIED):

```bash
cat > add-health-route.human <<'EOF'
Add a health endpoint using the existing routing, response, authentication,
logging, and test conventions. It must not expose secrets or tenant data.
EOF

npx human-to-code guided . --provider ollama --model qwen2.5-coder:14b
# Review add-health-route.strict.human.json, resolve REVIEW-1, then rerun the same command.
```

From a source checkout:

```bash
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js .
```

Node.js 24 or newer is required.

## Generation engines

The direct `npx human-to-code .` flow discovers work (whole `.human` files and
inline `@human` markers), prints a receipt, and — after you confirm — converts
it. Two engines are available.

### Default: fast deterministic engine

The host does the orchestration; the model only writes code. For each unit the
host issues **one plain model completion** (no tool calls) and applies the
result by exact marker range. This is fast and works with small models — a 1.5B
coder model converts a four-marker file in ~4 seconds. Because it needs no
tool-calling, models that can only do plain text generation work fine.

- **Per-marker isolation** — each `@human` marker is generated and applied
  independently. If one marker's output is bad (e.g. a small model redeclares an
  existing symbol), that marker is retried, then skipped with a printed reason;
  the other markers still convert. One failure never aborts the run.
- **FileMemory** — declarations already in the file are shown to the model as
  read-only context (with few-shot examples) so it reuses rather than
  re-declares them.
- **Clear, stable output** — a single truncated status line per marker
  (`✓ app.ts (inline @human, line 12)` / `⊘ skipped … : <reason>`), plus an
  in-place elapsed spinner while a completion is in flight.

This engine cannot produce `VERIFIED` runs; for the reviewed, sandbox-validated
pipeline use `human-to-code guided`.

### `--agent`: LangGraph deep agent

`--agent` runs the [`deepagents`](https://docs.langchain.com/oss/javascript/deepagents/overview)
harness with the four deep-agent pillars — **Planning** (`write_todos`),
**File System** (a project-rooted `FilesystemBackend`, with writes denied on
VCS/dependency/config/secret paths), **Sub Agents** (`planner`/`implementer`/
`reviewer` via the `task` tool), and **Prompts** (per-role system prompts). The
model drives scope, file edits, and delegation; live progress streams to the
terminal.

This engine needs a **tool-calling-capable model** (~7B+). It is reached through
the OpenAI-compatible chat client (Ollama via its `/v1` endpoint, since the deep
agent's structured tool messages are not supported by the native `/api/chat`
surface). Small models that cannot emit valid tool calls fail with a
tool-call/XML parse error; the CLI detects this and suggests a larger model or
the default engine. It also pulls the runtime dependencies `deepagents`,
`langchain`, `@langchain/core`, `@langchain/openai`, and `@langchain/ollama`.

```bash
# Fast deterministic engine (default) — works with small models:
npx human-to-code . --yes --model qwen2.5-coder:1.5b

# LangGraph deep agent — needs a tool-calling model:
npx human-to-code . --yes --agent --model qwen2.5-coder:7b
```

## The reviewed change contract

`foo.strict.human.json` is a `ChangeContractV1`, not a prompt and not an executable language. It binds the request to the SHA-256 of `foo.human` and the current project-profile fingerprint. It also records:

- Target workspaces and symbols.
- Requirements and automated/manual acceptance criteria.
- Allowed paths and create/edit/rename/delete operations.
- Prohibited paths and prohibited changes.
- Assessed risks, explicitly authorized elevated risks, and unresolved questions.

Generation stops if the source or project profile has changed, a material question remains, or the contract does not explicitly authorize a dependency addition, lockfile change, migration, public API break, authentication change, validation change, unsafe Rust, or FFI work.

The draft is deliberately conservative. Do not remove its review question until the contract accurately describes the intended change. Committing the `.human` source and reviewed contract makes the decision boundary auditable; generated run artifacts remain in the private run store.

## CLI

| Command | Behavior |
| --- | --- |
| `human-to-code [root]` | Default direct flow: discover `.human` files and `@human` markers, show a receipt, and on confirmation convert them with the **fast deterministic engine** (one plain model completion per marker; see below). `npx human-to-code .` is the normal entry point. |
| `human-to-code [root] --agent` | Same direct flow using the **LangGraph deep agent** (planning/filesystem/subagents). Needs a tool-calling-capable model (~7B+). |
| `human-to-code guided [root]` | Reviewed contract → grounding → sandbox-validation lifecycle. The only path that can reach `VERIFIED`. |
| `human-to-code analyze [root] [--json]` | Produce a deterministic multi-workspace project profile and diagnostics. `SUPPORTED` means statically recognized, not certified. |
| `human-to-code plan <file.human> [--root <root>]` | Write a review-blocked `ChangeContractV1` draft. |
| `human-to-code context <contract> --explain [--offline] [--json]` | Show the complete remote-provider outbound context envelope with ranges, hashes, reasons, redactions, and exclusions. `--explain` is mandatory. |
| `human-to-code generate <contract> --provider … --model …` | Create a run record and reviewable structured patch. It does not mutate the working tree or run validation. |
| `human-to-code validate <run-id>` | Compare the unchanged baseline and candidate with the preselected validation plan in a strong sandbox. This standalone command does not make provider repair calls. |
| `human-to-code apply <run-id>` | Apply an unchanged, `VERIFIED` Git-backed run after exact hash checks, using per-file atomic replacement and a rollback artifact. |
| `human-to-code rollback <run-id>` | Restore a successfully applied run from its private rollback artifact after exact post-apply hash checks. |
| `human-to-code check [root]` | Check that every `.human` source has a valid, reviewed, current contract. |
| `human-to-code migrate-config [root]` | Migrate the alpha config explicitly and preserve a `.alpha.bak` backup. |
| `human-to-code --init [root]` | Create a schema-v1 config without overwriting an existing file. Review the generated provider before use. |

Useful options include `--file`, `--provider`, `--model`, `--base-url`, `--api-key-env`, `--input-cost-per-million`, `--output-cost-per-million`, `--unmetered-provider`, `--trust-custom-endpoint`, `--offline`, `--explain`, `--dry-run`, `--json`, `--sandbox-image`, `--docker-binary` (a Docker-compatible CLI override, including Podman), and `--manual-passed`.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | `VERIFIED`, or successful completion of a read-only/administrative command such as `analyze`, `context`, or `migrate-config`. A read-only exit `0` is not generation certification. |
| `1` | Usage or configuration error. |
| `2` | Stale contract/artifact or failed validation. |
| `3` | `NEEDS_INPUT`, `UNSUPPORTED`, or `INCONCLUSIVE`. |
| `4` | `SECURITY_BLOCKED`. |
| `5` | Provider or documentation dependency failure. |
| `6` | Internal error or partial scan. |

For generated runs, only `VERIFIED` is success. Skipped validation, missing sandbox support, flaky checks, unhealthy baselines, manual checks, unsupported profiles, or unavailable prerequisites must not be interpreted as exit code `0`.

## Configuration

Configuration is strict schema-versioned JSON. Unknown keys and credential-like values are rejected. Credentials are environment-only; `apiKeyEnv` contains an environment-variable **name**, never a key.

`--init` writes the complete frozen loopback-Ollama default and refuses to overwrite an existing file. Treat it as a reviewable template: confirm the installed model or select OpenAI/Ollama Cloud, set remote consent only after reviewing context policy, and keep credential values in the named environment variable.

For OpenAI or Ollama Cloud, leave `remoteProviderConsent` false while planning, run `human-to-code context <contract> --explain`, review every item, configure model-specific conservative pricing upper bounds, then set consent true. Remote providers receive no follow-up context tools, so this is the complete code/documentation envelope for the current project/config state. Re-run the preview after changing project files, private documentation, workspace overrides, or context policy.

This complete local-Ollama example shows the policy fields:

```json
{
  "schemaVersion": 1,
  "language": "typescript",
  "filesToIgnore": ["node_modules", ".git", "dist"],
  "allowNonHumanFiles": false,
  "provider": {
    "name": "ollama",
    "model": "qwen2.5-coder:14b"
  },
  "workspaces": [],
  "documentation": {
    "mode": "local-first",
    "privatePaths": [],
    "officialDomains": [],
    "officialSources": []
  },
  "privacy": {
    "remoteProviderConsent": false,
    "telemetry": false,
    "excludedPaths": [],
    "maxFileBytes": 512000,
    "maxContextTokens": 64000
  },
  "sandbox": {
    "required": true,
    "engine": "auto",
    "network": "none"
  },
  "budgets": {
    "maxCostUsd": 10,
    "maxInputTokens": 2000000,
    "maxOutputTokens": 120000,
    "maxRequests": 12,
    "maxRepairs": 2,
    "timeoutMs": 900000
  }
}
```

`language` is retained for alpha compatibility; static workspace analysis is authoritative in mixed-language repositories. `filesToIgnore` accepts exact file/directory names, not glob expressions. With `sandbox.engine: "auto"`, validation probes Docker first and then Podman; `"docker"` and `"podman"` select one explicitly. Neither runtime being available makes validation `INCONCLUSIVE` and runs no project command.

### Budget semantics

Request count, input/output tokens, repair count, and elapsed time are cumulative hard gates. Before network transmission, the host pessimistically charges a tokenizer-independent input upper bound plus the full requested output allowance; a repair request persists that checkpoint before it is sent. Successful provider-reported usage reconciles the reservation, while a failed or interrupted request keeps the conservative charge. Context ranking still uses an estimate and is a separate limit.

Remote OpenAI and Ollama Cloud/custom generation is blocked before any provider request unless `provider.pricing.inputUsdPerMillionTokens` and `outputUsdPerMillionTokens` are both configured. The bundled adapters use those operator-reviewed, model-specific upper rates to reserve conservative worst-case request spend before sending and to account for provider-reported token usage. A request whose reservation would exceed cumulative `maxCostUsd` is not sent. Loopback-local Ollama has zero remote API usage cost and does not require `pricing`.

These rates are policy inputs, not a live price feed or provider invoice. Set them at or above every applicable input/output rate for the exact model and endpoint, review them whenever pricing changes, and do not use zero for a billed service. Both rates may be zero only with an explicit `"unmetered": true` assertion (or `--unmetered-provider` together with both zero-rate CLI flags); that assertion is accepted as operator policy, not independently verified. Provider-reported usage can also be wrong. Keep provider-side account/project spend limits enabled; `maxCostUsd` is a local fail-closed guard, not billing reconciliation. If the conservative reservation exceeds the budget, reduce the reviewed token allowance or raise `maxCostUsd`; never understate pricing to force a request through.

### Model identity and reproducibility

The CLI sends exactly the configured model string, never silently falls back, and records the provider-reported response model plus request IDs. Repairs must return the same reported model identity as generation. That is audit provenance, not independent proof of model weights: aliases and Ollama tags such as `gpt-4o` or `qwen2.5-coder:7b` may move, and Ollama's chat response does not supply a model-blob digest here. Use an immutable provider version/digest when the provider supports one. The loopback default is privacy-safe, but it is not a reproducible weight pin.

### OpenAI

The OpenAI adapter uses the Responses API with strict JSON-schema output and the exact configured model ID. The default credential variable is `OPENAI_API_KEY`. Because OpenAI is remote, compiler context tools are disabled: the provider receives only the complete manifest previewed before consent and cannot request another file later.

```json
{
  "provider": {
    "name": "openai",
    "model": "gpt-4o-2024-08-06",
    "apiKeyEnv": "OPENAI_API_KEY",
    "pricing": {
      "inputUsdPerMillionTokens": 25,
      "outputUsdPerMillionTokens": 100
    }
  },
  "privacy": {
    "remoteProviderConsent": true
  },
  "budgets": {
    "maxCostUsd": 25
  }
}
```

The fragment above illustrates the relevant fields; retain `schemaVersion` and the other top-level policy from the full config. The numeric rates are deliberately conservative examples, not a current price quote—replace them with reviewed upper bounds for the exact provider/model. Never put the key itself in JSON:

```bash
export OPENAI_API_KEY='…'
```

### Ollama local

When `provider.name` is `ollama` and `baseUrl` is omitted, the adapter uses `http://localhost:11434/api`. Local Ollama is the only provider allowed to use plain HTTP, and only on a verified loopback destination. It must not receive `apiKeyEnv`.

To name an explicit local endpoint, acknowledge it:

```json
{
  "provider": {
    "name": "ollama",
    "model": "qwen2.5-coder:14b",
    "baseUrl": "http://127.0.0.1:11434/api",
    "trustCustomEndpoint": true
  }
}
```

Local Ollama receives the patch schema through its native `format` field. Output is still parsed and schema-validated locally. Because the endpoint is verified loopback-local, it may use the bounded compiler context tool for up to eight additional evidence requests; every addition is recorded in the final manifest.

### Ollama Cloud

For official Ollama Cloud, provide the HTTPS base URL and an environment-variable name. `OLLAMA_API_KEY` is the official endpoint default, but spelling it out makes credential binding reviewable.

```json
{
  "provider": {
    "name": "ollama",
    "model": "gpt-oss:120b-cloud",
    "baseUrl": "https://ollama.com/api",
    "trustCustomEndpoint": true,
    "apiKeyEnv": "OLLAMA_API_KEY",
    "pricing": {
      "inputUsdPerMillionTokens": 25,
      "outputUsdPerMillionTokens": 100
    }
  },
  "privacy": {
    "remoteProviderConsent": true
  },
  "budgets": {
    "maxCostUsd": 25
  }
}
```

```bash
export OLLAMA_API_KEY='…'
```

Replace the example pricing with reviewed upper bounds for the selected Cloud model. Ollama Cloud does not currently expose Ollama's native structured-output mode. The adapter sends the JSON schema as a host-enforced instruction, parses exactly one JSON value, and applies the same local schema gate. Malformed or out-of-schema output is terminal; it is never accepted as a patch. As a remote provider, Ollama Cloud receives no context tool definitions and cannot expand the reviewed outbound manifest.

### Custom Ollama-compatible cloud endpoint

A custom remote endpoint must be an explicitly trusted public HTTPS URL and must name its own credential environment variable:

```json
{
  "provider": {
    "name": "ollama",
    "model": "exact-model-id",
    "baseUrl": "https://models.example.com/api",
    "trustCustomEndpoint": true,
    "apiKeyEnv": "EXAMPLE_OLLAMA_API_KEY",
    "pricing": {
      "inputUsdPerMillionTokens": 25,
      "outputUsdPerMillionTokens": 100
    }
  },
  "privacy": {
    "remoteProviderConsent": true
  },
  "budgets": {
    "maxCostUsd": 25
  }
}
```

Credentials and reviewed pricing bounds are bound to the selected endpoint and are not inherited from another provider. Replace the example rates with conservative bounds for that service. URLs with userinfo, query strings, fragments, unsafe redirects, private-network destinations, or DNS rebinding are blocked. Production HTTP(S) connections are made to the vetted resolved address while retaining the reviewed hostname for TLS, so DNS validation is not merely a preflight followed by an unpinned lookup. The adapter never silently switches provider or model. Custom remote Ollama-compatible endpoints have the same complete-preview/no-dynamic-context rule as official Ollama Cloud.

The configuration schema still recognizes alpha provider names for migration compatibility, but this preview's CLI has HTTP adapters only for `openai` and `ollama`; selecting Anthropic, Grok, or Gemini stops with a configuration error.

## Project intelligence and grounding

Analysis is static and read-only. It does not import Python modules, execute JavaScript/TypeScript configuration, run framework CLIs, or invoke Cargo. It inventories workspace ownership, manifests and lockfiles, exact version evidence, aliases, routes/entry points, source/test/generated/protected roots, framework signals, and candidate validation commands.

The current support matrix declares preview profiles for:

- React: Vite SPA/SSR, Next App/Pages/Hybrid routers, React libraries, Nx, and legacy CRA.
- NestJS: standalone, Nest CLI monorepo, and Nx projects, including static module/DI, HTTP-adapter, auth, and ORM signals.
- FastAPI: application layouts with environment-manager, router/dependency, Pydantic, and sync/async signals.
- Rust: Cargo crates and workspaces with edition, toolchain, feature, target, `unsafe`, FFI, build-script, proc-macro, and native dependency signals.

Conflicting lockfiles or environment managers, multiple plausible applications, unresolved dynamic metadata, unsupported versions, unreadable paths, symlinks, or scan limits return a non-success status rather than choosing by directory order.

Context is selected from relevant project definitions/tests/configuration and nearby patterns, exact installed dependency declarations/source and lock evidence, and operator-configured private documentation. Every admitted item records its location, line range, version where applicable, SHA-256, reason, redactions, and exclusion decisions.

Built-in official-documentation discovery is deliberately narrow in this preview: deterministic pre-provider grounding, and a local compiler-tool request, may fetch a Rust dependency's `docs.rs` page only when the analyzer has an exact resolved version. Operators may add `documentation.officialSources` mappings for an exact ecosystem/dependency/version and an allowlisted HTTPS URL; this enables only that mapping after installed-version proof, not general search or crawling. Pre-provider evidence appears in the complete remote preview; remote models still cannot initiate another lookup. The retriever enforces public DNS, pins production connections to a vetted address, applies an allowlist and bounded content, safely revalidates redirects/DNS, and uses a version-and-content-hash cache with strict offline hits. There is no automatic React, NestJS, FastAPI, Python, or general documentation crawler.

`documentation.mode: "local-first"` may contact an approved documentation host while building `context --explain`, before any LLM-provider consent or request. The built-in `docs.rs` URL discloses the crate and exact version; a configured mapping discloses its requested URL and may encode the same metadata. No source content is uploaded in the documentation request. Use `--offline` or `documentation.mode: "offline"` to prohibit that network access and require an exact cache hit.

Generic model memory is never provenance. The host rejects recognized new JavaScript/TypeScript, Python, and Rust external imports/use paths—and their statically named imported symbols—when the selected evidence does not prove them. This is a conservative syntax gate, not a complete language-service proof: dynamic imports, reflection, macros, aliases, and member/property APIs may be opaque. Such cases still depend on compiler/typechecker/tests and cannot earn certification from model confidence or documentation presence alone.

## Compiler skills and tools

Built-in compiler skills are immutable policy data selected for the detected ecosystem:

- Core change-contract scope and provenance.
- React routing, server/client, state/data/UI, environment, and testing conventions.
- NestJS module/DI, guards, DTO runtime validation, ORM, tenancy, and HTTP-adapter conventions.
- FastAPI environment, dependency injection, Pydantic, sync/async, transaction, auth, and serialization conventions.
- Rust Cargo, MSRV/toolchain, feature/target, public API, `unsafe`, FFI, and lockfile conventions.

They are not repository scripts and cannot grant authority. The model has no shell, browser, write, install, Git, secret, or arbitrary-filesystem tool. Context tools are advertised only to a verified loopback-local endpoint (currently local Ollama), which can make at most eight host-validated requests of four kinds:

- Literal symbol search over bounded files in one analyzed workspace.
- Read one bounded, non-protected workspace file.
- Read installed declarations or manifest/lock evidence for a proven dependency.
- Read files already named by analyzer diagnostics.

Every local request remains root-confined, path-checked, size-limited, token-budgeted, and recorded in the final context manifest. A local dependency-documentation request may still make the allowlisted metadata-only web lookup described above unless offline mode is enabled. Remote OpenAI, Ollama Cloud, and custom cloud providers receive **no** compiler tools; `context --explain` is therefore the complete provider-bound envelope, not an initial sample that can grow after consent. If the preview does not contain enough evidence, remote generation stops instead of widening it. Source comments, READMEs, `.human` text, diagnostics, dependency source, and documentation are wrapped as untrusted evidence and cannot change policy, commands, scope, tests, or budgets.

## Validation and apply

Before context selection or any provider call, a separate fail-closed scanner walks first-party regular files across the repository, including ignored/untracked fixtures, logs, and configuration. It excludes third-party dependency/build stores and VCS/run-store internals, skips symlinks, and reports only path, line, and finding kind—not the matched value. Budget exhaustion, hardlinks, special files, races, or unreadable paths are partial-scan failures. A credential-like finding is `SECURITY_BLOCKED`.

Generation runs against an immutable snapshot and produces `PatchSetV1` operations with exact base hashes and requirement mappings. Patches are rejected before execution for scope violations, protected/generated/lockfile edits, stale or non-unique edit anchors, path traversal, symlink/hardlink escapes, binary content, case collisions, overlapping operations, or size/operation limits.

Validation captures argv arrays before generation, runs the unchanged baseline first, then runs the candidate through Docker or Podman in a strong OCI sandbox. The validation container has no network, a read-only root filesystem, a scrubbed home/environment, dropped capabilities, no-new-privileges, and CPU/memory/process/time/output limits; only its disposable workspace snapshot is writable. `auto` probes Docker and then Podman. Project tests, package scripts, formatters, Cargo build scripts, proc macros, and packaging hooks are treated as arbitrary code execution.

Validation never pulls an image. The configured image must already exist locally, is resolved to its immutable content ID before execution, and that ID is recorded in diagnostics; otherwise no project command runs and validation is `INCONCLUSIVE`. Default image names are convenient tags, so preload the reviewed image and pass an immutable digest with `--sandbox-image` when repeatability across machines matters. Docker/Podman, its daemon, the host kernel, and the installed image remain part of the trusted computing base.

Captured stdout and stderr are scanned before report persistence. If either contains credential-like content, both raw streams are discarded, the report contains only a constant `SECURITY_BLOCKED` diagnostic, and the run is security-blocked. The private run store independently refuses any artifact string that matches a secret pattern.

No strong sandbox means no project command runs and the result is `INCONCLUSIVE`. Baseline failures, fail-then-pass flakiness, pending manual checks, unavailable toolchains/services, or mixed ecosystems without an explicit multi-toolchain image also prevent verification.

The `human-to-code guided` flow may ask the same provider/model for at most two diagnostic repairs, further limited by `budgets.maxRepairs`. Repairs run only for deterministic candidate regressions after a healthy baseline in the strong sandbox. They cannot run for security findings, infrastructure/toolchain failures, timeouts, flaky/truncated output, or unavailable services, and they cannot change paths/operation kinds, provenance, requirement coverage, dependencies, lockfiles, test operations, validation configuration, or remove existing proposed test obligations. Every accepted repair is safety-checked and validated from fresh baseline/candidate copies.

Repair checkpoints preserve cumulative request/token/cost/repair usage, provider identity, request IDs, immutable input hashes, attempt patches/diffs, and reports. A crash cannot reset the allowance. The standalone `validate <run-id>` command deliberately has no provider credentials and therefore only revalidates the stored patch; an embedding caller can continue any remaining repair allowance only by supplying the exact original provider and persisted configuration.

`generate` and `validate` never mutate the working tree. `apply` is separate and requires a `VERIFIED` run, unchanged provenance and base hashes, a Git-backed project, an intact private run store, a same-run lock, and per-file atomic replacement. Before mutation it stores a private `rollback.json` containing the patch hash, prior content/modes, created paths, and expected post-apply hashes; a successful application adds `apply.json`. Application is rollback-backed, not a filesystem-wide transaction: the implementation attempts in-process restoration if an operation fails. Git presence is a safety gate in this preview; the tool does not create a commit or use the Git index as its rollback mechanism.

`human-to-code rollback <run-id>` requires those artifacts, takes the same exclusive run lock, checks that applied content still has the exact expected hashes, reverses operations, restores modes, and writes `rollback-result.json`. Drift makes rollback `INCONCLUSIVE` rather than overwriting newer work. Database migrations may be generated for review but are never applied; generated files and lockfiles are protected from model-authored edits.

The lock serializes actions for one run ID only; it is not a repository-global editor or cross-run lock. Do not apply two runs or edit touched files concurrently. Exact hashes detect most drift, but a process or host crash during the multi-file apply can leave partial changes; because `apply.json` is written only after completion, recover such an interrupted apply manually from the private `rollback.json` artifact before continuing. Run records default to the platform cache (`HUMAN_TO_CODE_CACHE/runs` when that variable is set), so an operator relying on rollback must place and retain that directory on protected durable storage.

## Remaining preview limitations

- No shipped ecosystem profile or provider/model pair has passed the required certification benchmark. Preview-generated runs cannot become `VERIFIED`, so apply/rollback are implemented safety paths but are not enabled for normal generated runs yet. Certification is decided by a fail-closed WRITE gate: a run is certified only when host-owned, re-scored benchmark evidence exists for that exact provider/model profile and every target ecosystem — at least 25 tasks per ecosystem, three runs each, and a ≥95% strong-sandbox pass rate. The evidence registry ships empty and is never sourced from the analyzed repository, so no self-attestation or model confidence can certify a run. Shipping a real, scored corpus is what will unblock `VERIFIED` and 1.0.
- Built-in official web discovery is limited to exact-version Rust `docs.rs` evidence selected deterministically before provider access or requested by local Ollama. Other ecosystems have no automatic crawler; they use local evidence/private documentation or exact operator-configured `officialSources` mappings.
- Remote providers deliberately cannot request follow-up context. If the complete outbound preview lacks an API or symbol, generation stops; it does not fetch more after consent.
- Guided validation implements the bounded repair loop and crash-safe checkpoints described above. The standalone `validate <run-id>` CLI cannot initiate or resume provider repairs; only the guided flow or an embedding caller holding the exact provider/config can use the remaining allowance.
- There is no dependency/toolchain/service provisioning phase. Missing packages, browser harnesses, linkers, targets, databases, or cloud services cannot be repaired by the model and prevent verification.
- Mixed-ecosystem validation needs an explicitly supplied trusted multi-toolchain image. UI behavior, security policy, migrations, unsafe Rust/FFI, and other manual criteria still require human review.
- The CLI has real HTTP adapters only for OpenAI and Ollama. Alpha-compatible Anthropic, Grok, and Gemini config names remain migration inputs, not working provider integrations.

## Run statuses

Every generated run has exactly one status:

- `VERIFIED` — all required checks passed in a strong sandbox for a certified profile/provider/model combination.
- `NEEDS_INPUT` — a material choice, consent, credential, or contract decision is missing.
- `UNSUPPORTED` — the project capability is outside the declared matrix.
- `INCONCLUSIVE` — a patch or validation evidence exists, but certification cannot be completed.
- `FAILED` — generation or validation failed.
- `SECURITY_BLOCKED` — a secret, unsafe endpoint, path escape, or prohibited operation was detected.

Only `VERIFIED` authorizes automatic application. See [SECURITY.md](SECURITY.md) for the trust model and [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants changes must preserve.

## Codebase documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, pipeline flow, and design decisions.
- [docs/MODULES.md](docs/MODULES.md) — per-file guide to `src/` and the test map.
- [docs/SCALABILITY.md](docs/SCALABILITY.md) — layering rules, extension points (new ecosystems, providers, schema versions), and engineering practices.

## Development checks

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

`package:check` builds a tarball, installs it into a clean temporary project, imports the public entry point, and invokes the installed CLI.

## License

[MIT](LICENSE) © the human-to-code authors
