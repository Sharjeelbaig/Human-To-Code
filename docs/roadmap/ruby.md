# Ruby support plan

## Status today
Level 1: `LANGUAGE_PROFILES` has `ruby` (`.rb`); `.rb` is **not** yet in
`SCANNED_EXTENSIONS`, so inline `# @human` markers in Ruby files are not
discovered — adding it is a one-line prerequisite worth shipping early.

## Target profile
- `Ecosystem`: `ruby`.
- Variants: `gem` (gemspec), `rails` (config/application.rb + bin/rails),
  `rack` (config.ru without Rails).
- Versions: Ruby ≥ 3.1 (from `.ruby-version` / Gemfile `ruby` directive).

## Detection signals (static only)
- `Gemfile` + `Gemfile.lock`; `*.gemspec`; `config/application.rb`,
  `config/routes.rb`, `app/{models,controllers}` for Rails layout;
  `spec/` (RSpec) vs `test/` (Minitest) for test roots. Never run `bundle`.

## Version evidence
`Gemfile.lock` `GEM/specs` entries are exact — this is the grounding source;
a Gemfile without a lockfile leaves dependencies unproven.

## Validation plan
- `["bundle", "exec", "rspec"]` or `["bundle", "exec", "rails", "test"]`
  depending on detected harness; `["bundle", "exec", "rubocop"]` when
  `.rubocop.yml` exists. Gems must be vendored/preinstalled in the image —
  no network in the sandbox.

## Skill pack
Rails conventions (strong parameters, concerns, service objects), RSpec
structure, frozen-string-literal pragma, Zeitwerk autoloading constraints
(file path ↔ constant name), `db/schema.rb` and migrations protected.

## Risks & gates
Rails migrations (review-only, never applied), monkey-patching core classes,
`method_missing` metaprogramming, and native-extension gems are
elevated-risk. Dynamic requires make import grounding partially opaque —
document as an accepted limitation like Python's.

## Checklist
0. Add `.rb` to `SCANNED_EXTENSIONS` in `pipeline/simple.ts` (independent quick win).
1. `Ecosystem` union + `analysis/adapters/ruby.ts`.
2. `ruby/gem`, `ruby/rails`, `ruby/rack` at `preview`.
3. Register adapter; Ruby/Rails skill pack.
4. Tests: lockfile absence, Rails vs Rack ambiguity, engine subdirectories, stable fingerprints.
5. Docs updates.
