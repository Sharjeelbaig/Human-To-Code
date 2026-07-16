# C# / .NET support plan

## Status today
Level 1: `LANGUAGE_PROFILES` has `csharp` (`.cs`), and `.cs` is scanned for
inline `// @human` markers. No grounded profile.

## Target profile
- `Ecosystem`: `dotnet`.
- Variants: `sdk-project` (single `.csproj`), `solution` (`.sln` with
  multiple projects), with ASP.NET Core detected as a framework signal.
- Versions: .NET 8 LTS+ (from `<TargetFramework>`).

## Detection signals (static only)
- `.sln` project references; `.csproj` `<TargetFramework>`, `<PackageReference>`,
  `<Nullable>`, `<ImplicitUsings>`.
- `Program.cs` minimal-hosting vs `Startup.cs` as entry-point signals;
  `*.Tests.csproj` for test roots. Never invoke `dotnet`.

## Version evidence
`packages.lock.json` when `RestorePackagesWithLockFile` is enabled gives
exact versions; otherwise `<PackageReference Version="...">` literals. Range
versions without a lockfile leave the dependency unproven for API grounding.

## Validation plan
- `["dotnet", "build", "--nologo"]`, `["dotnet", "test", "--nologo"]` against
  a preinstalled SDK image matching `<TargetFramework>`; NuGet restore needs
  either a no-network local cache or is `INCONCLUSIVE` (validation has no network).

## Skill pack
Nullable-reference-type discipline; DI via `IServiceCollection`; xUnit
conventions; `record` for DTOs; generated `obj/`/`bin/` and `*.Designer.cs`
protected.

## Risks & gates
Source generators/analyzers in project files, `unsafe` blocks, P/Invoke
(`DllImport`), and EF Core migrations are elevated-risk; migrations are
generated for review, never applied (existing invariant).

## Checklist
1. `Ecosystem` union + `analysis/adapters/dotnet.ts`.
2. `dotnet/sdk-project`, `dotnet/solution` at `preview`.
3. Register adapter; .NET skill pack.
4. Tests: solution/project graph ambiguity, lockfile vs floating versions, offline-restore behavior, stable fingerprints.
5. Docs updates.
