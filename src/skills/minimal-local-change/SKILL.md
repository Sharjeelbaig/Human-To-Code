---
name: minimal-local-change
description: Keep human-to-code replacements narrowly scoped and behaviorally complete. Use for every direct coding or repair request, especially inline markers and existing files.
---

# Minimal Local Change

Make the smallest coherent replacement that fully implements the local instruction.

- Preserve unrelated behavior, public names, formatting conventions, comments, ordering, and surrounding structure.
- Reuse existing helpers and abstractions before creating new ones.
- Do not add dependencies, layers, configuration, files, speculative extensibility, or broad refactors for local behavior.
- Do not rename or reorganize nearby code merely to improve taste.
- Avoid duplicate compatibility aliases, dead branches, placeholder implementations, and comments that restate obvious code.
- A minimal change must still be complete: include required cleanup, error propagation, state update, or return behavior when the instruction necessarily implies it.
- During repair, correct the diagnosed contract and retain everything else that already works.

If removing any emitted line would preserve the requested behavior and validity, remove it.
