# Security Policy

`human-to-code` reads natural-language files and produces source code that people run, so it treats security as a first-class concern.

## The security model

- **The LLM can only produce the strict IR, never code directly.** Turning the IR into code is deterministic. A malicious `.human` file can, at worst, produce malicious *strict*, which is a small, constrained, reviewable artifact — not freeform code.
- **The strict grammar has no raw-code escape hatch.** This is what keeps the review step meaningful; see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Secrets never reach a provider.** `secrets.human` and git-ignored files are excluded from any prompt context, and the tool refuses to run if `secrets.human` is git-tracked. Prefer environment variables or your OS keychain for credentials.
- **Filesystem safety.** Discovery never follows symlinks and stays within the project root.
- **Endpoints must use TLS.** A custom provider `baseUrl` must be `https://`.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public issue.

- Use [GitHub private security advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository, **or**
- email the maintainers (add a contact address here before publishing).

We'll acknowledge your report, investigate, and coordinate a fix and disclosure timeline with you.
