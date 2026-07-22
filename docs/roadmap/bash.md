# Bash / shell-script support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`; `.sh` not scanned for markers
(`# @human` markers would already parse  -  the `#` comment form is supported
by the marker regex  -  but `.sh` files are not in `SCANNED_EXTENSIONS`).

## Target profile
- `Ecosystem`: `shell`.
- Variant: `script-collection`  -  a repo (or subtree) of `*.sh`/`*.bash`
  scripts. There is no manifest, so this profile is signal-based:
  shebang lines + extension inventory, and it should stay deliberately
  narrow. Anything ambiguous stays with the general fallback.
- Versions: bash >= 4 assumed by image; POSIX-sh scripts flagged by shebang.

## Detection signals (static only)
- Shebangs (`#!/usr/bin/env bash`, `#!/bin/sh`), `.shellcheckrc`,
  `Makefile` targets referencing scripts, `bats` test files (`*.bats`).

## Version evidence
No package manager: dependency grounding is out of scope. The profile's
honesty lever is that generation is anchored to shellcheck-clean patterns
rather than external APIs.

## Validation plan
- `["shellcheck", "<changed scripts>"]` and `["bash", "-n", "<script>"]`
  syntax checks; `["bats", "test/"]` when a bats suite exists. All in the
  sandbox image  -  scripts themselves are never executed outside it.

## Skill pack
`set -euo pipefail` discipline, quoting rules, `trap` cleanup, no curl-pipe
patterns (aligns with the validator's implicit-downloader rejection),
portable vs bash-specific constructs by shebang.

## Risks & gates
Every script is arbitrary code  -  validation runs syntax/lint/bats only,
never the script itself. Scripts that self-modify or fetch remote content
must be flagged as elevated risk in contracts.

## Checklist
0. Add `bash` to `LANGUAGE_PROFILES` (`.sh`) and `.sh`/`.bash` to `SCANNED_EXTENSIONS`.
1. `Ecosystem` union + `tools/analysis/adapters/shell.ts` (small, signal-based).
2. `shell/script-collection` at `preview`.
3. Register adapter; shell skill pack.
4. Tests: shebang inventory, non-script repos not claimed, bats detection, stable fingerprints.
5. Docs updates.
