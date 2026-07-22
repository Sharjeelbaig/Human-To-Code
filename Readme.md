<p align="center">
  <img src="assets/banner.svg" alt="human-to-code  -  write intent in plain language, compile it to real code" width="100%">
</p>

<p align="center">
  <a href="#release-status"><img alt="status: preview" src="https://img.shields.io/badge/status-preview-orange"></a>
  <img alt="node >= 24" src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="CONTRIBUTING.md"><img alt="contributions welcome" src="https://img.shields.io/badge/contributions-welcome-brightgreen"></a>
</p>

You know the loop: you're in your IDE, you jump over to ChatGPT, paste some
context, copy the answer back, fix the indentation. Again.

human-to-code removes that loop. Write a comment saying what you want  - 
`// @human add a function named health that returns { status: 200 }`  -  then run
`npx human-to-code .`. The comment becomes the code, right there in your file.

Building something from scratch? Don't start in `.ts` or `.py`. Make a
`file.human` instead, write what you want line by line in plain English, and it
compiles down to real TypeScript, Python, or C++. Pseudocode that actually runs.

And you keep your grip on the codebase. You're not handing the whole thing to an
agent and hoping it comes back with something you recognize.

## Quick start

The published package entry point is:

```bash
npx human-to-code .
```

That `.` isn't an instruction to rewrite your whole directory  -  it's just the
root to scan. By default you get the **direct converter**, which:

1. Loads your config and scans for `.human` files and inline `@human` markers.
   It doesn't import your application modules or execute your project config.
2. Tells you about marker-shaped requests sitting in file types it can't handle,
   and refuses a `.human` request whose output file already exists. Ignored
   directories and symlinks stay out of discovery entirely.
3. Prints a receipt  -  the output languages this worklist actually selected, the
   provider, the model, and every source-to-output path  -  then asks you to
   confirm. Nothing gets written until you say yes, or pass `-y`/`--yes`. Found
   no requests? You get `NEEDS_INPUT`.
4. Once you confirm, converts each item with one model completion per unit,
   pulls out one unambiguous code block, and validates the whole candidate
   before writing anything. JavaScript and TypeScript go through the TypeScript
   parser; other supported languages get a deterministic structural syntax
   check. HTML and CSS only get the non-empty and code-fence gates, because
   generic delimiter balancing reads valid markup and stylesheets as broken.
   For inline markers it diffs the candidate against the original file and
   rejects only syntax errors that *your* replacement introduced  -  it won't
   blame you for errors that were already there.
5. With `direct.reconcileIntegrations` on (the default), audits the groups of
   generated files that ProjectMemory found evidence for, across every
   supported language. A strict-JSON, read-only audit checks concrete
   imports/includes, modules/packages/namespaces, exports/signatures/calls,
   schemas/configuration, routes/templates/assets/selectors, and whatever else
   it has evidence for. Each reported issue gets exactly one target-scoped
   repair and one verification audit, and a connected group that's still broken
   afterward is rejected rather than written. Set it to `false` to skip this
   stage and its requests entirely.
6. Stages JavaScript/TypeScript output in an in-memory candidate overlay.
   TypeScript gets full combined semantic checking through the TypeScript
   Compiler API. JavaScript gets the same treatment only if the project turns on
   `checkJs` in `jsconfig.json`/`tsconfig.json` or the file has `// @ts-check`  - 
   ordinary JavaScript never gets rejected or rewritten over TypeScript-only
   inference complaints. Diagnostics are compared against the untouched
   baseline, and a dependency group you've opted into gets at most one bounded
   repair request per whole-file unit.
7. Writes defensively. Every successful whole-`.human` output goes out as one
   rollback-protected batch: if any whole-file candidate failed generation or
   validation, none of the batch is written; if exclusive creation fails halfway
   through, the files that batch created get removed. Inline markers keep their
   own per-marker isolation, exact stale-byte checks, and indentation.

