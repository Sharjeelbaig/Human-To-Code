# Security policy

human-to-code reads repositories an attacker may control and can send selected
context to a configured model provider. Treat generated code as untrusted until
you have reviewed it.

The default configuration uses loopback-local Ollama. Remote generation stays
blocked until `privacy.remoteProviderConsent` is enabled in
`human-to-code.config.json`. Credentials belong in environment variables.
Configuration stores the environment variable name, never the credential.

The converter does not follow symlinks during discovery. It excludes ignored and
protected paths, scans model-bound context for credential-shaped values, checks
that source bytes have not changed, and validates generated candidates before
writing them. Whole-file outputs use a rollback-protected batch. Inline changes
use exact stale-byte checks and per-marker isolation.

The direct converter does not run project code, builds, tests, package managers,
or implicit downloaders. TypeScript and opted-in JavaScript receive static
compiler checks. Other supported languages receive deterministic structural
checks. These checks are not proof of runtime correctness.

To report a vulnerability, use the
[private GitHub security advisory form](https://github.com/sharjeelbaig/human-to-code/security/advisories/new).
