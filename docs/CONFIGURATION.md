# `human-to-code.config.json` reference

Every field in the schema-v1 config file, one by one. If you'd rather read the
narrative setup guidance first, that's in the
[Configuration section of the Readme](../Readme.md#configuration).

## How the file gets read

- It has to be named exactly `human-to-code.config.json` and sit at the project
  root. Not having one isn't an error  -  the frozen defaults below kick in and
  every command still works.
- `human-to-code --init` writes the complete default file, and refuses to
  overwrite one you already have.
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
- `documentation`, `privacy`, `sandbox`, `budgets`, and `direct` merge field by
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
| `timeoutMs` | integer | `900000` | `1000`-`86400000`. |

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
| `projectBlueprint` | boolean | `true` | One shared request before any file is generated, settling the file roster and the vocabulary  -  class names, ids, exported symbols, routes  -  that every target has to use verbatim. Skipped automatically when fewer than two files are planned. |
| `fileTodo` | boolean | `true` | One todo-list request per whole-file `.human` target. |
| `markerTodo` | boolean | `false` | One todo-list request per inline `@human` marker. Keep this off for small marker replacements. |
| `maxCodingPassesPerUnit` | integer | `2` | `1`-`3`. A second pass happens **only** when the deterministic coverage check finds todo items the first pass didn't address, and it's kept only if it preserved everything the previous pass produced. Set it to `1` to code every target in a single request. |

**Request arithmetic.** For `N` units, `F` of which are whole files, the defaults
plan 1 blueprint request (when `F >= 2`), `N` todo requests, and `N` coding
requests, plus at most `N` conditional completion requests. The existing bounded
repair and reconciliation ceilings don't change. The receipt and the `--json`
plan both disclose the exact breakdown before the confirmation prompt.

**Failure behavior.** Every planning pass is best-effort. A blueprint that can't
be parsed is discarded and the run carries on without a shared contract. A todo
list that can't be parsed leaves that unit on the single-pass path. No planning
failure ever fails a unit, and one unit failing never affects another.

**Trust.** Blueprints and todo lists are model output, which makes them
untrusted evidence: paths get checked against the real planned targets, names
have to match a restricted character set, every free-text field is
length-bounded, and a blueprint containing credential-like content is thrown
away.

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
      "markerTodo": false,
      "maxCodingPassesPerUnit": 2
    }
  }
}
```
