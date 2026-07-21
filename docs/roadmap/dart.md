# Dart / Flutter support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`; `.dart` not scanned for markers.

## Target profile
- `Ecosystem`: `dart`.
- Variants: `package` (pure Dart), `flutter-app` (validation limited to
  `flutter test` unit/widget tests  -  no device/emulator).
- Versions: Dart >= 3.0 (from `environment.sdk` in `pubspec.yaml`).

## Detection signals (static only)
- `pubspec.yaml` (`environment`, `dependencies`, `flutter:` section),
  `pubspec.lock`, `lib/`, `test/`, `analysis_options.yaml`. The `flutter`
  SDK dependency distinguishes the variants. Never run `dart`/`flutter` CLIs.

## Version evidence
`pubspec.lock` is exact and required for grounding; caret ranges in
`pubspec.yaml` alone are unproven.

## Validation plan
- `["dart", "analyze"]` + `["dart", "test"]`, or `["flutter", "test"]` for
  the flutter variant, in an image with the SDK and a primed pub cache
  (sandbox has no network for `pub get`).

## Skill pack
Effective-Dart naming/layout, null-safety, widget test conventions,
`build_runner` outputs (`*.g.dart`, `*.freezed.dart`) protected as
generated files.

## Risks & gates
`build_runner` codegen (never run by the tool; generated files protected),
platform channels/FFI, and Flutter platform folders (`android/`, `ios/`)
which follow their own ecosystems' rules  -  treat as prohibited paths
initially.

## Checklist
0. Add `dart` to `LANGUAGE_PROFILES` (`.dart`) and scan `.dart` for `// @human`.
1. `Ecosystem` union + `analysis/adapters/dart.ts`.
2. `dart/package`, `dart/flutter-app` at `preview`.
3. Register adapter; Dart/Flutter skill pack.
4. Tests: lock absence, flutter vs pure-dart, generated-file protection, stable fingerprints.
5. Docs updates.
