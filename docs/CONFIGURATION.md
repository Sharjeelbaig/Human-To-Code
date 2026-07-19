# `human-to-code.config.json` reference

Complete field-by-field reference for the schema-v1 configuration file. For
narrative setup guidance see the [Configuration section of the
Readme](../Readme.md#configuration).

## How the file is read

- The file must be named exactly `human-to-code.config.json` and live at the
  project root. A missing file is not an error: the frozen defaults below are
  used and every command still runs.
- `human-to-code --init` writes the complete default file and refuses to
  overwrite an existing one.
- Loading is hardened: symlinks and non-regular files are rejected, the file is
  opened with `O_NOFOLLOW`, size and inode are re-checked after opening to
  detect a swap during the read, and the file may not exceed **1 MiB**.
- **Unknown keys are rejected at every level.** A typo is a hard error naming
  the exact dotted path, not a silently ignored setting.
- **Credential-like keys are rejected before anything else.** Any key that
  normalizes to `key`, `secret`, or `token`, or that ends in `secret`,
  `apikey`, `accesstoken`, `authtoken`, `bearertoken`, `clientsecret`,
  `password`, `passphrase`, `credential`, `credentials`, `privatekey`, or
  `authorization` is refused anywhere in the file. The single exception is
  `apiKeyEnv`, which holds an environment-variable *name*, never a value.
- Validation fails fast: the first problem throws with a message safe to show a
  user, quoting the dotted path (for example `` `direct.planning.enabled` ``).
- `documentation`, `privacy`, `sandbox`, `budgets`, and `direct` merge
  field-by-field onto the defaults, so a partial section keeps the rest of its
  defaults. `direct.planning` also merges field-by-field. Every other key,
  including the whole `provider` object and all arrays, is replaced wholesale.

## Root keys

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | — | **Required.** Anything other than `1` is rejected; a missing value points you at `human-to-code migrate-config`. |
| `language` | string | `"typescript"` | One of `typescript`, `javascript`, `python`, `rust`, `html`, `css`. Retained for alpha compatibility. When set together with `languages` it must be a member, and is normalized to the first entry. |
| `languages` | string[] | `["typescript"]` | Non-empty, no duplicates, each from the same six. The first entry is the default output language. |
| `humanFileExtensions` | object[] | `[]` | At most 1000 entries, no duplicate paths (case-insensitive). The strongest routing signal — see below. |
| `filesToIgnore` | string[] | `["node_modules", ".git", "dist"]` | Bare file or directory **names**, not paths or globs. No `/`, `\`, `.` or `..`; at most 255 characters each; no duplicates. |
| `allowNonHumanFiles` | boolean | `false` | Accepted and validated, but **no code currently reads it**. It has no effect on any run. |
| `provider` | object | see below | Replaced wholesale, never merged. |
| `workspaces` | object[] | `[]` | Per-workspace overrides; no duplicate roots (case-insensitive). |
| `documentation` | object | see below | Merged field-by-field. |
| `privacy` | object | see below | Merged field-by-field. |
| `sandbox` | object | see below | Merged field-by-field. |
| `budgets` | object | see below | Merged field-by-field. |
| `direct` | object | see below | Merged field-by-field. |

### `humanFileExtensions[]`

Binds one exact `.human` source path to an output extension, so prompt wording
can never change where a file lands.

| Key | Type | Constraints |
| --- | --- | --- |
| `path` | string | Portable repository-relative path, at most 1024 characters. Must end in `.human` and must **not** end in `.strict.human`. No absolute paths, drive letters, backslashes, or `.`/`..` segments. |
| `extension` | string | A leading dot is optional and the value is lowercased. Must be one of `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `py`, `rs`, `html`, `htm`, `css`, and its language must appear in `languages`. |

## `provider`

Replaced wholesale: supplying `{"name": "openai"}` yields exactly
`{name: "openai", model: "gpt-4o"}` — sibling defaults are not preserved.

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `provider.name` | string | `"ollama"` | One of `openai`, `anthropic`, `ollama`, `grok`, `gemini`. Only `openai` and `ollama` have working adapters; the others are accepted by the schema and then stop the run with a configuration error. |
| `provider.model` | string | per provider | Non-empty, trimmed, at most 256 characters. Defaults: `ollama` → `qwen2.5-coder:7b`, `openai` → `gpt-4o`, `anthropic` → `claude-opus-4-8`, `grok` → `grok-4.1`, `gemini` → `gemini-2.5-pro`. The configured string is sent exactly and never silently substituted. |
| `provider.baseUrl` | string | absent | Explicit lowercase scheme; no userinfo, query, or fragment. Plain HTTP only for a trusted loopback Ollama endpoint; loopback only for `ollama`. Private, link-local, CGNAT, and multicast literals are refused, as are `.localhost`, `.local`, and `.internal`; a fully qualified domain name is required. |
| `provider.trustCustomEndpoint` | `true` | absent | May only be `true`, and only alongside `baseUrl`. Set automatically when `baseUrl` is present. |
| `provider.apiKeyEnv` | string | absent | An environment-variable **name** matching `/^[A-Z_][A-Z0-9_]{0,127}$/` — never a credential. Forbidden on a plain-HTTP endpoint. Set to `OLLAMA_API_KEY` automatically for `https://ollama.com`. |
| `provider.pricing` | object | absent | **Required before any remote request.** See below. |

### `provider.pricing`

Operator-reviewed worst-case rates used to reserve spend before a remote
request is sent. They are a local policy input, not a live price feed.

| Key | Type | Constraints |
| --- | --- | --- |
| `inputUsdPerMillionTokens` | number | `0`–`1000000`; fractional values allowed. |
| `outputUsdPerMillionTokens` | number | `0`–`1000000`; fractional values allowed. |
| `unmetered` | `true` | Required **exactly when** both rates are zero, and rejected otherwise. It is accepted as operator policy and is not independently verified. |

Loopback-local Ollama has no remote API cost and needs no `pricing`.

## `documentation`

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `mode` | string | `"local-first"` | `local-first` or `offline`. |
| `privatePaths` | string[] | `[]` | Portable repository-relative paths holding project or private documentation. No duplicates. |
| `officialDomains` | string[] | `[]` | Lowercase public domains, at most 253 characters. No scheme, port, path, wildcard, or leading/trailing dot; must contain a dot; must not be an IP address. |
| `officialSources` | object[] | `[]` | At most 100 entries; no duplicate `ecosystem`/`dependency`/`version` triples. |

### `documentation.officialSources[]`

| Key | Type | Constraints |
| --- | --- | --- |
| `ecosystem` | string | One of `react`, `nestjs`, `fastapi`, `rust`. |
| `dependency` | string | At most 256 characters, matching `/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i`. |
| `version` | string | At most 128 characters and an exact identifier. Moving targets (`latest`, `next`, `stable`, `nightly`, `main`, `master`, `head`, `dev`) and range operators (`<`, `>`, `=`, `^`, `~`, `*`) are refused. |
| `url` | string | HTTPS only, at most 2048 characters, no credentials, port, or fragment, valid percent-encoding. The path or query **must visibly contain the exact `version` string**, so a pinned entry cannot silently resolve elsewhere. |

## `privacy`

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `remoteProviderConsent` | boolean | `false` | Remote providers stay disabled until this is explicitly `true`. Direct conversion refuses to send anything to a non-loopback provider without it. |
| `telemetry` | boolean | `false` | Opt-in. Also forced off by the `DO_NOT_TRACK` environment variable. No telemetry is currently emitted either way. |
| `excludedPaths` | string[] | `[]` | Portable repository-relative files or directories that must never enter outbound context. No duplicates. |
| `maxFileBytes` | integer | `512000` | `1024`–`100000000`. Files above this are not read for context or contracts. |
| `maxContextTokens` | integer | `64000` | `1000`–`2000000`. The direct engine uses this times four as the combined FileMemory + ProjectMemory character budget for one request. |

## `sandbox`

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `required` | boolean | `true` | **Must be `true`** in schema v1; `false` is a hard error. |
| `engine` | string | `"auto"` | `auto`, `docker`, or `podman`. `auto` probes Docker first, then Podman; neither available makes validation `INCONCLUSIVE` and runs no project command. |
| `network` | string | `"none"` | Must be `"none"` in schema v1. |

## `budgets`

Cumulative hard ceilings for one run. Preflight accounting charges a
pessimistic, tokenizer-independent upper bound before a request is sent, and a
failed remote attempt keeps its conservative charge.

| Key | Type | Default | Range |
| --- | --- | --- | --- |
| `maxCostUsd` | number | `10` | `0`–`100000`; fractional allowed. |
| `maxInputTokens` | integer | `2000000` | `1000`–`10000000`. |
| `maxOutputTokens` | integer | `120000` | `1`–`1000000`. |
| `maxRequests` | integer | `60` | `1`–`100`. Raised from 12 because multi-pass planning issues a shared-contract request plus a todo and coding request per target. **Enforced in the guided pipeline and the provider ledger; the direct engine discloses its request count rather than gating on this value.** |
| `maxRepairs` | integer | `2` | `0`–`2`. |
| `timeoutMs` | integer | `900000` | `1000`–`86400000`. |

## `direct`

Controls the default conversion engine.

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `reconcileIntegrations` | boolean | `true` | Bounded post-generation cross-file reconciliation: audit connected generated groups, repair each named target at most once, then verify once. A failed cycle rejects the evidenced group rather than writing a known-inconsistent result. |
| `crossFileChecks` | boolean | `true` | Deterministic cross-file reference checking over generated HTML, CSS, and browser JavaScript. **Adds no model requests.** Findings are reported in the receipt and the `--json` result and marked `blocking` or `advisory`; the severity is a priority label, not a gate — a run is not refused because of a finding. |
| `planning` | object | see below | Merged field-by-field. |

### `direct.planning`

Multi-request generation. Without it, one model completion has to decide a
file's design, cover every requirement, and invent a naming vocabulary at once —
and nothing makes two independently generated files agree.

| Key | Type | Default | Constraints |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | The single off switch. `false` restores exactly one model request per unit and skips every planning pass regardless of the sibling values below. |
| `projectBlueprint` | boolean | `true` | One shared request before any file is generated, agreeing the file roster and the vocabulary — class names, ids, exported symbols, routes — that every target must use verbatim. Skipped automatically when fewer than two files are planned. |
| `fileTodo` | boolean | `true` | One todo-list request per whole-file `.human` target. |
| `markerTodo` | boolean | `true` | One todo-list request per inline `@human` marker. |
| `maxCodingPassesPerUnit` | integer | `2` | `1`–`3`. A second pass is issued **only** when the deterministic coverage check finds todo items the first pass did not address, and is kept only if it preserves everything the previous pass produced. Set to `1` to code every target in a single request. |

**Request arithmetic.** For `N` units of which `F` are whole files, the defaults
plan `1` blueprint request (when `F >= 2`), `N` todo requests, and `N` coding
requests, plus at most `N` conditional completion requests. Existing bounded
repair and reconciliation ceilings are unchanged. The receipt and the `--json`
plan disclose the exact breakdown before the confirmation prompt.

**Failure behavior.** Every planning pass is best-effort. A blueprint that
cannot be parsed is discarded and the run continues without a shared contract; a
todo list that cannot be parsed leaves that unit on the single-pass path. No
planning failure ever fails a unit, and one unit failing never affects another.

**Trust.** Blueprints and todo lists are model output, so they are untrusted
evidence: paths are checked against the real planned targets, names must match a
restricted character set, every free-text field is length-bounded, and a
blueprint containing credential-like content is discarded.

## `workspaces[]`

Per-workspace overrides for a multi-package repository. Merging is strictly
tightening: providers must be identical across targeted workspaces or the run
stops, `documentation.mode` degrades to `offline` if any workspace asks for it,
path lists are unioned, every numeric privacy and budget field takes the
minimum, and consent booleans are ANDed.

| Key | Type | Constraints |
| --- | --- | --- |
| `root` | string | **Required.** Repository-relative path; `"."` is allowed. |
| `provider` | object | A complete `provider` object, validated by the same rules — not a partial. |
| `documentation` | object | Partial `documentation` override. |
| `privacy` | object | Partial `privacy` override. |
| `budgets` | object | Partial `budgets` override. |

`sandbox` and `direct` are **not** overridable per workspace.

## Complete default file

This is exactly what `human-to-code --init` writes.

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
      "projectBlueprint": true,
      "fileTodo": true,
      "markerTodo": true,
      "maxCodingPassesPerUnit": 2
    }
  }
}
```
