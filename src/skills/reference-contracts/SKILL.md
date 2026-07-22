---
name: reference-contracts
description: Keep local references identical to real project artifacts. Use for imports, exports, includes, calls, selectors, routes, templates, assets, configuration keys, symbols, module paths, packages, namespaces, and cross-file repairs.
---

# Reference Contracts

- Copy evidenced paths, names, casing, separators, extensions, exports, signatures, selectors, ids, routes, and configuration keys exactly.
- Use the supplied relative reference from the current target; do not recalculate from an imagined directory.
- Reference only companions whose relationship is real for this target.
- Match named/default import style, namespace/package convention, visibility, arity, and argument ordering.
- Never invent a missing file, dependency, symbol, route, selector, or asset to make code appear complete.
- During repair, change the incorrect side to the already evidenced contract; do not add duplicate aliases merely to hide drift.

Resolve every external reference against ProjectMemory, FileMemory, the shared contract, or the current source.
