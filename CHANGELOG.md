# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from `1.0.0` onward: the CLI contract, the exported TypeScript API, and the
config schema do not break within a major version. The **config schema is
versioned separately** (`schemaVersion: 1`) and changes only additively.

Structured entries start at `0.1.47`. Earlier history lives in the commit log:

```bash
git log --oneline
```

## [1.0.1]

Architecture and stability release. Every item below was reported by, or found
while investigating, a single real failure: three interdependent `@human`
markers in one file where rewording one instruction turned a one-second success
into three cascading failures.

### Fixed

- **Every fresh instruction now goes through model reasoning.** The compiler
  previously used English regular expressions as a hidden code generator:
  matching phrases skipped the configured model, while equivalent rewordings
  and other human languages used it. The CLI no longer supplies deterministic
  lowering or recovery callbacks. English-match, English-nonmatch, and
  non-English instructions all take the model path; only lock/cache replay can
  skip a fresh provider request.
- **Language rules are validation-only.** For a narrow explicit fragment they
  may derive an expected name/type/operator/call after generation and reject a
  contradiction, but that expected fragment is never written as generated code.
  Instructions are normalized (connective filler such as `that are`, `which
  are`, `named`, `called`, `consisting of`, `both` is removed) so equivalent
  English phrasings receive the same optional check. The validator also covers
  reversed parameters, per-name annotations, noun/spelled/literal arithmetic,
  and direct call syntax.
- **Compiler coding requests retain selected model skills.** Isolated compiler
  mode still omits ProjectMemory, session history, blueprints, and todos, but it
  now carries the package-owned implementation guidance selected for the exact
  language and grammar slot. The selected skill content is hashed into compiler
  replay keys so changed guidance cannot reuse stale cached bytes.
- **A pathological candidate no longer spins the CPU for hours.** The CSS nesting
  scan used an unbounded greedy pattern
  (`([^{};]+)\{[^{}]*?(&[^{}]+)\{`) that retried every start position at every
  length. On a long line containing no brace this was quadratic: a 4 MiB
  candidate extrapolated to roughly eight hours of pure CPU with no output and no
  timeout, because a per-request budget cannot bound local work. Quantifiers are
  now bounded and the scan exits early when there is nothing to expand — 4 MiB
  went from unbounded to 244 ms.
- **A model restating the instruction is diagnosed as exactly that.** Small models
  commonly return the request back as a comment. That was reported as a generic
  "generated code contains a live @human marker", which reads as though the tool
  were rejecting the author's own instruction. It now says the model restated the
  instruction instead of writing code, and names the likely cause.
- **Cascading failures name their root cause.** When one unit fails, the units
  that depend on it were each reported with raw compiler errors
  (`Cannot find name 'x'`), turning one root cause into three unrelated-looking
  failures. Dependent units now say which unit to fix first.
- **A model too small to generate code is called out before the run.** Configuring
  a sub-billion-parameter model now produces a warning that all fresh requests
  require model reasoning, what that model is likely to do instead, and what to
  use.

### Added

- `test/regex-safety.test.ts` extracts every regular expression in `src/` and
  measures it against hostile input at two sizes, failing on superlinear growth.
  It reproduces the CSS-nesting blow-up (16.5x across a 4x size step) and covers
  the whole codebase rather than the one pattern that was found by hand.
- `test/compiler-rule-paraphrases.test.ts` pins the deterministic instruction
  validator: which phrasings yield a narrow expectation, which leave validation
  to the general gates, and that equivalent phrasings produce identical
  expectations in every language profile.
- Stress corpus: interdependent-marker fixtures in TypeScript and Python, plus an
  `instruction-echo` endpoint behavior reproducing what a tiny model returns.

## [1.0.0]

First stable release. This release freezes the **interfaces**, not the quality of
generated code — see "What 1.0 does not claim" below.

### Fixed

- **A stalled provider no longer hangs the command.** `budgets.timeoutMs` was
  documented and validated but never applied: the direct conversion client passed
  no timeout and no cancellation signal, so an endpoint that accepted a connection
  and then went quiet left `npx human-to-code .` waiting indefinitely. Every
  request is now bounded by that budget and abandoned when it expires.
- **A provider response can no longer exhaust memory.** Response bodies were read
  with no size limit. A declared or streamed body above 16 MiB is now refused.
- **Provider output of the wrong type is diagnosed instead of crashing.** A
  response whose assistant content was a number or object produced an internal
  `output.trim is not a function` `TypeError`. It now reports what the provider
  actually returned. A provider `error` field is likewise surfaced as the
  provider's error rather than as "model returned no code".
- **Generated code may no longer contain a live `@human` marker.** Model output
  that echoed a marker was written to disk, where the next run read it as a fresh
  instruction — letting model output queue work for a later invocation and making
  repeated runs non-idempotent. Such a candidate is now refused before any write,
  judged by the same lexical scanner discovery uses, so marker-shaped text inside
  a string or a markdown example is still allowed.
