# Java support plan

## Status today
Level 1: `LANGUAGE_PROFILES` has `java` (`.java`), and `.java` is scanned for
inline `// @human` markers. No grounded profile.

## Target profile
- `Ecosystem`: `java`.
- Variants: `maven` (`pom.xml`) and `gradle` (`build.gradle`/`.kts`,
  `settings.gradle`), with Spring Boot recorded as a framework signal first
  and promoted to its own variant once the adapter proves reliable.
- Versions: JDK 17+ (from `maven.compiler.release` / Gradle toolchain block).

## Detection signals (static only)
- `pom.xml` parent/modules for Maven multi-module ownership.
- `settings.gradle(.kts)` `include(...)` for Gradle subprojects  -  parsed
  textually and conservatively; unresolvable dynamic includes -> `NEEDS_INPUT`.
- `src/main/java`, `src/test/java` for source/test roots; `@SpringBootApplication`
  as an entry-point signal. Never execute Maven/Gradle.

## Version evidence
Maven: exact `<version>` pins in `pom.xml` (property-indirected versions
resolved only when the property is a literal in the same reactor).
Gradle: version catalogs (`gradle/libs.versions.toml`) and lockfiles
(`gradle.lockfile`) when present; otherwise the dependency is unproven and
API grounding for it must refuse.

## Validation plan
- Maven: `["mvn", "-B", "-q", "verify"]`. Gradle: `["./gradlew", "--no-daemon", "build"]`
  only when the wrapper exists (wrapper jars are arbitrary code  -  sandbox only).
- JDK image recorded by version; mismatch is `INCONCLUSIVE`.

## Skill pack
Package/directory correspondence; constructor injection over field injection
(Spring); JUnit 5 conventions; no reflection-based config edits; generated
sources under `target/`/`build/` are protected.

## Risks & gates
Annotation processors, Gradle build-script edits, `module-info.java`
changes, and dependency additions are elevated-risk; build scripts are
executable code and must never be model-editable.

## Checklist
1. `Ecosystem` union + `analysis/adapters/java.ts`.
2. `java/maven`, `java/gradle` at `preview` in `support-matrix.ts`.
3. Register adapter; Java/Spring skill pack.
4. Adversarial tests: multi-module reactors, dynamic Gradle includes, version properties, wrapper absence, stable fingerprints.
5. Docs updates (MODULES.md, README support matrix).
