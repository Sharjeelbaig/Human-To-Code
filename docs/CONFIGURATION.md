# `human-to-code.config.json` reference

Every field in the schema-v1 config file, one by one. If you'd rather read the
narrative setup guidance first, that's in the
[Configuration section of the Readme](../Readme.md#configuration).

## How the file gets read

- It has to be named exactly `human-to-code.config.json` and sit at the project
  root. Not having one isn't an error  -  the frozen defaults below kick in and
  every command still works.
- `human-to-code --init` writes the complete default file and refuses to
  overwrite one you already have. On a TTY it asks whether to enable compiler
  mode; non-interactive runs keep the documented `false` default.
- Loading is hardened: symlinks and non-regular files are rejected, the file is
  opened with `O_NOFOLLOW`, size and inode get re-checked after opening so a
  swap mid-read is caught, and the file can't exceed **1 MiB**.
- **Unknown keys are rejected at every level.** A typo is a hard error that
  names the exact dotted path  -  not a setting that silently does nothing.
- **Credential-looking keys are rejected before anything else happens.** Any key
  that normalizes to `key`, `secret`, or `token`, or ends in `secret`, `apikey`,
  `accesstoken`, `authtoken`, `bearertoken`, `clientsecret`, `password`,
  `passphrase`, `credential`, `credentials`, `privatekey`, or `authorization`
  gets refused anywhere in the file. The one exception is `apiKeyEnv`, which
  holds an environment-variable *name* and never a value.
- Validation fails fast. The first problem throws with a message that's safe to
  show a user, quoting the dotted path (like `` `direct.planning.enabled` ``).
- `documentation`, `privacy`, `sandbox`, `budgets`, `direct`, and `compiler` merge field by
  field onto the defaults, so a partial section keeps the rest of its defaults.
  `direct.planning` merges field by field too. Every other key  -  including the
  whole `provider` object and all arrays  -  gets replaced wholesale.

## Root keys

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `schemaVersion` | `1` |  -  | **Required.** Anything but `1` is rejected, and a missing value points you at `human-to-code migrate-config`. |
| `language` | string | `"typescript"` | One of `typescript`, `javascript`, `python`, `rust`, `html`, `css`. Kept around for alpha compatibility. Set it alongside `languages` and it has to be a member, then gets normalized to the first entry. |
| `languages` | string[] | `["typescript"]` | Non-empty, no duplicates, each from those same six. The first entry is your default output language. |
| `humanFileExtensions` | object[] | `[]` | At most 1000 entries, no duplicate paths (case-insensitive). This is the strongest routing signal you have  -  see below. |
| `filesToIgnore` | string[] | `["node_modules", ".git", "dist"]` | Bare file or directory **names**. Not paths, not globs. No `/`, `\`, `.` or `..`, at most 255 characters each, no duplicates. |
| `allowNonHumanFiles` | boolean | `false` | Accepted and validated, but **nothing currently reads it**. It has no effect on any run. |
| `provider` | object | see below | Replaced wholesale, never merged. |
| `workspaces` | object[] | `[]` | Per-workspace overrides. No duplicate roots (case-insensitive). |
| `documentation` | object | see below | Merged field by field. |
| `privacy` | object | see below | Merged field by field. |
| `sandbox` | object | see below | Merged field by field. |
| `budgets` | object | see below | Merged field by field. |
| `direct` | object | see below | Merged field by field. |
| `compiler` | object | see below | Opt-in deterministic diagnostics, lockfile, and replay. Merged field by field. |

### `humanFileExtensions[]`

Binds one exact `.human` source path to an output extension, so the wording of a
prompt can never change where a file ends up.

| Key | Type | Rules |
| --- | --- | --- |
| `path` | string | A portable repository-relative path, at most 1024 characters. Has to end in `.human`, and must **not** end in `.strict.human`. No absolute paths, drive letters, backslashes, or `.`/`..` segments. |
| `extension` | string | The leading dot is optional and the value gets lowercased. Must be one of `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `py`, `rs`, `html`, `htm`, `css`, and its language has to appear in `languages`. |

## `provider`

Replaced wholesale  -  so supplying `{"name": "openai"}` gives you exactly
`{name: "openai", model: "gpt-4o"}`. Sibling defaults are not preserved.

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `provider.name` | string | `"ollama"` | One of `openai`, `anthropic`, `ollama`, `grok`, `gemini`. Only `openai` and `ollama` have working adapters  -  the others pass the schema and then stop the run with a configuration error. |
| `provider.model` | string | per provider | Non-empty, trimmed, at most 256 characters. Defaults: `ollama` -> `qwen2.5-coder:7b`, `openai` -> `gpt-4o`, `anthropic` -> `claude-opus-4-8`, `grok` -> `grok-4.1`, `gemini` -> `gemini-2.5-pro`. Whatever string you configure is sent exactly, and never silently substituted. |
| `provider.baseUrl` | string | absent | Explicit lowercase scheme, and no userinfo, query, or fragment. Plain HTTP only for a trusted loopback Ollama endpoint, and loopback only for `ollama`. Private, link-local, CGNAT, and multicast literals are refused, as are `.localhost`, `.local`, and `.internal`. A fully qualified domain name is required. |
| `provider.trustCustomEndpoint` | `true` | absent | Can only be `true`, and only alongside `baseUrl`. Set automatically when `baseUrl` is present. |
| `provider.apiKeyEnv` | string | absent | An environment-variable **name** matching `/^[A-Z_][A-Z0-9_]{0,127}$/`. Never a credential. Forbidden on a plain-HTTP endpoint. Set to `OLLAMA_API_KEY` automatically for `https://ollama.com`. |
| `provider.pricing` | object | absent | **Required before any remote request.** See below. |

### `provider.pricing`

The operator-reviewed worst-case rates used to reserve spend before a remote
request goes out. They're a local policy input, not a live price feed.

| Key | Type | Rules |
| --- | --- | --- |
| `inputUsdPerMillionTokens` | number | `0`-`1000000`, fractional values allowed. |
| `outputUsdPerMillionTokens` | number | `0`-`1000000`, fractional values allowed. |
| `unmetered` | `true` | Required **exactly when** both rates are zero, and rejected otherwise. It's accepted as your policy and is not independently verified. |

Loopback-local Ollama has no remote API cost and needs no `pricing` at all.

## `documentation`

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `mode` | string | `"local-first"` | Either `local-first` or `offline`. |
| `privatePaths` | string[] | `[]` | Portable repository-relative paths holding project or private documentation. No duplicates. |
| `officialDomains` | string[] | `[]` | Lowercase public domains, at most 253 characters. No scheme, port, path, wildcard, or leading/trailing dot. Must contain a dot, and must not be an IP address. |
| `officialSources` | object[] | `[]` | At most 100 entries, with no duplicate `ecosystem`/`dependency`/`version` triples. |

### `documentation.officialSources[]`

| Key | Type | Rules |
| --- | --- | --- |
| `ecosystem` | string | One of `react`, `nestjs`, `fastapi`, `rust`. |
| `dependency` | string | At most 256 characters, matching `/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i`. |
| `version` | string | At most 128 characters, and an exact identifier. Moving targets (`latest`, `next`, `stable`, `nightly`, `main`, `master`, `head`, `dev`) and range operators (`<`, `>`, `=`, `^`, `~`, `*`) are refused. |
| `url` | string | HTTPS only, at most 2048 characters, no credentials, port, or fragment, and valid percent-encoding. The path or query **has to visibly contain the exact `version` string**, so a pinned entry can't quietly resolve somewhere else. |

## `privacy`

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `remoteProviderConsent` | boolean | `false` | Remote providers stay switched off until this is explicitly `true`. Direct conversion refuses to send anything to a non-loopback provider without it. |
| `telemetry` | boolean | `false` | Opt-in, and also forced off by the `DO_NOT_TRACK` environment variable. Nothing is currently emitted either way. |
| `excludedPaths` | string[] | `[]` | Portable repository-relative files or directories that must never enter outbound context. No duplicates. |
| `maxFileBytes` | integer | `512000` | `1024`-`100000000`. Files bigger than this aren't read for context or contracts. |
| `maxContextTokens` | integer | `64000` | `1000`-`2000000`. The direct engine multiplies this by four to get the combined FileMemory + ProjectMemory character budget for one request. |

## `sandbox`

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `required` | boolean | `true` | **Has to be `true`** in schema v1. `false` is a hard error. |
| `engine` | string | `"auto"` | `auto`, `docker`, or `podman`. `auto` probes Docker first, then Podman. Neither being available makes validation `INCONCLUSIVE` and runs no project command. |
| `network` | string | `"none"` | Has to be `"none"` in schema v1. |

## `budgets`

Cumulative hard ceilings for one run. Preflight accounting charges a
pessimistic, tokenizer-independent upper bound before a request goes out, and a
failed remote attempt keeps its conservative charge.

| Key | Type | Default | Range |
| --- | --- | --- | --- |
| `maxCostUsd` | number | `10` | `0`-`100000`, fractional allowed. |
| `maxInputTokens` | integer | `2000000` | `1000`-`10000000`. |
| `maxOutputTokens` | integer | `120000` | `1`-`1000000`. |
| `maxRequests` | integer | `60` | `1`-`100`. Raised from 12 because multi-pass planning issues a shared-contract request plus a todo and a coding request per target. The converter discloses its request count rather than gating on this value. |
| `maxRepairs` | integer | `2` | `0`-`2`. |
| `timeoutMs` | integer | `900000` | `1000`-`86400000`. Ceiling for **one** provider request, not for the run as a whole. A request that passes it is aborted and its target is skipped, so an endpoint that accepts a connection and then stalls can never hang the command. A run with many targets can still spend this budget once per target. |

## `direct`

Controls the default conversion engine.

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `reconcileIntegrations` | boolean | `true` | Bounded post-generation cross-file reconciliation: audit connected generated groups, repair each named target at most once, then verify once. A failed cycle rejects the evidenced group instead of writing a result we know is inconsistent. |
| `crossFileChecks` | boolean | `true` | Deterministic cross-file reference checking over generated HTML, CSS, and browser JavaScript. **Adds no model requests.** Findings show up in the receipt and the `--json` result marked `blocking` or `advisory`  -  that severity is a priority label, not a gate. A run is never refused because of a finding. |
| `planning` | object | see below | Merged field by field. |

### `direct.planning`

Multi-request generation. Without it, a single model completion has to decide a
file's design, cover every requirement, and invent a naming vocabulary all at
once  -  and nothing makes two independently generated files agree on any of it.

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | The one off switch. `false` restores exactly one model request per unit and skips every planning pass, whatever the siblings below say. |
| `adaptive` | boolean | `false` | When on, a single batched triage request decides which todo-eligible units are substantial enough to plan; the rest skip the per-unit todo call and are coded in one request. Units are batched (40 per request), so a handful of triage calls replaces a todo call for every request judged simple  -  the payoff grows with the number of files. A triage batch that can't be classified falls back to planning all of its units, so quality is never silently dropped. Needs `enabled` and at least one of `fileTodo`/`markerTodo`. |
| `projectBlueprint` | boolean | `true` | One shared request before any file is generated, settling the file roster and the vocabulary  -  class names, ids, exported symbols, routes  -  that every target has to use verbatim. Skipped automatically when fewer than two files are planned. |
| `fileTodo` | boolean | `true` | One todo-list request per whole-file `.human` target. |
| `markerTodo` | boolean | `false` | One todo-list request per inline `@human` marker. Keep this off for small marker replacements. |
| `maxCodingPassesPerUnit` | integer | `2` | `1`-`3`. A second pass happens **only** when the deterministic coverage check finds todo items the first pass didn't address, and it's kept only if it preserved everything the previous pass produced. Set it to `1` to code every target in a single request. |

**Request arithmetic.** For `N` units, `F` of which are whole files, the defaults
plan 1 blueprint request (when `F >= 2`), `N` todo requests, and `N` coding
requests, plus at most `N` conditional completion requests. The existing bounded
repair and reconciliation ceilings don't change. The receipt and the `--json`
plan both disclose the exact breakdown before the confirmation prompt.

With `adaptive` on, the `N` todo requests become `ceil(T / 40)` triage requests
(where `T` is the number of todo-eligible units) plus at most `T` todo requests
- only the units the triage flags are planned, so the receipt reports the todo
count as an upper bound (`up to T per-target todo`) and the `--json` plan adds a
`planClassification` count. The post-run summary reports the triage requests
actually spent as `planTriageRequests`.

**Failure behavior.** Every planning pass is best-effort. A blueprint that can't
be parsed is discarded and the run carries on without a shared contract. A todo
list that can't be parsed leaves that unit on the single-pass path. An adaptive
triage batch that can't be classified falls back to planning every unit in it,
and a total triage failure falls back to planning every eligible unit  -  the
pre-adaptive behavior. No planning failure ever fails a unit, and one unit
failing never affects another.

**Trust.** Blueprints and todo lists are model output, which makes them
untrusted evidence: paths get checked against the real planned targets, names
have to match a restricted character set, every free-text field is
length-bounded, and a blueprint containing credential-like content is thrown
away.

## `compiler`

Compiler mode treats unresolved natural-language decisions as compile
diagnostics and records successful outputs for deterministic replay. It is
opt-in: `compiler.enabled` defaults to `false`, so existing configurations keep
their previous requests, output, and overwrite policy.

| Key | Type | Default | Rules |
| --- | --- | --- | --- |
| `compiler.enabled` | boolean | `false` | Master switch. `--compiler` and `--no-compiler` override it for one command. |
| `compiler.onUnderspecified` | string | `"error"` | `error` exits 3 before generation; `warn` reports unresolved facets and continues. |
| `compiler.semanticDiagnostics` | boolean | `false` | Adds a bounded model-backed diagnostic batch for requests outside the static rule table. The layer can only add questions and fails open. |
| `compiler.lockfile` | boolean | `true` | Reads and atomically writes `human-to-code.lock.json`. Only targets already owned by this lock can be overwritten by a rebuild. |
| `compiler.replayFromLock` | boolean | `true` | A matching compile key reuses secret-scanned cached bytes with zero generation requests. Set `false` to compare provider or model behavior while still recording the result. |
| `compiler.vocabulary` | object | `{}` | At most 200 project terms. Keys and string values must be trimmed, non-empty, at most 128 characters, and contain no NUL. Credential-looking keys are rejected. Values are inert facet data, never instructions. |

The compile key binds the normalized instruction, target, language, unit kind,
resolved facets, prompt version, provider, model, selected package-owned skill
content, isolated compiler policy, and unit-local inline source context when
applicable. Generated bytes live under the platform cache root; the lockfile
contains only hashes, target paths, and compile identities and is intended to be
committed.

Enabling compiler mode selects an isolated source-to-source compilation path.
It does not send ProjectMemory or session history and does not run turn
classification, blueprints, todo/refinement planning, cross-file checks, or
integration reconciliation. It **does** attach the same selected package-owned
model skills used by ordinary coding requests. The corresponding `direct`
settings continue to control normal mode but cannot re-enable agent passes
inside compiler mode. FileMemory and bounded surrounding source remain available
where an inline marker needs local symbols and grammar context. Deterministic
validation runs before writes, with at most one bounded correction attempt for a
rejected candidate.

### Model reasoning and deterministic language checks

Every instruction that is not replayed from the compiler lock/cache is sent to
the configured model. There is no regex-based code-generation fast path, and
changing the wording or human language cannot silently skip model reasoning.
Byte-identical repeat runs come from lockfile/artifact replay; fixed compiler
sampling also reduces variation when fresh generation is required.

For a narrow family of explicit inline instructions, local language rules can
derive an expected fragment **after** the model responds. They are validation
only: a matching expectation can reject output that changes required names,
types, operands, or a literal call, but the expected fragment is never written
as generated code and never recovers a failed request.

The optional check applies when an inline marker's proven grammar position is a
parameter list, function body, or statement, in a language with a syntax profile
(TypeScript, JavaScript, Python, Rust, Go, Java, Ruby, C#, C++, C).

English wording is normalized before deriving an expectation, so connective
filler is irrelevant:
`that are`, `which are`, `named`, `called`, `consisting of`, `both`, and a
trailing `:` are all removed. These are equivalent:

```ts
function add(
  // @human add the parameters x and y with number types
  // @human add the parameters that are x and y with number types
  // @human add the parameters called x and y with number types
  // @human add two number parameters x and y
  // @human add x and y as number parameters
  // @human add the parameters x number, y number
) {
```

| Position | Recognized forms | Example validation expectation (TypeScript) |
| --- | --- | --- |
| parameter list | `parameters <names> with <scalar> types`, `<names> as <scalar> parameters`, per-name annotations `x number, y number` | `x: number, y: number` |
| function body | `add`/`subtract`/`multiply`/`divide` two names, `the sum`/`difference`/`product`/`quotient of` two names, spelled operators (`x plus y`, `x divided by y`), literal operators (`x + y`) | `return x + y;` |
| statement | `print`/`log`/`console log`/`display`/`output` of a call with literal arguments, either `calling f with 1, 2 arguments` or `f(1, 2)` | `console.log(add(1, 2));` |

Scalar words are `number`, `integer`, `float`, `double`, `string`, `text`,
`boolean`, `bool` (singular or plural) and map to each language's own type.

Instructions outside these English shapes—including Urdu, Arabic, Hindi,
Spanish, or any other language—still take the same model-generation path and
then pass the general syntax, marker, security, and project validation gates.
The narrow rule layer simply has no additional opinion. Ambiguous shapes such as
missing names/types, repeated names, contradictory connectives (`add x by y`),
or non-literal call arguments are likewise left to the model and general
validators. `test/compiler-rule-paraphrases.test.ts` pins both the opinionated
and silent cases so this validator cannot silently overreach.

`human-to-code migrate-config` upgrades the legacy unversioned configuration
and asks the same compiler-mode question as `--init`. In CI, use `--compiler`
or `--no-compiler` to choose without a prompt.

## `workspaces[]`

Per-workspace overrides for a multi-package repository. Merging is strictly
tightening: providers have to be identical across targeted workspaces or the run
stops, `documentation.mode` degrades to `offline` if any workspace asks for it,
path lists are unioned, every numeric privacy and budget field takes the
minimum, and consent booleans are ANDed together.

| Key | Type | Rules |
| --- | --- | --- |
| `root` | string | **Required.** A repository-relative path. `"."` is allowed. |
| `provider` | object | A complete `provider` object, validated by the same rules. Not a partial. |
| `documentation` | object | A partial `documentation` override. |
| `privacy` | object | A partial `privacy` override. |
| `budgets` | object | A partial `budgets` override. |

`sandbox` and `direct` are **not** overridable per workspace.

## The complete default file

This is exactly what non-interactive `human-to-code --init` writes. An
interactive init can set `compiler.enabled` to `true` after confirmation.

```json
{
  "schemaVersion": 1,
  "language": "typescript",
  "languages": ["typescript"],
  "humanFileExtensions": [],
  "filesToIgnore": ["node_modules", ".git", "dist"],
  "allowNonHumanFiles": false,
  "provider": {
    "name": "ollama",
    "model": "qwen2.5-coder:7b"
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
    "maxRequests": 60,
    "maxRepairs": 2,
    "timeoutMs": 900000
  },
  "direct": {
    "reconcileIntegrations": true,
    "crossFileChecks": true,
    "planning": {
      "enabled": true,
      "adaptive": false,
      "projectBlueprint": true,
      "fileTodo": true,
      "markerTodo": false,
      "maxCodingPassesPerUnit": 2
    }
  },
  "compiler": {
    "enabled": false,
    "onUnderspecified": "error",
    "semanticDiagnostics": false,
    "lockfile": true,
    "replayFromLock": true,
    "vocabulary": {}
  }
}
```
