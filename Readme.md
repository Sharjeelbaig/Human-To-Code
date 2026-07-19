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

There are two ways to run it:

- **Direct mode**  -  the default, `npx human-to-code .`. It finds your requests,
  shows you exactly what it's about to do, and writes the code once you confirm.
  Fast, and it works fine with small local models. It writes straight to your
  working tree, with no change contract and no sandbox behind it.
- **Guided mode**  -  `human-to-code guided`. The careful path. It reads your
  project first, writes down what it's allowed to touch, limits what the model
  can see and ask for, checks the result in an isolated sandbox, and won't write
  anything to disk until you say so.

Guided mode goes like this:

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

To be clear about what this isn't: it's not a deterministic source-to-source
compiler. The LLM does write the actual framework-specific edits. What it
doesn't get to do is pick its own scope, validation commands, credentials,
documentation sources, or pass/fail criteria  -  those come from you. The
`.strict.human.json` contract, the `VERIFIED` status, and the `apply`/`rollback`
machinery all live in guided mode. Direct mode doesn't use any of them.

## Release status

> [!WARNING]
> `0.1.x` is a **preview** of the production architecture. It is not a certified
> production release.

The React, NestJS, FastAPI, and Rust profiles that ship today are all marked
`preview` (CRA is `legacy`), and the CLI doesn't enable a single certification
benchmark entry for any provider or model. So a generated run in this release
can't honestly call itself `VERIFIED`  -  even a clean sandbox validation comes
back `INCONCLUSIVE`, which means `apply` (and therefore `rollback`) stays
unavailable in a normal preview run. That's on purpose. It fails closed.

When nothing recognizable turns up, guided mode falls back to an ungrounded
**`general`** preview workspace, taking its language from `language` in
`human-to-code.config.json` (default `typescript`). The point of general
generation is that a bare `.human` request against an unfamiliar project still
gives you something you can review instead of a hard `UNSUPPORTED` stop. But it
is the lowest-trust path here: there's no dependency evidence to ground
against, so API grounding is skipped, no toolchain is assumed, and every general
run is pinned to `INCONCLUSIVE`  -  never `VERIFIED`, never auto-applied. Plain
`analyze` stays pure recognition and won't emit the general fallback at all.
Point it at a recognized project if you want grounded, sandbox-validated output.

When the docs say "works in any project," what that means is: analysis succeeds
inside a capability we've written down, and refuses anything ambiguous or
unsupported. It does not mean a confident model can turn an unknown framework,
version, environment, or toolchain into a supported one.

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

