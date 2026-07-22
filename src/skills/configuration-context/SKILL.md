---
name: configuration-context
description: Edit configuration and manifest fragments without changing unrelated policy. Use for JSON, YAML, TOML, XML, INI, environment templates, package manifests, compiler options, CI, build, deployment, or config files.
---

# Configuration Context

- Preserve the detected format, schema version, key casing, nesting, comments when supported, and ordering convention.
- Emit the exact grammatical fragment owned by the marker: value, property, list item, mapping entry, section, or whole document.
- Reuse established environment-variable names and interpolation syntax; never insert actual secrets.
- Do not change unrelated defaults, scripts, permissions, network access, versions, or validation policy.
- Add dependencies/plugins only when the instruction explicitly requires them and project evidence supports the ecosystem.
- Keep JSON free of comments/trailing commas; respect YAML indentation and scalar types; preserve TOML table ownership.

Configuration is executable policy: make only the requested local change.
