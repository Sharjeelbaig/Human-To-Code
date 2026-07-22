---
name: go-local-code
description: Generate local Go that follows package, error, context, interface, goroutine, and resource conventions. Use for .go, Go, functions, methods, interfaces, channels, goroutines, context.Context, or Go diagnostics.
---

# Go Local Code

- Follow the existing package, import grouping, receiver naming, exported-name, and error-wrapping conventions.
- Check errors immediately unless the surrounding API intentionally aggregates them; wrap with useful operation context and preserve the cause.
- Propagate `context.Context` already available instead of creating a background context inside request work.
- Use `defer` only after successful acquisition and at a scope where delayed cleanup is timely.
- Start goroutines only with explicit ownership, cancellation, error observation, and termination; avoid leaks and unsynchronized shared state.
- Distinguish nil and empty slices/maps only when the established contract does.
- Satisfy interfaces structurally without adding unrelated methods or dependencies.

Keep the replacement idiomatic but subordinate to existing project contracts.