Direct mode writes code straight into your working tree. Its static compiler
validation for TypeScript (and JavaScript you've explicitly type-checked) is a
real step up from syntax parsing  -  but it's still static analysis. It does
**not** execute or import your code, run your builds or tests, prove runtime
behavior or external-API grounding, run anything in a sandbox, create a
`.strict.human.json` contract, produce a `VERIFIED` run, or do guided mode's
repository-wide secret scan. Outbound FileMemory and the optional
integration-reconciliation bundles do get credential-scanned, and ProjectMemory
leaves credential-bearing contracts out  -  but those are narrow gates, not a
repository-wide proof. For the full contract -> grounding -> sandbox lifecycle,
where `.strict.human.json` and the `VERIFIED`/`apply`/`rollback` machinery
actually live, use `human-to-code guided` (see
[The reviewed change contract](#the-reviewed-change-contract) and the
[CLI](#cli) table).

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

Guided mode, where nothing is written until the run is VERIFIED:

```bash
cat > add-health-route.human <<'EOF'
Add a health endpoint using the existing routing, response, authentication,
logging, and test conventions. It must not expose secrets or tenant data.
EOF

npx human-to-code guided . --provider ollama --model qwen2.5-coder:14b
# Review add-health-route.strict.human.json, resolve REVIEW-1, then run it again.
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

This engine can't produce `VERIFIED` runs. For the reviewed, sandbox-validated
pipeline, use `human-to-code guided`.

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
runtime, or sandbox proof for Python, Rust, web projects, or anything else. If
integration genuinely has to be sandbox-verified, use guided mode.

```bash
# Deterministic engine  -  works with small models:
npx human-to-code . --yes --model qwen2.5-coder:1.5b
```

## The reviewed change contract

`foo.strict.human.json` is a `ChangeContractV1`. It's not a prompt, and it's not
an executable language. It ties the request to the SHA-256 of `foo.human` and to
the current project-profile fingerprint. It also records:

- Target workspaces and symbols.
- Requirements, plus automated and manual acceptance criteria.
- Allowed paths and which create/edit/rename/delete operations are permitted.
- Prohibited paths and prohibited changes.
- Assessed risks, explicitly authorized elevated risks, and open questions.

Generation stops if the source or project profile changed, if a material
question is still unanswered, or if the contract doesn't explicitly authorize
whatever the change needs  -  adding a dependency, touching a lockfile, running a
migration, breaking a public API, changing authentication or validation, writing
unsafe Rust, or doing FFI work.

The draft you get is deliberately conservative. Don't delete its review question
until the contract genuinely describes the change you want. Committing both the
`.human` source and the reviewed contract is what makes the decision boundary
auditable later; the generated run artifacts stay in the private run store.

## CLI

| Command | Behavior |
| --- | --- |
| `human-to-code [root]` | The default direct flow: find `.human` files and `@human` markers, show a receipt, and on confirmation convert them with the **fast deterministic engine** (one plain model completion per marker, plus at most one bounded cross-file repair completion per whole-file JS/TS unit  -  see above). `npx human-to-code .` is the normal way in. |
| `human-to-code guided [root]` | The reviewed contract -> grounding -> sandbox-validation lifecycle. The only path that can ever reach `VERIFIED`. |
| `human-to-code analyze [root] [--json]` | Produce a deterministic multi-workspace project profile plus diagnostics. `SUPPORTED` means statically recognized, not certified. |
| `human-to-code plan <file.human> [--root <root>]` | Write a review-blocked `ChangeContractV1` draft. |
| `human-to-code context <contract> --explain [--offline] [--json]` | Show the complete outbound context envelope a remote provider would receive  -  ranges, hashes, reasons, redactions, exclusions. `--explain` is required. |
| `human-to-code generate <contract> --provider ... --model ...` | Create a run record and a reviewable structured patch. Touches nothing in the working tree and runs no validation. |
| `human-to-code validate <run-id>` | Compare the unchanged baseline against the candidate using the preselected validation plan, inside a strong sandbox. This standalone command never makes provider repair calls. |
| `human-to-code apply <run-id>` | Apply an unchanged, `VERIFIED`, Git-backed run after exact hash checks, using per-file atomic replacement and writing a rollback artifact. |
| `human-to-code rollback <run-id>` | Restore a successfully applied run from its private rollback artifact, after exact post-apply hash checks. |
| `human-to-code check [root]` | Confirm every `.human` source has a valid, reviewed, current contract. |
| `human-to-code migrate-config [root]` | Migrate the alpha config explicitly, keeping a `.alpha.bak` backup. |
| `human-to-code --init [root]` | Create a schema-v1 config without overwriting an existing one. Review the generated provider before you use it. |

Options you'll actually use: `--file`, `--provider`, `--model`,
`--base-url`, `--api-key-env`, `--input-cost-per-million`,
`--output-cost-per-million`, `--unmetered-provider`, `--trust-custom-endpoint`,
`--offline`, `--explain`, `--dry-run`, `--json`, `--sandbox-image`,
`--docker-binary` (override for any Docker-compatible CLI, Podman included), and
`--manual-passed`.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | `VERIFIED`, or a read-only/administrative command like `analyze`, `context`, or `migrate-config` finishing cleanly. A read-only exit `0` is not generation certification. |
| `1` | Usage or configuration error. |
| `2` | Stale contract/artifact, or failed validation. |
| `3` | `NEEDS_INPUT`, `UNSUPPORTED`, or `INCONCLUSIVE`. |
| `4` | `SECURITY_BLOCKED`. |
| `5` | Provider or documentation dependency failure. |
| `6` | Internal error or partial scan. |

For generated runs, `VERIFIED` is the only thing that counts as success. Skipped
validation, a missing sandbox, flaky checks, an unhealthy baseline, pending
manual checks, unsupported profiles, or unavailable prerequisites must never be
read as exit code `0`.

## Configuration

Config is strict, schema-versioned JSON. Unknown keys and credential-looking
values get rejected. Credentials live in the environment and nowhere else  - 
`apiKeyEnv` holds the environment variable's **name**, never the key itself.

`--init` writes the complete frozen loopback-Ollama default and refuses to
overwrite a file that's already there. Treat what it gives you as a template to
review: confirm the model is actually installed or switch to OpenAI/Ollama
Cloud, only set remote consent after you've read the context policy, and keep
credential values in the named environment variable.

For OpenAI or Ollama Cloud, leave `remoteProviderConsent` false while you're
planning, run `human-to-code context <contract> --explain`, read every item,
configure conservative model-specific pricing bounds, and *then* set consent to
true. Remote providers get no follow-up context tools, so what you see in that
preview is the complete code and documentation envelope for the current
project/config state. Re-run it after changing project files, private
documentation, workspace overrides, or context policy.

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

## Project intelligence and grounding

Analysis is static and read-only. It doesn't import Python modules, execute
JavaScript/TypeScript configuration, run framework CLIs, or invoke Cargo. What
it does is inventory workspace ownership, manifests and lockfiles, exact version
evidence, aliases, routes and entry points, source/test/generated/protected
roots, framework signals, and candidate validation commands.

The support matrix currently declares preview profiles for:

- React: Vite SPA/SSR, Next App/Pages/Hybrid routers, React libraries, Nx, and
  legacy CRA.
- NestJS: standalone, Nest CLI monorepo, and Nx projects, including static
  module/DI, HTTP-adapter, auth, and ORM signals.
- FastAPI: application layouts with environment-manager, router/dependency,
  Pydantic, and sync/async signals.
- Rust: Cargo crates and workspaces with edition, toolchain, feature, target,
  `unsafe`, FFI, build-script, proc-macro, and native dependency signals.

Conflicting lockfiles or environment managers, multiple plausible applications,
unresolved dynamic metadata, unsupported versions, unreadable paths, symlinks,
or hitting scan limits all return a non-success status. Nothing gets picked by
directory order.

Context is selected from relevant project definitions, tests, and configuration,
nearby patterns, exact installed dependency declarations with source and lock
evidence, and any private documentation you've configured. Every admitted item
records where it came from, its line range, its version where that applies, its
SHA-256, the reason it was included, and any redactions or exclusion decisions.

Built-in official-documentation discovery is deliberately narrow in this
preview. Deterministic pre-provider grounding, and a local compiler-tool
request, can fetch a Rust dependency's `docs.rs` page  -  but only when the
analyzer has an exact resolved version. You can add `documentation.officialSources`
mappings for an exact ecosystem/dependency/version and an allowlisted HTTPS URL,
which enables that one mapping after installed-version proof. It does not enable
general search or crawling. Pre-provider evidence shows up in the complete
remote preview, and remote models still can't start another lookup. The
retriever enforces public DNS, pins production connections to a vetted address,
applies an allowlist and bounded content limits, safely revalidates redirects
and DNS, and uses a version-and-content-hash cache with strict offline hits.
There is no automatic React, NestJS, FastAPI, Python, or general documentation
crawler.

`documentation.mode: "local-first"` may contact an approved documentation host
while building `context --explain`  -  that happens before any LLM provider
consent or request. The built-in `docs.rs` URL discloses the crate and its exact
version, and a mapping you configure discloses its requested URL and can encode
the same metadata. No source content goes out in the documentation request. Use
`--offline` or `documentation.mode: "offline"` to forbid that network access and
require an exact cache hit.

Generic model memory is never provenance. The host rejects recognized new
JavaScript/TypeScript, Python, and Rust external imports and use paths  -  plus
the symbols they statically name  -  when the selected evidence doesn't prove
them. This is a conservative syntax gate, not a complete language-service proof:
dynamic imports, reflection, macros, aliases, and member/property APIs can all
be opaque to it. Those cases still depend on the compiler, typechecker, and
tests. Neither model confidence nor the mere presence of documentation earns
certification.

## Compiler skills and tools

Built-in compiler skills are immutable policy data, selected for whichever
ecosystem was detected:

- Core change-contract scope and provenance.
- React routing, server/client, state/data/UI, environment, and testing
  conventions.
- NestJS module/DI, guards, DTO runtime validation, ORM, tenancy, and
  HTTP-adapter conventions.
- FastAPI environment, dependency injection, Pydantic, sync/async, transaction,
  auth, and serialization conventions.
- Rust Cargo, MSRV/toolchain, feature/target, public API, `unsafe`, FFI, and
  lockfile conventions.

They aren't repository scripts and they can't grant authority. The model has no
shell, no browser, no write access, no installer, no Git, no secrets, and no
arbitrary filesystem tool. Context tools are only advertised to a verified
loopback-local endpoint  -  currently just local Ollama  -  which can make at most
eight host-validated requests of four kinds:

- Literal symbol search over bounded files in one analyzed workspace.
- Read one bounded, non-protected workspace file.
- Read installed declarations or manifest/lock evidence for a proven dependency.
- Read files the analyzer diagnostics already named.

Every local request stays root-confined, path-checked, size-limited,
token-budgeted, and recorded in the final context manifest. A local
dependency-documentation request can still make the allowlisted metadata-only
web lookup described above, unless you're in offline mode. Remote OpenAI, Ollama
Cloud, and custom cloud providers get **no** compiler tools at all  -  which is
exactly why `context --explain` is the complete provider-bound envelope and not
just an opening sample that grows after you consent. If the preview doesn't hold
enough evidence, remote generation stops instead of quietly adding more. Source
comments, READMEs, `.human` text, diagnostics, dependency source, and
documentation are all wrapped as untrusted evidence and can't change policy,
commands, scope, tests, or budgets.

## Validation and apply

Before any context selection or provider call, a separate fail-closed scanner
walks first-party regular files across the whole repository  -  including ignored
and untracked fixtures, logs, and configuration. It skips third-party dependency
and build stores plus VCS and run-store internals, ignores symlinks, and reports
only the path, line, and kind of finding. Never the matched value. Budget
exhaustion, hardlinks, special files, races, or unreadable paths are all
partial-scan failures. A credential-like finding is `SECURITY_BLOCKED`.

Generation runs against an immutable snapshot and produces `PatchSetV1`
operations carrying exact base hashes and requirement mappings. Patches get
rejected before anything executes if they violate scope, edit
protected/generated/lockfile paths, use stale or non-unique edit anchors,
traverse paths, escape via symlink or hardlink, carry binary content, collide on
case, overlap each other, or go over the size and operation limits.

Validation captures argv arrays before generation, runs the unchanged baseline
first, and then runs the candidate through Docker or Podman in a strong OCI
sandbox. That container has no network, a read-only root filesystem, a scrubbed
home and environment, dropped capabilities, no-new-privileges, and limits on
CPU, memory, processes, time, and output. The only writable thing is its
disposable workspace snapshot. `auto` probes Docker and then Podman. Project
tests, package scripts, formatters, Cargo build scripts, proc macros, and
packaging hooks are all treated as arbitrary code execution, because that's what
they are.

Validation never pulls an image. The configured image has to already exist
locally, gets resolved to its immutable content ID before execution, and that ID
is recorded in the diagnostics. Otherwise no project command runs and validation
comes back `INCONCLUSIVE`. Default image names are just convenient tags, so if
repeatability across machines matters, preload the reviewed image and pass an
immutable digest with `--sandbox-image`. Docker or Podman, its daemon, the host
kernel, and the installed image all stay inside the trusted computing base.

Captured stdout and stderr get scanned before the report is persisted. If either
one holds credential-like content, both raw streams are thrown away, the report
keeps only a constant `SECURITY_BLOCKED` diagnostic, and the run is
security-blocked. The private run store independently refuses any artifact
string matching a secret pattern.

No strong sandbox means no project command runs and the result is
`INCONCLUSIVE`. Baseline failures, fail-then-pass flakiness, pending manual
checks, unavailable toolchains or services, and mixed ecosystems without an
explicit multi-toolchain image all block verification too.

The `human-to-code guided` flow can ask the same provider and model for at most
two diagnostic repairs, further limited by `budgets.maxRepairs`. Repairs only
run for deterministic candidate regressions after a healthy baseline in the
strong sandbox. They can't run for security findings, infrastructure or
toolchain failures, timeouts, flaky or truncated output, or unavailable
services. And they can't change paths, operation kinds, provenance, requirement
coverage, dependencies, lockfiles, test operations, or validation
configuration  -  nor remove test obligations that were already proposed. Every
accepted repair is safety-checked and validated from fresh baseline and
candidate copies.

Repair checkpoints preserve cumulative request/token/cost/repair usage, provider
identity, request IDs, immutable input hashes, attempt patches and diffs, and
reports. A crash can't reset the allowance. The standalone `validate <run-id>`
command deliberately holds no provider credentials, so it only revalidates the
stored patch. An embedding caller can continue whatever repair allowance is left
only by supplying the exact original provider and persisted configuration.

`generate` and `validate` never touch your working tree. `apply` is a separate
step and demands a `VERIFIED` run, unchanged provenance and base hashes, a
Git-backed project, an intact private run store, a same-run lock, and per-file
atomic replacement. Before it mutates anything it stores a private
`rollback.json` holding the patch hash, prior content and modes, created paths,
and expected post-apply hashes; a successful application then adds `apply.json`.
Application is rollback-backed, not a filesystem-wide transaction  -  if an
operation fails, the implementation attempts in-process restoration. Git
presence is a safety gate in this preview; the tool doesn't create a commit and
doesn't use the Git index as its rollback mechanism.

`human-to-code rollback <run-id>` needs those artifacts, takes the same
exclusive run lock, checks the applied content still hashes to exactly what it
expects, reverses the operations, restores modes, and writes
`rollback-result.json`. If it finds drift, rollback goes `INCONCLUSIVE` rather
than overwriting newer work. Database migrations can be generated for review but
are never applied, and generated files and lockfiles are protected from
model-authored edits.

The lock serializes actions for one run ID only. It is not a repository-global
editor lock or a cross-run lock. Don't apply two runs at once, and don't edit
touched files while a run is still going. Exact hashes catch most drift, but a
process or host crash during a multi-file apply can still leave partial changes.
Because `apply.json` only gets written after everything completes, you'll need
to recover an interrupted apply by hand from the private `rollback.json`
artifact before continuing. Run records default to the platform cache
(`HUMAN_TO_CODE_CACHE/runs` when that variable is set), so if you're relying on
rollback, put that directory on protected durable storage and keep it there.

## Remaining preview limitations

- No shipped ecosystem profile and no provider/model pair has passed the
  required certification benchmark. Preview-generated runs can't become
  `VERIFIED`, so apply and rollback are implemented safety paths that simply
  aren't enabled for normal generated runs yet. Certification is decided by a
  fail-closed WRITE gate: a run is certified only when host-owned, re-scored
  benchmark evidence exists for that exact provider/model profile and every
  target ecosystem  -  at least 25 tasks per ecosystem, three runs each, and a
  ≥95% strong-sandbox pass rate. The evidence registry ships empty and is never
  sourced from the analyzed repository, so no self-attestation and no amount of
  model confidence can certify a run. Shipping a real, scored corpus is what
  unblocks `VERIFIED` and 1.0.
- Built-in official web discovery only covers exact-version Rust `docs.rs`
  evidence, either selected deterministically before provider access or
  requested by local Ollama. Other ecosystems have no automatic crawler  -  they
  use local evidence, private documentation, or exact `officialSources`
  mappings you configured.
- Remote providers deliberately can't request follow-up context. If the complete
  outbound preview is missing an API or symbol, generation stops. It won't fetch
  more after you've consented.
- Guided validation implements the bounded repair loop and crash-safe
  checkpoints described above. The standalone `validate <run-id>` CLI can't
  start or resume provider repairs; only the guided flow or an embedding caller
  holding the exact provider and config can use the remaining allowance.
- There's no dependency, toolchain, or service provisioning phase. Missing
  packages, browser harnesses, linkers, targets, databases, or cloud services
  can't be repaired by the model, and they prevent verification.
- Mixed-ecosystem validation needs a trusted multi-toolchain image that you
  supply explicitly. UI behavior, security policy, migrations, unsafe Rust and
  FFI, and other manual criteria still need a human to look at them.
- The CLI has real HTTP adapters only for OpenAI and Ollama. The
  alpha-compatible Anthropic, Grok, and Gemini config names are migration
  inputs, not working provider integrations.

## Run statuses

Every generated run ends with exactly one status:

- `VERIFIED`  -  every required check passed in a strong sandbox, for a certified
  profile/provider/model combination.
- `NEEDS_INPUT`  -  a material choice, consent, credential, or contract decision
  is missing.
- `UNSUPPORTED`  -  the project capability sits outside the declared matrix.
- `INCONCLUSIVE`  -  a patch or validation evidence exists, but certification
  can't be completed.
- `FAILED`  -  generation or validation failed.
- `SECURITY_BLOCKED`  -  a secret, unsafe endpoint, path escape, or prohibited
  operation was detected.

Only `VERIFIED` authorizes automatic application. See [SECURITY.md](SECURITY.md)
for the trust model, and [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants
your changes have to preserve.

## Codebase documentation

Pick whichever one matches your question:

| I want to understand... | Read |
| --- | --- |
| What a project term means | [Architecture glossary](docs/GLOSSARY.md) |
| How the product works, why each source folder and file exists, and where to start in VS Code | [Codebase tour](docs/CODEBASE_TOUR.md) |
| Why the source is split into these layers | [Architecture](docs/ARCHITECTURE.md) |
| What each source file owns | [Module guide](docs/MODULES.md) |
| How functions, variables, and lifecycle comments should be named | [Source clarity and naming practices](docs/CODE_CLARITY.md) |
| Every configuration field and default | [Configuration reference](docs/CONFIGURATION.md) |
| How to add ecosystems, providers, or schema versions safely | [Scalability and engineering practices](docs/SCALABILITY.md) |
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
