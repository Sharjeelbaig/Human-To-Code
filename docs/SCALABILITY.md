# Scalability and engineering practices

How to grow this codebase without quietly eroding what it promises. The safety
invariants in
[CONTRIBUTING.md](../CONTRIBUTING.md#non-negotiable-safety-invariants) are the
hard floor. This document is about the structural habits that keep the code
readable and extensible as it gets bigger.

## Layering rules

Source lives in layered domain folders — see [ARCHITECTURE.md](ARCHITECTURE.md)
for the map. The rules:

1. **Imports point upward only.** A module can import from its own folder or
   from a layer above it (`core` at the top, agents near the bottom, entry
   points below everything). If you find yourself wanting a downward import, the
   type or helper you're reaching for belongs in a higher layer. Move it. Don't
   bend the arrow.
2. **`core/` stays dependency-free.** Nothing in `core/` imports another folder
   or an SDK. It's the shared vocabulary, and keeping it a leaf is what stops
   import cycles from appearing as the codebase grows.
3. **Entry points stay thin.** `cli.ts` parses arguments, maps statuses to exit
   codes, and prints. `index.ts` only re-exports. Behavior belongs in a layer
   where you can test it without a TTY.
4. **One module, one responsibility.** New functionality gets a new file in the
   right folder instead of stretching an existing file past its purpose. If a
   file takes a paragraph to describe, it's two files.
5. **Every module opens with a `/** … */` header** saying what it does and,
   where it matters, what it deliberately doesn't do. Those headers are the
   first documentation anyone reads — keep them true when behavior changes.
6. **Prompts live in `src/prompts/`.** Agent and provider modules call typed,
   pure prompt builders. Don't embed system or user instruction prose in
   transports, lifecycle orchestration, or pipeline mechanics.

## Extension points

There are three seams designed for extension. Extending along them shouldn't
require touching the layers above.

### Adding an ecosystem (Django, Spring, whatever)

1. Implement `EcosystemAdapter` (`analysis/analyzer-types.ts`) in a new
   `analysis/adapters/<name>.ts`. Analysis has to stay static: inspect only the
   bounded `AnalyzerContext`, and never import project modules, evaluate config,
   or spawn tools. Emit version evidence and candidate validation commands.
2. Declare the recognized variants and versions in
   `analysis/support-matrix.ts`, starting at the `preview` tier. Support gets
   declared, never inferred.
3. Register the adapter in `DEFAULT_ECOSYSTEM_ADAPTERS`
   (`analysis/analyzer.ts`).
4. Add a skill pack in `context/compiler-skills.ts` for the ecosystem's
   conventions. Policy data only — it grants no authority.
5. Add positive and adversarial fixtures per the analyzer checklist in
   CONTRIBUTING.md: conflicting lockfiles, ambiguous workspaces, symlinks,
   partial scans, stable ordering and fingerprints.

### Adding a provider (Anthropic, say)

1. Implement `ProviderAdapter` (`providers/provider.ts`) in
   `providers/providers.ts` or a sibling file, using only Node built-ins plus
   `security/pinned-http.ts` for transport. No new runtime dependencies.
2. Route all output through the existing schema gate (`generateValidated`) and
   the budget accounting — pessimistic pre-request reservation, reconciliation
   against provider-reported usage, conservative charge on failure.
3. Bind credentials to the endpoint through `apiKeyEnv` and nothing else,
   require reviewed pricing bounds for remote endpoints, and never advertise
   context tools to a non-loopback destination.
4. Wire the name through `config/config.ts` validation and the CLI factory in
   `cli.ts`. No silent fallback of provider, model, or endpoint. Ever.
5. Test with injected fetch/DNS/clock seams per the provider checklist in
   CONTRIBUTING.md.

### Evolving an artifact schema

Artifacts (`*V1` in `core/contracts.ts`) are the contracts between stages *and*
between releases:

- **Additive and compatible?** Extend the V1 type and its exact validator
  together, plus the JSON Schema in `providers/schemas.ts` if the artifact
  crosses the provider boundary.
- **Meaning changing?** That's a new version (`*V2`), a new validator, and an
  explicit migration — the `migrate-config` command is the pattern to copy.
  Never silently reinterpret a stored artifact; run records outlive releases.
- Unknown fields stay errors, always. Loosening exact-key validation is a design
  discussion, not a patch.

## Code conventions

The full naming, variable, and lifecycle-comment rules are in
[CODE_CLARITY.md](CODE_CLARITY.md). The short version: names expose the action,
domain object, and lifecycle stage, and comments explain the human-to-code role,
the trust boundary, or the invariant rather than narrating the syntax below
them.

- **TypeScript strict, no escape hatches.** `strict` and
  `noUncheckedIndexedAccess` stay on. Avoid `any` and non-null assertions —
  validate at the boundary and let the types flow from there.
- **Minimal production dependencies.** HTTP, hashing, JSON, process handling,
  provider access, and orchestration all use Node built-ins. TypeScript is the
  one deliberate runtime compiler dependency, used for direct JS/TS candidate
  validation — both the per-file syntax checks and the combined
  TypeScript/opted-in-JavaScript check. `@types/node` ships alongside it so
  `node:` builtin imports resolve in target projects that have no type
  dependencies of their own. Combined validation builds a TypeScript program
  over the project's JS/TS files on each staged pass (without forcing semantic
  `checkJs` onto plain JavaScript), so its cost scales with project size. The
  walk is bounded and `skipLibCheck` is forced, but a very large repository will
  pay a real compile cost per conversion run. Adding another runtime dependency
  changes the supply-chain posture and needs a design discussion first.
