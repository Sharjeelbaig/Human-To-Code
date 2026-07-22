---
name: control-flow
description: Generate correct local branching, returns, loops, guards, fallbacks, matching, and state transitions. Use when instructions or code mention conditions, early returns, iteration, retry, switch/match, break, continue, or branching.
---

# Control Flow

- Put guards before the operation they protect and preserve required side-effect ordering.
- Ensure every reachable path satisfies the enclosing return, yield, callback, or error contract.
- Prefer direct guards over unnecessary nesting when project style permits it.
- Terminate loops and retries with evidenced bounds; never invent an unbounded retry.
- Preserve empty, boundary, and fallback cases implied by the instruction and types.
- Do not swallow a branch merely to satisfy syntax. Do not add unreachable code after a terminal statement.
- When state changes, make the allowed transition explicit and perform each side effect at most once unless repetition is requested.

Trace the normal path and each exceptional/empty path once before returning.
