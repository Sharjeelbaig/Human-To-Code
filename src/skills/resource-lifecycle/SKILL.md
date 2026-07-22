---
name: resource-lifecycle
description: Acquire, use, and release resources safely in local code. Use for files, streams, sockets, database connections, transactions, locks, processes, temporary paths, handles, contexts, or disposable objects.
---

# Resource Lifecycle

- Acquire as late as practical and release at the smallest scope that owns the resource.
- Use the language’s structured cleanup construct: context manager, `using`, try-with-resources, `defer`, RAII, or `finally`.
- Release on normal completion, exceptions/errors, cancellation, and early return.
- Commit transactions only after all required work succeeds; roll back or allow structured rollback on failure.
- Close the correct layer without prematurely closing borrowed/shared resources.
- Do not leak locks across callbacks or blocking operations; preserve established lock ordering.
- Create temporary files/directories with safe APIs and remove only exact owned paths.

Do not introduce global resource ownership for behavior local to the marker.
