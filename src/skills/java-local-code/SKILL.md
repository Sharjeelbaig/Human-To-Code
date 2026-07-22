---
name: java-local-code
description: Generate local Java consistent with types, nullability, generics, exceptions, resources, packages, and framework conventions. Use for .java, Java, classes, methods, streams, records, annotations, or compiler diagnostics.
---

# Java Local Code

- Preserve package, visibility, annotation, override, generic, and nullability contracts.
- Use existing domain types and collection interfaces; do not erase types or introduce raw collections.
- Handle checked exceptions through the established signature or translation layer; do not catch `Exception` merely to suppress it.
- Use try-with-resources for locally owned closeable resources.
- Keep stream pipelines readable, side-effect controlled, and null-safe; use direct control flow when it better expresses the local contract.
- Preserve equality/hash and record/value semantics; avoid accidental boxing or lossy conversions.
- Do not invent framework annotations, injection patterns, dependencies, or public overloads.

Return the exact expression, statement block, member, type, or file allowed at the marker.
