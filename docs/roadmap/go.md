# Go support plan

## Status today
Level 1: `LANGUAGE_PROFILES` has `go` (`.go`), and `.go` is in
`SCANNED_EXTENSIONS`, so whole-file `.human` and inline `// @human` markers
already work through the direct path. No grounded profile.

## Target profile
- `Ecosystem`: `go` (new union member in `analyzer-types.ts`).
- Variants: `module` (single `go.mod`), `workspace` (`go.work`), with
  HTTP-framework signals (net/http, chi, gin, echo) recorded as profile
  signals, not variants, until one earns its own entry.
- Versions: Go ≥ 1.21 (from the `go` directive in `go.mod`).

## Detection signals (static only)
- `go.mod`  -  module path, `go`/`toolchain` directives, `require` blocks.
- `go.sum`  -  presence distinguishes resolved deps; `go.work`/`go.work.sum`
  for workspaces. Conflicting nested modules without `go.work` -> `NEEDS_INPUT`.
- `*_test.go` naming for test roots; `cmd/`, `internal/`, `pkg/` conventions
  for entry-point/source-root inventory. Never run `go list`.

## Version evidence
`go.mod` `require` lines give exact pinned versions (Go modules pin by
design); `go.sum` corroborates. Both are protected/lockfile paths the model
must not edit.

## Validation plan (sandbox argv arrays)
- `["go", "build", "./..."]`, `["go", "vet", "./..."]`, `["go", "test", "./..."]`.
- Needs a Go toolchain image; record the `go` directive so an image mismatch
  is `INCONCLUSIVE`, not a guess.

## Skill pack
Module-path-relative imports only; table-driven tests; error-wrapping
(`%w`) conventions; no `init()` side effects; generated files
(`*_gen.go`, `zz_generated*`) are protected.

## Risks & gates
`cgo`, `unsafe`, `//go:generate`, build tags, and replace directives are
elevated-risk and need explicit contract authorization  -  same posture as
Rust's `unsafe`/FFI gates.

## Checklist
1. Add `go` to the `Ecosystem` union + `analysis/adapters/go.ts` implementing `EcosystemAdapter`.
2. Declare `go/module` + `go/workspace` in `support-matrix.ts` at `preview`.
3. Register in `DEFAULT_ECOSYSTEM_ADAPTERS`; add a Go skill pack in `compiler-skills.ts`.
4. Tests per CONTRIBUTING's analyzer checklist: nested modules, missing `go.sum`, `go.work` ambiguity, cgo detection, stable fingerprints.
5. Update `docs/MODULES.md` and the support matrix section of the README.
