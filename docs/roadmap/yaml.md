# YAML config support plan

## Status today
Level 2 only. YAML is not a programming language here  -  the meaningful
target is *schema-validated configuration editing* (CI workflows, K8s
manifests, app config), where correctness is checkable without execution.

## Target profile
- `Ecosystem`: `yaml-config`.
- Variants by proven schema family: `github-actions`
  (`.github/workflows/*.yml`), `kubernetes` (apiVersion/kind docs),
  `generic` (only when a JSON Schema is discoverable via
  `# yaml-language-server: $schema=` or operator config).
- Unschema'd YAML stays on the general fallback  -  there is nothing to
  validate, so nothing to profile.

## Detection signals (static only)
- Path conventions (`.github/workflows/`), `apiVersion`/`kind` keys,
  explicit `$schema` pragmas, `kustomization.yaml`.

## Version evidence
The schema is the "dependency": pin the schema source (bundled
GitHub-Actions/K8s schemas shipped as immutable package data, like compiler
skills) and record which schema+version validated the patch.

## Validation plan
- Offline schema validation in-process or via a bundled validator; K8s:
  `["kubeconform", "-strict", "<files>"]` with schemas preloaded in the
  image. Never `kubectl apply`.

## Skill pack
Anchors/aliases used sparingly, no duplicate keys, quoting rules for
booleans/versions (Norway problem), GitHub Actions pinning conventions
(action SHAs), K8s resource limits present.

## Risks & gates
CI workflow edits are supply-chain-sensitive: adding `run:` steps, changing
action refs, or touching secrets contexts is elevated-risk and needs
explicit contract authorization. Secrets scanning already covers values;
the skill pack must also forbid *referencing* new secret names silently.

## Checklist
1. `Ecosystem` union + `analysis/adapters/yaml-config.ts`.
2. Variants at `preview`; bundle schema data as frozen package assets.
3. Skill pack; patch-policy tests for workflow-edit gating.
4. Tests: schema discovery, multi-doc files, duplicate keys, unschema'd refusal.
5. Docs updates.
