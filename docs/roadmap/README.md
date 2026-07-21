# Language & framework support roadmap

One file per language or framework we want to support. Each one is an
integration plan, not a promise about dates  -  items get built one at a time, and
a plan moves out of this folder once its profile actually ships.

## The four support levels

Support here is layered. "Supporting a language" means moving it up these
levels on purpose, one step at a time:

1. **Direct path** (`src/agents/direct/`)  -  the language has an entry in
   `LANGUAGE_PROFILES` (output extension plus prompt label) and, if it has an
   inline-comment form, its source extensions are in `SCANNED_EXTENSIONS` so
   `@human` markers get found. This path has pre-write syntax and structure
   checks, but no API grounding, no project build or test execution, no
   sandbox, and no `VERIFIED` status.
   *Today: TypeScript, JavaScript, Python, Rust, Go, Java, Ruby, C#, C++, C.*
2. **General fallback** (`src/analysis/adapters/general.ts`)  -  any declared
   language can flow through the converter ungrounded, permanently
   `INCONCLUSIVE`. Every language already has this. It's the floor, not a goal.
3. **Grounded profile**  -  a static `EcosystemAdapter` recognizes real projects,
   collects version evidence, and emits a validation plan, with the variant
   declared in the support matrix at `preview` tier. This is what every plan in
   this folder is describing.
4. **Certified**  -  the profile passes the benchmark gate in
   `src/providers/certification.ts` (>=25 tasks x 3 runs x >=95% strong-sandbox
   pass rate, per provider and model). Never self-declared.

## What every plan has to cover

The integration steps themselves are fixed by
[docs/SCALABILITY.md](../SCALABILITY.md#adding-an-ecosystem-django-spring-whatever).
Each plan just fills in the language-specific facts:

| Section | What it answers |
| --- | --- |
| Status today | Which level (1 or 2) the language is at right now. |
| Target profile | The `Ecosystem` name, its variants, and the version range for the support matrix. |
| Detection signals | Which manifests, lockfiles, and config the static adapter may read  -  never execute. |
| Version evidence | Where exact resolved versions come from (a lockfile, a manifest pin). |
| Validation plan | The candidate commands (as argv arrays) the sandbox would run: build, test, lint. |
| Skill pack | The conventions the `compiler-skills.ts` policy pack needs to encode. |
| Risks & gates | What counts as elevated risk or gets refused outright: codegen hooks, FFI, migrations, and so on. |
| Checklist | The mechanical steps in order, with their test obligations. |

Ground rules that apply to every plan, straight out of CONTRIBUTING.md's
invariants: analysis stays static and read-only; new variants start at
`preview`; support is declared in `support-matrix.ts` and never inferred;
ambiguity returns `NEEDS_INPUT` or `UNSUPPORTED` instead of guessing; and adding
an `Ecosystem` value is a schema-visible change that has to update
`analyzer-types.ts`, skills selection, and the certification profile keys
together.

## The plans

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