- **In-place source rewrites are atomic.** Applying an inline replacement, an
  inline batch, or an overwrite used a plain truncate-then-write, so an interrupt,
  a full disk, or a killed process could leave source *you* wrote empty or
  half-written. These now write a sibling temporary, flush it, and rename it over
  the target, preserving the file's permission bits.
- **Inline results print the same status markers as whole-file results.** A
  botched glyph replacement left the inline apply path emitting `yes <target>` and
  the ungrammatical `no skipped <target>: <reason>` instead of `✓` and `⊘`.
- **A remote provider with no declared pricing is refused again.** The guard that
  enforces this — and the adapter construction that validates endpoint/credential
  pairing — was unreachable dead code, so a remote endpoint could be used with
  `maxCostUsd` having nothing to measure against. It now runs before the first
  request, while leaving `--dry-run` and `--explain-spec` able to preview a run
  they would not attempt.

### Changed

- The release gate no longer pins the major version to `0`. It now enforces the
  guarantee that actually matters at any version: no ecosystem may declare the
  `certified` tier without passing shipped benchmark evidence, shipped evidence
  must re-validate against the current support matrix, and while the evidence
  registry is empty no provider profile certifies anything.
- `docs/CONFIGURATION.md` now states that `budgets.timeoutMs` bounds one request
  rather than the whole run.
- The README's budget and transport claims are now scoped to the request path
  they describe. Per-request cost reservation, cumulative token gating, and
  socket-level DNS pinning are adapter-transport properties and are documented as
  not applying to the default direct conversion.

### Added

- A 450-scenario stress corpus (`npm run stress`) that drives the built CLI
  end-to-end against a scripted endpoint: 350 non-compiler-mode and 100
  compiler-mode scenarios, crossing 40 software-engineering fixtures with 56 ways
  an endpoint misbehaves and 6 config permutations. It judges stability only —
  termination, documented exit codes, absence of internal errors, fail-closed
  source preservation, no temporary litter, no marker re-injection. Every defect
  listed above was found by it.
- Regression tests in `test/stability.test.ts` covering the request budget, the
  non-text-content path, the provider error field, marker refusal, mode-preserving
  atomic replacement, and unchanged source after a refused replacement.
- Project and community files carried over from the `0.1.x` line: a brand-aligned
  README banner from `assets/brand/`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, this
  changelog, issue and pull request templates, `CODEOWNERS`, a Dependabot
  configuration, and README "How it works" / "What you get" / release-status /
  community sections. `package.json` declares `repository`, `bugs`, `homepage`,
  and `author`, so the npm page links back to the source. Broken README links to
  deleted architecture docs were replaced by
  [docs/Codebase_Tour.md](docs/Codebase_Tour.md), and the Node version badge no
  longer renders as broken markup.

### What 1.0 does not claim

Generated code is still **not** verified. Static and structural checks are not
proof of runtime correctness, no sandboxed benchmark has been run, every
support-matrix ecosystem remains at the `preview` tier, and the `VERIFIED` run
status is unreachable by construction. Review the diff. Certification would
require a scored 25-task-per-ecosystem, three-run, 95% corpus; none is shipped,
and the gate above exists to keep that honest.

## [0.1.47]

### Added

- **Adaptive planning** (`direct.planning.adaptive`, opt-in). One batched
  classification pass triages which units genuinely need a per-unit todo list,
  replacing a todo request for every unit it judges simple. An unclassifiable
  batch falls back to planning everything in it, so cost drops without quality
  dropping.
- **Session memory and turn classification.** Earlier `@human` messages in a run
  are carried as conversational context, and a code-free classifier separates
  context-only turns (greetings, background, questions) from real edit requests,
  so a comment that was never an instruction no longer becomes code.
- **Structured skill definitions** with per-agent configuration, and a
  framework-agnostic skill discovery and injection system. CSS visual-design and
  responsive skills ship with the package and are selected per request.
- `ownsWholeFile` handling, so a marker that is a file's only meaningful content
  is written like a whole file and gets the same import/export repair.
- An ASCII banner on human-readable CLI output.

### Changed

- Neumorphic design system across the project website.
- The repository was reorganized into `src/core`, `src/config`, `src/llms`,
  `src/prompts`, `src/memory`, `src/tools`, and `src/workflows`. Public imports
  from `human-to-code` are unaffected  -  `src/index.ts` is the stable surface.

### Fixed

- Import/export repair diagnostics for marker-only file replacements.

## Release process

There are no git tags yet. Releases are published from `main` via
`.github/workflows/release.yml` after the full check suite passes:

```bash
npm run typecheck && npm test && npm run build && npm run package:check
```

[Unreleased]: https://github.com/Sharjeelbaig/Human-To-Code/compare/main...HEAD
[0.1.47]: https://github.com/Sharjeelbaig/Human-To-Code/commits/main
