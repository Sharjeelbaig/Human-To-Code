---
name: error-handling
description: Implement local failure behavior consistent with the surrounding code. Use for errors, exceptions, results, rejected promises, fallbacks, retries, timeouts, parsing, I/O, validation failures, and repair diagnostics.
---

# Error Handling

- Follow the existing error channel: throw, return `Result`, error value, rejected promise, status response, or local fallback.
- Catch only when this scope can add context, translate to an established error, recover, or guarantee cleanup.
- Preserve the original cause where the language and project convention support it.
- Never silently swallow failures, return fabricated success, expose secrets, or replace a precise error with a generic one without evidence.
- Retry only transient operations, only when requested or established, and with a bounded attempt/timeout policy.
- Keep user-facing messages safe and stable; keep diagnostic detail in the project’s logging/error mechanism.
- Cleanup must run on success, failure, cancellation, and early return.

Do not invent a new global error architecture inside a local marker.
