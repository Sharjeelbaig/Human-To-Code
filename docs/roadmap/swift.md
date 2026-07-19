# Swift support plan

## Status today
Level 2 only: not in `LANGUAGE_PROFILES`; `.swift` not scanned for markers.

## Target profile
- `Ecosystem`: `swift`.
- Variants: `spm-package` (Package.swift) first. Xcode-project apps
  (`.xcodeproj`/`.xcworkspace`) are explicitly **out of scope** initially  - 
  pbxproj is too dynamic to analyze honestly; declare `UNSUPPORTED`.
- Versions: Swift ≥ 5.9 (from `// swift-tools-version:` header).

## Detection signals (static only)
- `Package.swift` tools-version comment line (parsed textually  -  the
  manifest itself is Swift code and must never be evaluated), `Package.resolved`,
  `Sources/`, `Tests/` layout.

## Version evidence
`Package.resolved` pins exact dependency versions; targets/products read
only from conservative literal parsing of `Package.swift`, refusing
computed manifests with `NEEDS_INPUT`.

## Validation plan
- `["swift", "build"]`, `["swift", "test"]` in a Swift toolchain image
  (Linux). Apple-platform-only packages (UIKit imports) are `INCONCLUSIVE`
  on a Linux sandbox  -  say so rather than skipping silently.

## Skill pack
Target/directory correspondence, XCTest conventions, access-control
(`public`/`internal`) discipline for library targets, `Package.resolved`
protected.

## Risks & gates
Manifest edits (executable code), macros/plugins (arbitrary build-time
code), and `@objc`/C interop are elevated-risk.

## Checklist
0. Add `swift` to `LANGUAGE_PROFILES` (`.swift`) and scan `.swift` for `// @human`.
1. `Ecosystem` union + `analysis/adapters/swift.ts`.
2. `swift/spm-package` at `preview`; Xcode variants declared unsupported.
3. Register adapter; Swift skill pack.
4. Tests: computed manifests refused, platform-gated packages, resolved-file absence, stable fingerprints.
5. Docs updates.
