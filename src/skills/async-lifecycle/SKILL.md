---
name: async-lifecycle
description: Keep asynchronous local code awaited, cancellable, ordered, and lifecycle-safe. Use for async, await, promises, futures, tasks, streams, timers, subscriptions, effects, callbacks, workers, queues, or concurrent operations.
---

# Async Lifecycle

- Preserve the enclosing async return shape and await work whose completion or failure affects the result.
- Do not create fire-and-forget work unless the existing API explicitly owns and observes it.
- Propagate available cancellation, context, abort, deadline, or shutdown signals.
- Register cleanup before work can fail; cancel timers, listeners, subscriptions, streams, and tasks at the owning lifecycle boundary.
- Maintain required operation order. Use concurrency only for independent work and preserve output ordering when the contract requires it.
- Route asynchronous failures through the established error channel; never leave unhandled rejections or detached task failures.
- Avoid updates after disposal, unmount, closed channels, or completed requests.

Identify who owns the asynchronous work and exactly when that ownership ends.
