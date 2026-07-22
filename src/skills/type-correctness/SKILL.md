---
name: type-correctness
description: Preserve and prove static or runtime type contracts in local generated code. Use when signatures, annotations, generics, unions, nullability, narrowing, schemas, compiler diagnostics, or typed data are present.
---

# Type Correctness

- Derive expected input, output, member, callback, and container types from surrounding declarations and project contracts.
- Narrow uncertain values using the language’s normal proof mechanism before member access or arithmetic.
- Handle null, none, optional, result, and missing-key states explicitly when the evidenced type permits them.
- Preserve generic relationships instead of collapsing values to universal types.
- Do not use unsafe casts, `any`, suppression comments, unchecked assertions, or equivalent escape hatches to silence uncertainty.
- Match mutability, ownership, variance, async return shape, and error channel already established by the enclosing API.
- When repairing a diagnostic, fix its cause rather than widening the public contract.

Every value crossing the replacement boundary must remain assignable to the existing contract.
