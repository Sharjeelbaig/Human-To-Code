---
name: python-local-code
description: Generate local Python that respects indentation, typing, exceptions, async behavior, and project conventions. Use for .py, Python, functions, classes, comprehensions, context managers, type hints, or Python diagnostics.
---

# Python Local Code

- Match the marker’s indentation and enclosing sync/async, function, class, decorator, and comprehension grammar.
- Reuse existing names and type annotations; handle `None`, unions, iterators, mappings, and dataclasses according to evidenced types.
- Catch specific exceptions only when this scope can recover or add established context; preserve exception causes with `raise ... from ...` where appropriate.
- Use context managers for files, locks, transactions, and other resources.
- Await coroutines in async scopes and do not call blocking operations there unless project conventions explicitly handle them.
- Avoid mutable default arguments, broad `except`, wildcard imports, hidden global mutation, and unnecessary dependencies.
- Preserve iterator/lazy behavior unless the instruction requires materialization.

Emit only the suite, expression, declaration, or whole-file shape owned by the marker.
