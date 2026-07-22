---
name: security-sensitive-code
description: Apply safe local implementation rules when code touches authentication, authorization, secrets, user input, paths, commands, HTML, SQL, network destinations, cryptography, uploads, permissions, or sensitive data.
---

# Security-Sensitive Code

- Validate at trust boundaries and encode/parameterize for the actual destination context.
- Enforce authorization on the protected operation, not only in presentation code.
- Never hard-code, log, return, persist, or interpolate credentials and secret values.
- Use established cryptographic/password/token libraries and project parameters; never design custom cryptography.
- Confine file paths, redirects, URLs, commands, and subprocess arguments to evidenced safe policies.
- Prefer argument arrays and safe APIs over shell construction; never use `eval` for data.
- Preserve least privilege, safe defaults, constant-time comparisons where required, and generic external authentication errors.
- Do not weaken validation, TLS, sandboxing, permissions, or security controls to make the marker pass.

When the requested behavior conflicts with an established security boundary, preserve the boundary.
