---
name: rust-local-code
description: Generate local Rust that satisfies ownership, borrowing, lifetimes, traits, Result/Option, and module contracts. Use for .rs, Rust, Cargo projects, impl blocks, matches, traits, async Rust, or compiler diagnostics.
---

# Rust Local Code

- Respect ownership and borrowing established by the signature; borrow rather than clone unless ownership must change.
- Propagate `Result` with `?` when compatible and handle `Option`/`Result` exhaustively without `unwrap` or `expect` unless an invariant is explicitly proved.
- Preserve lifetimes, trait bounds, mutability, visibility, module paths, and concrete error types.
- Use `match`, `if let`, iterators, and conversions that make state handling explicit and type-correct.
- Do not introduce `unsafe`, global mutable state, blocking work in async code, or needless allocation.
- Keep guards/locks and borrows scoped so they do not cross await points or conflict with later access.
- Repair the compiler’s ownership/type cause rather than adding clones or broad conversions blindly.

Return the exact expression, statement, item, impl member, or file required at the marker.
