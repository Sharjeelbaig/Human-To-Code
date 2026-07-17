# Scalability and engineering practices

How to grow this codebase without eroding its guarantees. The safety
invariants in [CONTRIBUTING.md](../CONTRIBUTING.md#non-negotiable-safety-invariants)
are the hard floor; this document covers the structural practices that keep
the code readable and extensible as it scales.

## Layering rules

Source lives in layered domain folders (see
[ARCHITECTURE.md](ARCHITECTURE.md)). The rules:

1. **Imports point upward only.** A module may import from its own folder or
   a layer above it (`core` at the top, `pipeline` at the bottom, entry points
   below everything). If you need a downward import, the type or helper you
   want belongs in a higher layer — move it, don't bend the arrow.
2. **`core/` stays dependency-free.** Nothing in `core/` imports from any
   other folder or from an SDK. It is the shared vocabulary; keeping it leaf
   is what prevents import cycles as the codebase grows.
3. **Entry points stay thin.** `cli.ts` parses arguments, maps statuses to
   exit codes, and prints; `index.ts` only re-exports. Behavior belongs in a
   layer, where it is testable without a TTY.
4. **One module, one responsibility.** New functionality gets a new file in
   the right folder rather than growing an existing file past its purpose.
   If a file needs a paragraph to describe, it is two files.
5. **Every module starts with a `/** … */` header** stating what it does and,
   where relevant, what it deliberately does not do. The headers are the
   first line of documentation; keep them true when behavior changes.

## Extension points

The codebase has three designed seams. Extending along them requires no
changes to the layers above.

### Adding an ecosystem (e.g. Django, Spring)

1. Implement `EcosystemAdapter` (`analysis/analyzer-types.ts`) in a new
   `analysis/adapters/<name>.ts`. Analysis must stay static: inspect only the
   bounded `AnalyzerContext`; never import project modules, evaluate config,
   or spawn tools. Emit version evidence and candidate validation commands.
2. Declare the recognized variants/versions in `analysis/support-matrix.ts`,
   starting at `preview` tier. Support is declared, never inferred.
3. Register the adapter in `DEFAULT_ECOSYSTEM_ADAPTERS`
   (`analysis/analyzer.ts`).
4. Add a skill pack in `context/compiler-skills.ts` for the ecosystem's
   conventions (policy data only — it grants no authority).
5. Add positive and adversarial fixtures per the analyzer checklist in
   CONTRIBUTING.md: conflicting lockfiles, ambiguous workspaces, symlinks,
   partial scans, stable ordering and fingerprints.

### Adding a provider (e.g. Anthropic)

1. Implement `ProviderAdapter` (`providers/provider.ts`) in
   `providers/providers.ts` (or a sibling file) using only Node built-ins and
   `security/pinned-http.ts` for transport. No new runtime dependencies.
2. Route all output through the existing schema gate (`generateValidated`)
   and budget accounting — pessimistic pre-request reservation, reconciliation
   on provider-reported usage, conservative charge on failure.
3. Bind credentials to the endpoint via `apiKeyEnv` only; require reviewed
   pricing bounds for remote endpoints; never advertise context tools to a
   non-loopback destination.
4. Wire the name through `config/config.ts` validation and the CLI factory in
   `cli.ts`. No silent fallback of provider, model, or endpoint — ever.
5. Test with injected fetch/DNS/clock seams per the provider checklist in
   CONTRIBUTING.md.

### Evolving an artifact schema

Artifacts (`*V1` in `core/contracts.ts`) are the contracts between stages and
between releases:

- **Additive and compatible?** Extend the V1 type and its exact validator
  together, plus the JSON Schema in `providers/schemas.ts` if the artifact
  crosses the provider boundary.
- **Meaning changes?** New version (`*V2`), new validator, explicit migration
  (the `migrate-config` command is the pattern). Never silently reinterpret a
  stored artifact — run records outlive releases.
- Unknown fields always remain errors. Loosening exact-key validation is a
  design discussion, not a patch.

## Code conventions

- **TypeScript strict, no escape hatches.** `strict` and
  `noUncheckedIndexedAccess` stay on; avoid `any` and non-null assertions —
  validate at the boundary and let types flow.
- **Minimal production dependencies.** HTTP, hashing, JSON, and process
  handling use Node built-ins. The one exception is the deep-agent engine
  (`pipeline/deep-agent.ts`), which depends on `deepagents`/`langchain`; those
  imports are confined to that module. Adding a runtime dependency anywhere else
  changes the supply-chain posture and needs a design discussion first.
- **Errors are typed and named.** Each layer exports its own error classes
  (`ArtifactValidationError`, `ProviderError`, `PatchSafetyError`, …) so the
  CLI can map failures to exit codes without string matching. Error messages
  never contain secret values.
- **Determinism by default.** Stable ordering for anything hashed, listed, or
  persisted; inject clock/randomness/network/exec as parameters so tests can
  control them.
- **Statuses, not booleans.** Multi-outcome operations return the typed run
  statuses (`VERIFIED`/`NEEDS_INPUT`/`UNSUPPORTED`/`INCONCLUSIVE`/`FAILED`/
  `SECURITY_BLOCKED`), and only `VERIFIED` is success.

## Testing practices

- Every `src/**/x.ts` with behavior has a mirror `test/x.test.ts`; keep the
  mirror when adding or moving modules.
- Tests are deterministic and offline: injected fetch/DNS/environment/clock
  seams, no real provider, network, or container daemon (the validation tests
  stub the sandbox probe).
- New behavior ships with its most plausible misuse and failure cases, not
  just the happy path — the per-area checklists in CONTRIBUTING.md are the
  bar.
- Secret-handling tests use unmistakably synthetic values and assert that raw
  values never appear in errors, reports, or stored artifacts.
- `npm run typecheck && npm test && npm run build && npm run package:check`
  must pass from a clean install before review; CI runs the same set.

## Documentation practices

Documentation is layered like the code — update the layer that owns the fact:

| Layer | Owns | Update when |
| --- | --- | --- |
| Module headers | What one file does | The file's behavior changes |
| [docs/MODULES.md](MODULES.md) | The per-file map | A module is added, moved, or repurposed |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | Layers, flow, design decisions | A layer, stage, or invariant-relevant design changes |
| [Readme.md](../Readme.md) | User-facing behavior and guarantees | CLI behavior, config, statuses, or limitations change |
| [SECURITY.md](../SECURITY.md) | Trust model | Any trust-boundary change |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Invariants and checklists | The engineering bar itself changes |

A pull request that changes behavior updates the affected documentation in
the same change — documentation drift is treated as a defect, and honest
wording is part of review (never describe a fail-closed limitation as a
feature gap to be papered over).

## Growth guardrails

- **When a folder accumulates unrelated concerns, split the folder**, not
  just the file — the layer list in ARCHITECTURE.md is expected to grow.
- **New capability starts fail-closed.** Ship recognition at `preview`,
  refuse ambiguity, and let certification evidence — not confidence — promote
  it. This is what keeps adding surface area from multiplying risk.
- **No bypass flags.** If a gate is inconvenient, the fix is evidence or
  design, never a flag that converts a non-success status into exit 0.
- **Entry-point stability.** `src/index.ts` and `src/cli.ts` stay at the
  source root so `dist/index.js` and `dist/cli.js` (package `main`/`bin`)
  never move; reorganize beneath them freely.