- **Project context stays indexed and bounded.** Direct ProjectMemory reuses the
  discovery inventory, prioritizes a fixed maximum of nearby and contract files,
  indexes current files by directory for relationship lookup, and caps every
  rendered tree and prompt block. Add new language contract extractors as
  deterministic summaries in `agents/direct/project-contracts.ts`. Don't send
  whole repositories, and don't reach for a persistent embedding cache as a
  shortcut. A new relationship rule has to provide an exact relative path, stay
  evidence rather than authority, and ship with an adversarial
  false-relationship test.
- **Integration reconciliation stays generic, opt-in, and bounded.** The default
  direct path relies on ProjectMemory and adds no second provider pass. With
  `direct.reconcileIntegrations` enabled, language profiles supply structured
  relationship edges, small connected components get audited together, and large
  components split into bounded target neighborhoods. Strict audit JSON may name
  only the paths it was given; each target is repaired at most once and each
  group verified at most once. Conservative audit and repair ceilings are shown
  before the confirmation prompt. New ecosystems extend the relationship and
  contract profiles instead of adding scenario branches to the orchestration.
- **Errors are typed and named.** Each layer exports its own error classes
  (`ArtifactValidationError`, `ProviderError`, `PatchSafetyError`, …) so the CLI
  can map failures to exit codes without matching on strings. Error messages
  never carry secret values.
- **Determinism by default.** Stable ordering for anything hashed, listed, or
  persisted. Inject clock, randomness, network, and exec as parameters so tests
  can control them.
- **Statuses, not booleans.** Multi-outcome operations return the typed run
  statuses (`VERIFIED`/`NEEDS_INPUT`/`UNSUPPORTED`/`INCONCLUSIVE`/`FAILED`/
  `SECURITY_BLOCKED`), and only `VERIFIED` means success.

## Testing practices

- Every cohesive agent or deterministic service gets a focused mirror test, with
  imports pointed at the primary module rather than a compatibility shim.
- Tests are deterministic and offline: injected fetch/DNS/environment/clock
  seams, and no real provider, network, or container daemon (the validation
  tests stub the sandbox probe).
- New behavior ships with its most plausible misuse and failure cases, not just
  the happy path. The per-area checklists in CONTRIBUTING.md are the bar.
- Secret-handling tests use unmistakably synthetic values and assert that raw
  values never show up in errors, reports, or stored artifacts.
- `npm run typecheck && npm test && npm run build && npm run package:check` has
  to pass from a clean install before review. CI runs the same set.

## Documentation practices

Documentation is layered like the code. Update the layer that owns the fact:

| Layer | Owns | Update it when |
| --- | --- | --- |
| Module headers | What one file does | That file's behavior changes |
| [docs/CODE_CLARITY.md](CODE_CLARITY.md) | Naming, variables, lifecycle comments, compatibility aliases | Source-clarity practices change |
| [docs/CODEBASE_TOUR.md](CODEBASE_TOUR.md) | The newcomer explanation of product journeys, project culture, folders, important functions, and how files cooperate | A file is added, or its role in the product changes |
| [docs/MODULES.md](MODULES.md) | The per-file map | A module is added, moved, or repurposed |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | Layers, flow, design decisions | A layer, stage, or invariant-relevant design changes |
| [Readme.md](../Readme.md) | User-facing behavior and guarantees | CLI behavior, config, statuses, or limitations change |
| [SECURITY.md](../SECURITY.md) | The trust model | Any trust-boundary change |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Invariants and checklists | The engineering bar itself changes |

A pull request that changes behavior updates the affected documentation in the
same change. Documentation drift is treated as a defect here, and honest wording
is part of review — never describe a fail-closed limitation as a missing feature
somebody should cover up.

## Growth guardrails

- **When a folder starts accumulating unrelated concerns, split the folder** —
  not just the file. The layer list in ARCHITECTURE.md is expected to grow.
- **New capability starts fail-closed.** Ship recognition at `preview`, refuse
  ambiguity, and let certification evidence promote it. Not confidence. This is
  the thing that keeps added surface area from multiplying risk.
- **No bypass flags.** If a gate is inconvenient, the fix is evidence or design.
  It is never a flag that converts a non-success status into exit 0.
- **Entry-point stability.** `src/index.ts` and `src/cli.ts` stay at the source
  root so `dist/index.js` and `dist/cli.js` (the package `main` and `bin`) never
  move. Reorganize beneath them as freely as you like.
