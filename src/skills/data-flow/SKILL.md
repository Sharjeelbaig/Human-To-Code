---
name: data-flow
description: Preserve value provenance and transformations through local code. Use for mapping, filtering, parsing, validation, aggregation, serialization, normalization, assignment, pipelines, and values passed across calls.
---

# Data Flow

1. Identify each input’s source, representation, mutability, and trust level.
2. Apply transformations in the requested order without losing units, identifiers, precision, casing, or sentinel meaning.
3. Validate before consuming untrusted or structurally uncertain data.
4. Preserve collection ordering and duplicate semantics unless the instruction explicitly changes them.
5. Avoid mutating shared inputs when surrounding code expects value semantics; avoid needless copies when ownership is local.
6. Pass the transformed value—not an earlier similarly named value—to downstream calls and returns.
7. Keep serialization/deserialization symmetric with evidenced contracts.

Trace one representative value from its visible source through the replacement to its destination.
