---
name: typescript-local-code
description: Generate locally scoped, strict TypeScript or TSX that fits existing declarations. Use for .ts, .tsx, TypeScript, interfaces, types, generics, unions, JSX, modules, or TypeScript compiler diagnostics.
---

# TypeScript Local Code

- Respect strict nullability, exact union members, generics, readonly/mutable contracts, and inferred return types.
- Narrow `unknown`, nullable, union, DOM, and caught values before use. Do not replace proof with `any`, unsafe assertions, `@ts-ignore`, or `@ts-expect-error`.
- Reuse existing interfaces/types and preserve named versus default exports and `import type` conventions.
- Keep promises awaited or deliberately returned; preserve `Promise<T>` and callback signatures.
- In TSX, distinguish JSX children from statements and components; use exact props and `className` contracts.
- Do not use browser, Node, or framework globals unless the project and target establish them.
- Let compiler diagnostics guide the smallest causal fix without widening public types.

Return only the fragment shape owned by the marker.
