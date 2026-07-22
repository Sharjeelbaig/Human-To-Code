---
name: shell-local-code
description: Generate local shell code with correct quoting, process, path, pipeline, and cleanup behavior. Use for .sh, Bash, POSIX shell, zsh, command scripts, pipelines, subprocesses, or shell diagnostics.
---

# Shell Local Code

- Follow the file’s declared shell and use only features supported by that dialect.
- Quote parameter expansions and paths; use arrays in shells that support them when arguments must remain separate.
- Prefer direct commands with argument boundaries over `eval`, constructed shell strings, or nested command interpretation.
- Preserve and check meaningful exit statuses, including pipeline behavior established by the script.
- Validate exact destructive targets and avoid broad globs, unresolved variables, home-directory aliases, or root-like paths.
- Create temporary resources safely and install cleanup that runs on success, failure, and signals when ownership requires it.
- Do not print secrets, enable tracing around credentials, download/execute unpinned content, or change global shell options from a local marker without explicit instruction.

Emit only commands valid at the marker’s current shell grammar position.
