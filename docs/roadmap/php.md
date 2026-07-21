# PHP support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES` (direct path would fall back to a
`.txt` profile) and `.php` is not scanned for markers.

## Target profile
- `Ecosystem`: `php`.
- Variants: `composer-app`, `laravel` (artisan + `bootstrap/app.php`),
  `symfony` later.
- Versions: PHP >= 8.2 (from `composer.json` `require.php`).

## Detection signals (static only)
- `composer.json` (`require`, `autoload.psr-4`), `composer.lock`,
  `artisan`, `routes/`, `app/Http/` for Laravel; `phpunit.xml(.dist)` for
  tests. Never run composer or artisan.

## Version evidence
`composer.lock` `packages[].version` is exact; `composer.json` ranges alone
leave dependencies unproven.

## Validation plan
- `["vendor/bin/phpunit"]`; `["vendor/bin/phpstan", "analyse"]` when
  configured; `["php", "-l", "<changed files>"]` as a cheap syntax gate.
  `vendor/` must be preinstalled in the image (no network).

## Skill pack
PSR-4 path<->namespace correspondence, PSR-12 style, Laravel conventions
(form requests for validation, Eloquent scopes), `vendor/` and framework
cache dirs protected.

## Risks & gates
Laravel migrations review-only; `eval`/dynamic includes opaque to import
grounding; service-provider registration changes are elevated-risk.

## Checklist
0. Add `php` to `LANGUAGE_PROFILES` (`.php`) and `.php` to `SCANNED_EXTENSIONS`  -  direct-path quick win.
1. `Ecosystem` union + `analysis/adapters/php.ts`.
2. `php/composer-app`, `php/laravel` at `preview`.
3. Register adapter; PHP/Laravel skill pack.
4. Tests: missing lockfile, PSR-4 mismatches, Laravel vs plain-composer ambiguity, stable fingerprints.
5. Docs updates.
