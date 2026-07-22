# SQL support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`. SQL also intersects an existing
invariant: database migrations may be *generated for review* but are never
applied  -  any SQL profile inherits that rule wholesale.

## Target profile
- `Ecosystem`: `sql`.
- Variant: `migration-set`  -  a directory of ordered migration files managed
  by a recognizable tool (Flyway `V__*.sql`, dbmate, golang-migrate,
  Prisma/TypeORM/Alembic SQL output). Free-floating `.sql` files stay on the
  general fallback.
- Dialects recorded as signals (postgres/mysql/sqlite) from tool config, not
  guessed from syntax.

## Detection signals (static only)
- Migration tool config (`flyway.conf`, `dbmate` env refs, `migrations/`
  naming schemes), ordered filename conventions, and the owning framework's
  adapter (a NestJS/FastAPI workspace may own its migrations directory).

## Version evidence
The "dependency" is the schema itself: prior migrations in order are the
grounding evidence a new migration builds on. No package versions.

## Validation plan
- Syntax-only gates in the sandbox: `["sqlfluff", "lint", "--dialect", "<dialect>"]`
  or the tool's dry-run/check mode where one exists **without a database**.
- Optional stronger tier later: apply to a disposable in-container database
  (sqlite/postgres in the image)  -  still never the operator's database.

## Skill pack
One reversible change per migration (paired down-migration when the tool
supports it), no destructive `DROP` without explicit contract authorization,
idempotence patterns, naming convention of the detected tool.

## Risks & gates
Everything: destructive statements, data backfills, and permission changes
are elevated-risk requiring explicit authorization in the contract. Applied
migration files are immutable history  -  protected paths; only new files may
be created.

## Checklist
1. `Ecosystem` union + `tools/analysis/adapters/sql.ts` keyed on migration-tool detection.
2. `sql/migration-set` at `preview`.
3. SQL skill pack; extend patch policy tests for "create-only in migrations dir".
4. Tests: ordering, tool detection, destructive-statement gating, dialect signals.
5. Docs updates.
