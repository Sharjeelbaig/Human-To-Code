---
name: csharp-local-code
description: Generate local C# that respects nullable references, async Tasks, LINQ, disposal, namespaces, and .NET conventions. Use for .cs, C#, .NET, classes, methods, records, LINQ, async/await, or compiler diagnostics.
---

# C# Local Code

- Preserve nullable-reference annotations, generic constraints, accessibility, records/value semantics, and existing namespace style.
- Return/await the established `Task`, `Task<T>`, `ValueTask`, or synchronous shape; avoid `async void` except evidenced event handlers.
- Propagate available `CancellationToken` and do not substitute `CancellationToken.None` inside cancellable work.
- Use `using`/`await using` for locally owned disposable resources.
- Keep LINQ evaluation count and deferred execution intentional; avoid repeated enumeration and hidden side effects.
- Handle exceptions at the established boundary and preserve inner causes; do not suppress with empty catches or null-forgiving operators.
- Do not invent DI registrations, attributes, packages, or public members.

Emit only the fragment or file shape owned by the marker.
