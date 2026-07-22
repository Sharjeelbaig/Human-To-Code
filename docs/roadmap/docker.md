# Docker / containerfile support plan

## Status today
Level 2 only. Note the tool already *consumes* Docker/Podman as its
validation sandbox (`src/tools/validation/sandbox-validation.ts`); this plan is about
generating and editing Dockerfiles/Compose files as change targets.

## Target profile
- `Ecosystem`: `container`.
- Variants: `dockerfile` (Dockerfile/Containerfile present),
  `compose` (`compose.yaml`/`docker-compose.yml`), usually attached as a
  secondary workspace signal to the ecosystem that owns the app.
- Versions: Compose schema version; base-image tags/digests as evidence.

## Detection signals (static only)
- `Dockerfile*`, `Containerfile`, `compose*.y(a)ml`, `.dockerignore`;
  `FROM` lines (stage graph), `COPY --from` references  -  all textual.

## Version evidence
Base images pinned by digest are proven; tag-only `FROM` lines are recorded
as unpinned evidence and the skill pack pushes toward digests. Compose
`image:` entries likewise.

## Validation plan
- `["hadolint", "Dockerfile"]` lint in the sandbox image;
  `["docker", "compose", "config", "-q"]` for Compose syntax (offline,
  no engine calls beyond config parsing). An actual `docker build` is
  arbitrary remote-fetching execution  -  out of scope for validation; at
  most a later opt-in tier with a network-off buildkit and preloaded bases.

## Skill pack
Multi-stage builds, non-root `USER`, explicit `WORKDIR`, no secrets in
layers/ARGs (aligns with the secret scanner), `.dockerignore` completeness,
healthchecks, digest pinning.

## Risks & gates
`FROM` changes, new `RUN curl | sh` patterns (refuse  -  matches the
implicit-downloader rejection), privileged/host-mount Compose options, and
port/secret exposure are elevated-risk requiring contract authorization.

## Checklist
1. `Ecosystem` union + `tools/analysis/adapters/container.ts`.
2. `container/dockerfile`, `container/compose` at `preview`.
3. Skill pack; patch-policy tests for RUN-pattern and privilege gating.
4. Tests: multi-stage graphs, digest vs tag evidence, compose schema versions.
5. Docs updates.
