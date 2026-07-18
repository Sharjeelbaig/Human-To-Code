# Language & framework support roadmap

One file per language/framework we intend to support. Each file is an
integration plan, not a promise of a date — items are implemented one by one,
and a plan graduates out of this folder when its profile ships.

## The four support levels

Support in human-to-code is layered; "supporting a language" means moving it
up this ladder deliberately:

1. **Direct path** (`src/agents/direct/`) — the language has an entry in
   `LANGUAGE_PROFILES` (output extension + prompt label) and, if it has an
   inline-comment form, its source extensions are in `SCANNED_EXTENSIONS` for
   `@human` markers. No grounding, no validation; receipt-and-confirm only.
   *Today: TypeScript, JavaScript, Python, Rust, Go, Java, Ruby, C#, C++, C.*
2. **General fallback** (`src/analysis/adapters/general.ts`) — any declared
   language can flow through the guided pipeline ungrounded, permanently
   `INCONCLUSIVE`. This exists for every language already; it is the floor,
   not a goal.
3. **Grounded profile** — a static `EcosystemAdapter` recognizes real
   projects, collects version evidence, and emits a validation plan; the
   variant is declared in the support matrix at `preview` tier. This is what
   each plan in this folder describes.
4. **Certified** — the profile passes the benchmark gate in
   `src/providers/certification.ts` (≥25 tasks × 3 runs × ≥95% strong-sandbox
   pass rate per provider/model). Never self-declared.

## What every plan must cover

The integration steps are fixed by [docs/SCALABILITY.md](../SCALABILITY.md#adding-an-ecosystem-eg-django-spring);
each plan fills in the language-specific facts:

| Section | It answers |
| --- | --- |
| Status today | Which level (1/2) the language sits at right now. |
| Target profile | The `Ecosystem` name, variants, and version range for the support matrix. |
| Detection signals | Manifests/lockfiles/config the static adapter may read — never execute. |
| Version evidence | Where exact resolved versions come from (lockfile, manifest pin). |
| Validation plan | Candidate commands (argv arrays) the sandbox would run — build, test, lint. |
| Skill pack | Conventions the `compiler-skills.ts` policy pack must encode. |
| Risks & gates | What must be treated as elevated risk or refused (codegen hooks, FFI, migrations…). |
| Checklist | The mechanical steps, in order, with test obligations. |

Ground rules that apply to every plan (from CONTRIBUTING.md's invariants):
analysis stays static and read-only; new variants start at `preview`; support
is declared in `support-matrix.ts`, never inferred; ambiguity returns
`NEEDS_INPUT`/`UNSUPPORTED` rather than guessing; adding an `Ecosystem` value
is a schema-visible change and updates `analyzer-types.ts`, skills selection,
and the certification profile keys together.

## Plans

| Plan | Kind | Sits at level | Target |
| --- | --- | --- | --- |
| [go.md](go.md) | language | 1 (direct path) | Go modules ecosystem |
| [java.md](java.md) | language | 1 (direct path) | Maven/Gradle ecosystem |
| [csharp.md](csharp.md) | language | 1 (direct path) | .NET SDK ecosystem |
| [ruby.md](ruby.md) | language | 1 (direct path) | Bundler/Rails ecosystem |
| [php.md](php.md) | language | 2 (general only) | Composer/Laravel ecosystem |
| [swift.md](swift.md) | language | 2 (general only) | SwiftPM ecosystem |
| [kotlin.md](kotlin.md) | language | 2 (general only) | Gradle/Android ecosystem |
| [dart.md](dart.md) | language | 2 (general only) | Pub/Flutter ecosystem |
| [bash.md](bash.md) | language | 2 (general only) | Shell-script profile |
| [sql.md](sql.md) | language | 2 (general only) | Migration-aware SQL profile |
| [yaml.md](yaml.md) | config | 2 (general only) | Schema-validated config profile |
| [html-css.md](html-css.md) | language | 2 (general only) | Static web profile |
| [docker.md](docker.md) | infra | 2 (general only) | Dockerfile/Compose profile |
| [terraform.md](terraform.md) | infra | 2 (general only) | Terraform/HCL profile |
