---
name: scope-symbol-contracts
description: Reuse exact visible symbols and respect lexical scope around a human marker. Use for inline code, functions, methods, classes, callbacks, imports, declarations, return types, and repairs involving existing names.
---

# Scope and Symbol Contracts

Treat names and scope as an existing API.

1. Inventory visible parameters, locals, members, imports, helpers, types, labels, and earlier generated declarations from supplied evidence.
2. Reuse exact spellings and qualified access patterns. Do not substitute plausible names such as `response` for evidenced `res`.
3. Introduce a binding only when the requested behavior needs it and no suitable binding already exists.
4. Never redeclare, shadow, duplicate, or re-output a FileMemory declaration. Respect block, closure, module, class, and package visibility.
5. Match the enclosing return/yield/throw contract and callback shape. A local branch must still let every path satisfy that contract.
6. Do not invent imports, exports, members, overloads, or dependencies. Whole-file code may add only relationships justified by project evidence.

Before returning, resolve every referenced identifier to supplied evidence or to a declaration created inside this replacement.
