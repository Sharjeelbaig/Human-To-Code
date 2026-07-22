---
name: javascript-local-code
description: Generate locally scoped JavaScript or JSX consistent with the project runtime and module system. Use for .js, .jsx, .mjs, .cjs, JavaScript, DOM, Node.js, browser scripts, or JSDoc-typed JavaScript.
---

# JavaScript Local Code

- Follow the existing ESM/CommonJS, browser/Node, strict-mode, semicolon, and JSDoc conventions.
- Guard runtime uncertainty at real boundaries; do not assume queried DOM nodes, parsed input, optional fields, or external responses exist.
- Preserve promise ownership: await/return meaningful work and route rejection through the established error path.
- Reuse existing bindings and helpers; avoid accidental globals, prototype mutation, and shadowed names.
- In JSX, emit the exact child/expression/component shape requested and preserve prop/class contracts.
- Do not introduce TypeScript syntax into JavaScript or rewrite working JavaScript solely for type-checker preferences.
- Prefer native/project APIs over new dependencies for local behavior.

Keep the replacement valid in the project’s actual runtime target.
