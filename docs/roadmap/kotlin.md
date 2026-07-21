# Kotlin support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`; `.kt` not scanned for markers.

## Target profile
- `Ecosystem`: `kotlin` (JVM/Gradle first; Android later as its own variant
  because of SDK/emulator validation constraints).
- Variants: `gradle-jvm`, then `android` (deferred until a headless
  validation story exists  -  unit tests only, no instrumented tests).
- Versions: Kotlin >= 1.9 (from the Kotlin Gradle plugin version in the
  version catalog or build script literals).

## Detection signals (static only)
- `build.gradle.kts` with `kotlin("jvm")`/`org.jetbrains.kotlin` plugin
  (textual, conservative), `gradle/libs.versions.toml`,
  `src/main/kotlin`, `src/test/kotlin`; `AndroidManifest.xml` marks the
  android variant. Never execute Gradle.

## Version evidence
Version catalogs and `gradle.lockfile` when present; literal plugin/dependency
versions otherwise. Dynamic version expressions leave deps unproven.

## Validation plan
- `["./gradlew", "--no-daemon", "test"]` (wrapper = arbitrary code, sandbox
  only, deps preinstalled/cached offline). Android: `testDebugUnitTest` only.

## Skill pack
Null-safety idioms, data classes, coroutines conventions (structured
concurrency, no `GlobalScope`), JUnit5/Kotest layout, `build/` and generated
KSP/KAPT output protected.

## Risks & gates
KSP/KAPT processors, Gradle script edits, multiplatform targets, and JNI are
elevated-risk. Shares most gates with the Java plan  -  build one Gradle
inventory helper both adapters reuse (`analyzer-utils.ts` addition).

## Checklist
0. Add `kotlin` to `LANGUAGE_PROFILES` (`.kt`) and scan `.kt`/`.kts` for `// @human`.
1. `Ecosystem` union + `analysis/adapters/kotlin.ts` (shared Gradle helpers with java.md's adapter).
2. `kotlin/gradle-jvm` at `preview`; `kotlin/android` deferred and documented.
3. Register adapter; Kotlin skill pack.
4. Tests: catalog vs literal versions, multiplatform refusal, Android detection, stable fingerprints.
5. Docs updates.