You don't need a configured provider just to scan and preview. A default run
picks loopback-local Ollama with `qwen2.5-coder:7b`, so a fresh
`npx human-to-code .` never sends your code anywhere. You do need that model
already installed  -  the tool will never quietly pull it for you. Want a
different local model, or OpenAI, or Ollama Cloud? Make a config (the command
won't overwrite one you already have):

```bash
npx human-to-code --init .
# Edit human-to-code.config.json: pick OpenAI, local Ollama, or Ollama Cloud.
```

Remote OpenAI or Ollama Cloud generation needs a config file, because
`privacy.remoteProviderConsent` starts at `false` and there's deliberately no
CLI flag that can flip it.

Direct mode, converting an inline marker in place:

```bash
printf '// @human add a function named health that returns { status: 200 }\n' > health.ts
npx human-to-code . --yes --model qwen2.5-coder:7b
# health.ts now has the generated function where the marker used to be.
```

From a source checkout:

```bash
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js .
```

You'll need Node.js 24 or newer.

## Generation engine

The direct `npx human-to-code .` flow finds the work  -  whole `.human` files and
inline `@human` markers  -  prints a receipt, and once you confirm, converts
everything with the deterministic direct engine.

Inline discovery currently handles `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, `.cjs`, `.html`, `.htm`, `.css`, `.py`, `.rs`, `.go`, `.java`, `.rb`,
`.cs`, `.cpp`, `.cc`, `.c`, `.h`, and `.hpp`. If something that looks like an
`@human` request shows up in another regular file under 1 MiB, you'll get told
it's unsupported rather than silently skipped. Ignored and dot directories plus
symlinks stay out of the direct walk on purpose, and oversized unsupported files
don't get opened just to produce a notice.

The marker scanner is lexical and understands real `// @human` and `# @human`
line comments, single-line or multiline `/* @human ... */` blocks, decorated
JSDoc/block comments, and single-line or multiline HTML `<!-- @human ... -->`
comments. Inside HTML, the JavaScript and CSS comment forms work in `<script>`
and `<style>` too. Anything marker-shaped hiding in a quoted attribute, a
string, a template literal, ordinary prose in a doc comment, or nested inside
another comment stays inert. When it does replace a marker, it removes exactly
the comment range it recognized and leaves the surrounding text, newline style,
and indentation alone.

### Fast deterministic engine

The host stays in control; the model only writes code. For each unit the host
sends **one plain model completion**  -  no tool calls  -  and applies the result by
exact marker range. When TypeScript (or JavaScript you've opted into) project
validation turns up a repairable cross-file error, a whole-file unit can earn
**one extra bounded repair completion** using the same provider and model.
That's it. This is why it's quick and why small models work: a 1.5B coder model
converts a four-marker file in about 4 seconds. And since nothing here needs
tool-calling, models that can only generate plain text do just fine.

- **Per-marker isolation**  -  every `@human` marker is generated and applied on
  its own. If one marker's output is bad (say a small model redeclares a symbol
  that already exists), that marker gets retried, then skipped with a printed
  reason. The rest still convert. One failure never takes down the run.
- **FileMemory**  -  declarations already in the file are handed to the model as
  read-only context, so it reuses them instead of declaring them again. The
  static scanner knows about JavaScript regex literals, and the redeclaration
  guard covers type-led C, C++, C#, and Java forms.
- **ProjectMemory**  -  every request gets a compact view of the codebase built
  for that specific target. It keeps the current tree separate from the
  projected tree you'd have after all planned outputs succeed, holds the whole
  conversion plan while rendering only the bounded slice relevant to this
  target (with an explicit count of what it left out), gives exact relative
  references to likely companion files, and summarizes the relevant
  imports/includes, exports/declarations, modules/packages/namespaces,
  language-specific references and manifests, plus markup ids/classes/assets/
  inline handler calls, stylesheet selectors and custom properties, and DOM
  selectors where they matter. Ecosystem rules live in extensible profiles  - 
  neither ProjectMemory nor the optional reconciliation pass assumes you're
  building a web app. It's rebuilt from scratch every run instead of being
  persisted, so it can never become a stale cache. As candidates are accepted they
  update the shared in-memory contracts before later files get generated.
- **Selected model skills**  -  package-owned markdown under `src/skills` is
  attached only when its folder name matches the current language, target,
  marker grammar, task, or bounded project evidence. Core skills constrain local
  intent, insertion shape, visible symbols, and minimal changes; conditional
  skills cover types, flow, errors, lifecycles, APIs, databases, security, tests,
  configuration, documentation, and the exact target language. CSS foundations,
  professional light-first visual design, and selector contracts prevent React
  markup and stylesheets from drifting; an explicit palette or established theme
  takes precedence. Unrelated domain and language skills stay out of the request.
  See [the skill-folder guide](docs/SKILLS.md) to add a skill without editing a
  registry.
- **Candidate and write guards**  -  ambiguous fenced responses and malformed
  candidates get retried; existing sibling files, stale inline markers, and
  unsafe indentation changes get refused before anything is written. Whole
  `.human` outputs commit as a single rollback-protected batch, so one bad
  candidate or a late exclusive-create failure can't leave you with a partly
  generated codebase you didn't ask for.
- **Combined project validation (JS/TS)**  -  every accepted JavaScript/TypeScript
  unit is staged into an in-memory overlay. TypeScript gets type-checked
  together before a single write; JavaScript semantic checking only runs if the
  project or file opted into `checkJs`/`@ts-check`. Newly introduced cross-file
  diagnostics reject the whole dependency-connected group, after at most one
  bounded repair attempt per whole-file unit. Baseline errors that were already
  there are never pinned on generated code. This is static compilation  -  not
  sandbox execution, not runtime testing, not API grounding.
- **Cross-language reconciliation**  -  `direct.reconcileIntegrations` defaults to
  `true`. The host builds bounded relationship groups from ProjectMemory, asks
  for one strict read-only audit, repairs only the generated targets it named,
  and verifies once. Files that have nothing to do with each other don't get
  coupled just because they showed up in the same run. The receipt tells you the
  conservative audit and target-repair ceilings up front, and setting it to
  `false` skips the whole stage.
- **Clear, stable output**  -  one truncated status line per marker
  (`[yes] app.ts (inline @human, line 12)` or `[no] skipped ... : <reason>`), plus an
  in-place elapsed spinner while a request is running.

Here's what that looks like in practice. Say one run plans `index.html`,
`styles.css`, and `script.js`. The HTML request sees the other two as projected
siblings with the exact references `styles.css` and `script.js`. Once the HTML
is accepted, the CSS and JavaScript requests see its generated ids and classes
as a compact contract. If the target is nested, ProjectMemory works out the
right relative reference  -  `../styles.css`  -  instead of assuming everything
lives at the root. The same machinery describes Python modules, Rust crate
modules, Go packages, Java/C# namespaces and types, C/C++ headers, Ruby loaders,
and same-language companions. Those conventions are just profile data; the
grouping, audit, repair, and verification control flow is shared across all of
them.

One thing to keep in mind: ProjectMemory is *evidence* for generation, not
proof of correctness. Its prompt contract tells the model to connect genuine
companions without importing every file it can see. JS/TS relationships still go
through combined compiler validation. Cross-file relationships are never
runtime-tested by the direct engine. The optional
`direct.reconcileIntegrations` pass audits compact contracts across supported
languages and verifies any target-scoped repair once  -  but it is not a compiler,
runtime, or sandbox proof for Python, Rust, web projects, or anything else.

```bash
# Deterministic engine  -  works with small models:
npx human-to-code . --yes --model qwen2.5-coder:1.5b
```

## CLI

| Command | Behavior |
| --- | --- |
| `human-to-code [root]` | The default direct flow: find `.human` files and `@human` markers, show a receipt, and on confirmation convert them with the **fast deterministic engine** (one plain model completion per marker, plus at most one bounded cross-file repair completion per whole-file JS/TS unit  -  see above). `npx human-to-code .` is the normal way in. |
| `human-to-code --init [root]` | Create a schema-v1 config without overwriting an existing one. Review the generated provider before you use it. |

Options you'll actually use: `--provider`, `--model`,
`--base-url`, `--api-key-env`, `--input-cost-per-million`,
`--output-cost-per-million`, `--unmetered-provider`, `--trust-custom-endpoint`,
`--dry-run`, `--json`, and `--yes`.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | The command finished successfully. |
| `1` | Usage or configuration error. |
| `3` | `NEEDS_INPUT` or `UNSUPPORTED`. |
| `4` | `SECURITY_BLOCKED`. |
| `5` | Provider dependency failure. |
| `6` | Internal error or partial scan. |

## Configuration

Config is strict, schema-versioned JSON. Unknown keys and credential-looking
values get rejected. Credentials live in the environment and nowhere else  - 
`apiKeyEnv` holds the environment variable's **name**, never the key itself.

`--init` writes the complete frozen loopback-Ollama default and refuses to
overwrite a file that's already there. Treat what it gives you as a template to
review: confirm the model is actually installed or switch to OpenAI/Ollama
Cloud, only set remote consent after reviewing what can leave the host, and keep
credential values in the named environment variable.

For OpenAI or Ollama Cloud, leave `remoteProviderConsent` false until you have
reviewed the privacy settings and configured conservative model-specific pricing
bounds. Then set consent to true.

**[docs/CONFIGURATION.md](docs/CONFIGURATION.md) is the full field-by-field
reference**  -  every key, its type, default, valid range, and validation rule,
plus the exact file `--init` writes. What follows here is just the decisions
worth understanding before you start editing.

This local-Ollama example shows the policy fields most projects end up touching:

```json
{
  "schemaVersion": 1,
  "languages": ["typescript", "html", "css", "javascript"],
  "humanFileExtensions": [
    { "path": "index.human", "extension": "html" },
    { "path": "script.human", "extension": "js" },
    { "path": "styles.human", "extension": "css" }
  ],
  "provider": {
    "name": "ollama",
    "model": "qwen2.5-coder:14b"
  },
  "privacy": {
    "remoteProviderConsent": false,
    "maxFileBytes": 512000,
    "maxContextTokens": 64000
  },
  "direct": {
    "reconcileIntegrations": true,
    "crossFileChecks": true,
    "planning": {
      "enabled": true,
      "maxCodingPassesPerUnit": 2
    }
  }
}
```

Anything you leave out keeps its documented default. `documentation`, `privacy`,
`sandbox`, `budgets`, `direct`, and `direct.planning` merge field by field, so
writing a partial section doesn't wipe out its siblings.

`languages` is every output language enabled for direct conversion
(`typescript`, `javascript`, `python`, `rust`, `html`, `css`), and the first
entry is the default. The receipt only lists the languages the discovered units
actually selected, not everything you configured.

`humanFileExtensions` is the strongest routing signal you have. Each entry binds
one exact, portable, project-relative `.human` path to an output extension. The
leading dot is optional, and the extension's language has to be in `languages`.
This is what stops the wording of a prompt from changing your output: in the example
above, `script.human` always becomes `script.js`, even if its instruction talks
about stylesheets, CSS classes, colors, and themes on every line. When there's
an explicit mapping, it replaces a recognized inner extension too  -  so mapping
`page.html.human` to `js` gives you `page.js`.

### Multi-request planning

Ask one request to handle a whole file and it has to decide the file's design,
cover every requirement in the spec, and invent a naming vocabulary all at the
same time. Worse, nothing makes two independently generated files agree on that
vocabulary. `direct.planning` (on by default) splits the job up:

1. **Shared contract**  -  one request before any file is generated, settling the
   file roster and the exact class names, ids, symbols, and routes every target
   has to use verbatim. Skipped when fewer than two files are planned.
2. **Per-target todo list**  -  one request per `.human` file and, unless
   `markerTodo` is off, one per inline `@human` marker.
3. **Coding**  -  one request per target, grounded in both of the above. A second
   pass only happens when a deterministic coverage check finds todo items the
   first pass missed, and it's only kept if it preserved everything the previous
   pass produced. That ratchet is what makes re-emitting a whole file safe: a
   pass that drops content loses itself, not your output.

Set `direct.planning.enabled` to `false` to go back to exactly one model request
per unit, or set `maxCodingPassesPerUnit` to `1` to keep planning but never
refine. Every planning pass is best-effort  -  an unparseable blueprint or todo
list gets thrown away and the run continues on the single-pass path. The receipt
and the `--json` plan both show you the exact request breakdown before the
confirmation prompt.

`direct.crossFileChecks` (on by default) then cross-references the generated
HTML, CSS, and browser JavaScript against each other using the same static
extractors ProjectMemory already relies on  -  **no model requests involved**. A
script that uses a class no markup defines, or markup linking an asset the
project doesn't have, is reported as blocking. Naming drift between markup and
stylesheet is reported as advisory. This is reference checking, not
verification: a clean result means the names line up, never that the project
works.

`direct.reconcileIntegrations` (on by default) is the bounded post-generation
reconciliation pass. ProjectMemory supplies the structured relationships using
extensible language profiles; the generic orchestrator audits only connected
generated groups, validates strict JSON against real generated paths, repairs
each named target at most once, and does at most one verification audit. If that
bounded cycle fails, the evidenced group is rejected rather than written out in
a state we know is inconsistent. Set it to `false` to skip those requests.

The direct engine treats `privacy.maxContextTokens` as the combined ceiling for
FileMemory and ProjectMemory together. On top of that, ProjectMemory caps each
rendered block at 24,000 characters, reads at most 240 high-priority files for
compact contracts, and shows at most 72 paths per current/projected tree
section, 48 planned targets, 16 relationships, and 8 compact contracts per
request. It leaves out protected paths, `filesToIgnore`,
`privacy.excludedPaths`, oversized files, unreadable files, and any contract
with credential-like content in it. Other-file prompts and source-derived
contracts are explicitly framed as untrusted evidence. With a remote provider,
this compact direct context only goes out after you've enabled
`privacy.remoteProviderConsent`; local Ollama keeps it on the configured
loopback endpoint.

A `.human` file can also declare its own output extension or configured language
name on its first nonblank line. That line is stripped before the rest of the
instruction reaches the model:

```text
html
add head section here
add styles
close head
add body
```

That `index.human` writes `index.html`. Extension tokens like `js`, `.js`,
`mjs`, `ts`, `tsx`, `py`, and `rs` all work as long as their language is
enabled. Canonical configured names  -  `javascript`, `typescript`, `python`,
`rust`, `ruby`, `csharp`, `cpp`  -  work too and map to their usual output
extensions. A first line of `javascript` gives you `.js`, not `.javascript`. A
config mapping beats a first-line declaration, but if the two genuinely
conflict, you get told and the file is skipped rather than guessed at.

With no explicit route at all, a configured inner extension wins:
`index.html.human` writes `index.html`, `styles.css.human` writes `styles.css`.
For a bare name, discovery checks an explicit language named in the request,
then an unambiguous filename convention, then request vocabulary, and finally
falls back to your first configured language. All of this is decided before the
confirmation prompt, with no extra model call. The singular `language` key
sticks around for alpha compatibility  -  supply it alongside `languages` and it
has to be a member, and gets normalized to the first/default entry.
`filesToIgnore` takes exact file and directory names, not globs. With
`sandbox.engine: "auto"`, validation probes Docker first and then Podman;
`"docker"` and `"podman"` pick one explicitly. If neither runtime is around,
validation is `INCONCLUSIVE` and no project command runs.

### Budget semantics

Request count, input and output tokens, repair count, and elapsed time are all
cumulative hard gates. Before anything hits the network, the host pessimistically
charges a tokenizer-independent input upper bound plus the entire requested
output allowance, and a repair request persists that checkpoint before it's
sent. Usage the provider actually reports reconciles the reservation afterward,
while a failed or interrupted request just keeps the conservative charge.
Context ranking still uses an estimate and is a separate limit.

Remote OpenAI and Ollama Cloud/custom generation is blocked before the first
provider request unless both `provider.pricing.inputUsdPerMillionTokens` and
`outputUsdPerMillionTokens` are configured. The bundled adapters use those
operator-reviewed, model-specific upper rates to reserve conservative worst-case
spend before sending, and to account for the token usage the provider reports
back. A request whose reservation would go over cumulative `maxCostUsd` never
gets sent. Loopback-local Ollama has zero remote API cost and doesn't need
`pricing` at all.

Those rates are policy inputs. They are not a live price feed and not a provider
invoice. Set them at or above every applicable input/output rate for that exact
model and endpoint, revisit them whenever pricing moves, and never use zero for
a service that bills you. Both rates can be zero only alongside an explicit
`"unmetered": true` assertion (or `--unmetered-provider` together with both
zero-rate CLI flags)  -  and that assertion is accepted as your policy, not
independently verified. Provider-reported usage can be wrong too. Keep your
provider-side account and project spend limits switched on; `maxCostUsd` is a
local fail-closed guard, not billing reconciliation. If a conservative
reservation exceeds your budget, lower the reviewed token allowance or raise
`maxCostUsd`  -  don't set the pricing too low just to force a request through.

### Model identity and reproducibility

The CLI sends exactly the model string you configured, never quietly falls back,
and records the model the provider reported plus the request IDs. Repairs have
to come back with the same reported model identity as generation did. That's
audit provenance, not proof of model weights: aliases and Ollama tags like
`gpt-4o` or `qwen2.5-coder:7b` can change without warning, and Ollama's chat
response doesn't give you a model-blob digest here. Use an immutable provider
version/digest if the provider offers one. The loopback default is privacy-safe,
but it is not a reproducible weight pin.

### OpenAI

The OpenAI adapter uses the Responses API with strict JSON-schema output and the
exact model ID you configured. The default credential variable is
`OPENAI_API_KEY`. Since OpenAI is remote, compiler context tools are turned off:
the provider gets only the complete manifest you previewed before consenting,
and can't come back asking for another file.

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

That fragment shows the relevant fields only  -  keep `schemaVersion` and the rest
of your top-level policy from the full config. The numbers are deliberately
conservative examples, not a current price quote; swap in reviewed upper bounds
for your exact provider and model. And never put the key itself in JSON:

```bash
export OPENAI_API_KEY='...'
```

### Ollama local

When `provider.name` is `ollama` and you've left `baseUrl` out, the adapter uses
`http://localhost:11434/api`. Local Ollama is the only provider allowed to speak
plain HTTP, and only to a verified loopback destination. It must not be given an
`apiKeyEnv`.

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

Local Ollama receives the patch schema through its native `format` field. The
output still gets parsed and schema-validated locally. Because the endpoint is
verified loopback-local, it's allowed to use the bounded compiler context tool
for up to eight extra evidence requests, and every one of them shows up in the
final manifest.

### Ollama Cloud

For official Ollama Cloud, give it the HTTPS base URL and an environment
variable name. `OLLAMA_API_KEY` is the default for the official endpoint, but
spelling it out makes the credential binding reviewable.

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
export OLLAMA_API_KEY='...'
```

Replace the example pricing with reviewed upper bounds for whichever Cloud model
you picked. Ollama Cloud doesn't currently expose Ollama's native
structured-output mode, so the adapter sends the JSON schema as a host-enforced
instruction, parses exactly one JSON value, and puts it through the same local
schema gate. Malformed or out-of-schema output is terminal  -  it never gets
accepted as a patch. And as a remote provider, Ollama Cloud gets no context tool
definitions and can't expand the manifest you reviewed.

### Custom Ollama-compatible cloud endpoint

A custom remote endpoint has to be an explicitly trusted public HTTPS URL, and
it has to name its own credential environment variable:

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

Credentials and reviewed pricing bounds are tied to the endpoint you selected  - 
they're never inherited from another provider. Swap the example rates for
conservative bounds for that specific service. URLs carrying userinfo, query
strings, or fragments are blocked, as are unsafe redirects, private-network
destinations, and DNS rebinding. Production HTTP(S) connections go to the vetted
resolved address while keeping the reviewed hostname for TLS, so DNS validation
isn't just a preflight followed by an unpinned lookup later. The adapter never
silently switches provider or model. Custom remote Ollama-compatible endpoints
follow the same complete-preview, no-dynamic-context rule as official Ollama
Cloud.

The config schema still recognizes the alpha provider names for migration
compatibility, but this preview only has HTTP adapters for `openai` and
`ollama`. Selecting Anthropic, Grok, or Gemini stops with a configuration error.

## Codebase documentation

Pick whichever one matches your question:

| I want to understand... | Read |
| --- | --- |
| What a project term means | [Architecture glossary](docs/GLOSSARY.md) |
| How the product works and where a source change belongs | [Codebase tour](docs/Codebase_Tour.md) |
| Why the source is split into these layers | [Architecture](docs/ARCHITECTURE.md) |
| What each source file owns | [Module guide](docs/MODULES.md) |
| How functions, variables, and lifecycle comments should be named | [Source clarity and naming practices](docs/CODE_CLARITY.md) |
| Every configuration field and default | [Configuration reference](docs/CONFIGURATION.md) |
| How to add ecosystems, providers, or schema versions safely | [Scalability and engineering practices](docs/SCALABILITY.md) |
| How package-owned model skills are selected and extended | [Model skill folders](docs/SKILLS.md) |
| Security boundaries, secrets, sandboxing, apply, and rollback | [Security model](SECURITY.md) |
| How to prepare and review a contribution | [Contributor guide](CONTRIBUTING.md) |

## Development checks

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

`package:check` builds a tarball, installs it into a clean temporary project,
imports the public entry point, and invokes the installed CLI.

## License

[MIT](LICENSE) (c) the human-to-code authors
