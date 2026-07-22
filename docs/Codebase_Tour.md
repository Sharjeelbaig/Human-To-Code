# Codebase tour

Human-to-Code is arranged like an agent: it understands the request, remembers
the project, talks to a model, checks the answer, and only then changes files.
The folder names describe those responsibilities directly.

## The flow at a glance

1. `src/cli.ts` reads command-line options and starts a run.
2. `src/config/` loads configuration and finds `.human` sources.
3. `src/tools/discovery/` turns files and inline `@human` comments into
   conversion units.
4. `src/memory/` builds safe, bounded FileMemory and ProjectMemory for each
   unit.
5. `src/workflows/` plans and sequences generation, repair, and integration
   work.
6. `src/llms/` sends structured requests through the selected model provider.
7. `src/tools/validation/` and `src/tools/security/` reject unsafe or invalid
   candidates.
8. `src/tools/file-ops/` applies an accepted candidate with stale-write and
   rollback protection.

For example, `npx human-to-code . --yes` starts in `cli.ts`, discovers a marker
with `tools/discovery`, gives its provider a prompt assembled by a workflow,
validates the returned code, and finally uses `tools/file-ops` to replace the
marker.

## Folder responsibilities

### `src/core/`

The stable foundation: shared types, artifact contracts, hashing helpers, and
the extension-to-language map. Core modules do not know how a workflow is run.

### `src/config/`

Configuration loading, validation, and safe `.human` source discovery. This is
where a missing or unsafe configuration value is rejected before generation.

### `src/llms/`

Provider-neutral request contracts, OpenAI and Ollama adapters, structured
output schemas, and the certification gate. Provider code transports requests;
it does not decide which files should be generated.

### `src/prompts/`

Pure prompt builders for conversion, planning, todos, integration checks,
repair, and provider output. Keeping prompts separate makes model-facing
instructions reviewable without reading network code.

### `src/memory/`

Safe project context, official-documentation retrieval, compiler knowledge,
per-file declarations, static file summaries, and project-wide relationships.
Memory is rebuilt from repository evidence and is bounded before it reaches a
model.

### `src/tools/`

Capabilities a workflow calls:

- `analysis/` recognizes ecosystems and validation commands without executing
  project code.
- `discovery/` finds conversion units, parses markers, and infers languages.
- `validation/` performs syntax, compiler, reference, integration, and sandbox
  checks.
- `security/` scans secrets and pins outbound HTTP destinations.
- `file-ops/` prepares patches, snapshots state, replaces markers, and writes
  accepted output.

Tools answer focused questions or perform focused operations. They do not own
the end-to-end sequence.

### `src/workflows/`

The orchestration layer. It defines conversion units and sequences planning,
generation, repair, integration reconciliation, presentation, run storage, and
change-contract creation.

### `src/index.ts` and `src/cli.ts`

`src/index.ts` is the stable library barrel. Consumers continue to import the
same names from `human-to-code`; internal folder names are not part of that
contract. `src/cli.ts` is the terminal-facing shell over the same capabilities.

## Where a new change belongs

- Add a provider or transport rule under `llms/`.
- Add repository knowledge or context selection under `memory/`.
- Add a focused inspection, validation, security, or write capability under
  `tools/`.
- Add sequencing, retries, planning, or multi-step policy under `workflows/`.
- Add a model instruction under `prompts/`.
- Add a shared versioned contract under `core/`.

Each major folder has a local `README.md` with its dependency boundaries and a
practical example.
