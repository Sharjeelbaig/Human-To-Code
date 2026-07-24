# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is in preview and versioned `0.1.x`; until `1.0.0`, the public
TypeScript API may be reorganized in any release. The **config schema is
versioned separately** (`schemaVersion: 1`) and changes only additively.

Structured entries start at `0.1.47`. Earlier history lives in the commit log:

```bash
git log --oneline
```

## [Unreleased]

### Added

- Brand-aligned README banner built from the chevron-and-cursor mark in
  `assets/brand/`, replacing the off-brand placeholder.
- `CODE_OF_CONDUCT.md`, `SUPPORT.md`, this changelog, issue and pull request
  templates, `CODEOWNERS`, and a Dependabot configuration.
- README: a "How it works" card layout, a "What you get" card grid, a release
  status table, and a community section.

### Fixed

- The Node version badge no longer renders as broken markup. A raw `>` inside an
  HTML `alt` attribute was terminating the tag early in GitHub's renderer.
- Removed README links to `docs/ARCHITECTURE.md`, `docs/MODULES.md`,
  `docs/CODE_CLARITY.md`, and `docs/GLOSSARY.md`, which have 404ed since those
  files were deleted in `9348521`. Their content is covered by
  [docs/Codebase_Tour.md](docs/Codebase_Tour.md).
- The `status: preview` badge now links to a "Release status" section that
  actually exists.
- `package.json` now declares `repository`, `bugs`, `homepage`, and `author`, so
  the npm page links back to the source instead of showing no repository at all.

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
