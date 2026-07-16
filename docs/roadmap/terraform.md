# Terraform / HCL support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`; `.tf` not scanned for markers
(`# @human` comment form would parse; extension isn't scanned).

## Target profile
- `Ecosystem`: `terraform`.
- Variants: `root-module` (has backend/provider config) and `child-module`
  (reusable module without backend). Workspaces with multiple root modules
  need explicit targeting → `NEEDS_INPUT`, mirroring the multi-app rule.
- Versions: `required_version` and `required_providers` blocks.

## Detection signals (static only)
- `*.tf`/`*.tf.json`, `.terraform.lock.hcl`, `terraform.tfvars`,
  `backend`/`provider` blocks (textual HCL parsing, conservative),
  `modules/` layout.

## Version evidence
`.terraform.lock.hcl` pins exact provider versions with hashes — first-class
grounding evidence. Module registry sources with versions count; git-ref
module sources without a pinned rev are unproven.

## Validation plan
- `["terraform", "fmt", "-check"]` and `["terraform", "validate"]` with a
  pre-initialized `.terraform` directory baked into the image/fixture
  (validation has no network for `init`). `plan`/`apply` are out of scope:
  plan needs credentials and state — never available in the sandbox.

## Skill pack
Variable/output descriptions and types, no inline credentials (secret
scanner already blocks values; the pack forbids the pattern), tagging
conventions, `for_each` over `count` for stable addresses, state-affecting
rename awareness (`moved` blocks).

## Risks & gates
Everything that changes resource addresses (renames without `moved`),
`destroy`-provoking changes, provider version bumps, and backend changes
are elevated-risk. The tool must be explicit that `validate`-clean ≠
apply-safe — plan/apply stay human-owned.

## Checklist
0. Scan `.tf` for `# @human` markers (direct-path quick win, `LANGUAGE_PROFILES` entry `hcl`/`.tf`).
1. `Ecosystem` union + `analysis/adapters/terraform.ts`.
2. `terraform/root-module`, `terraform/child-module` at `preview`.
3. Skill pack; tests for lockfile evidence, multi-root refusal, moved-block gating.
4. Docs updates (including the honest validate-vs-apply distinction in README).
