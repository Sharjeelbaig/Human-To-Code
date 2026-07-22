---
name: react-css-integration
description: Connect React JSX/TSX markup to plain CSS using exact className contracts and existing stylesheet imports. Use for React components with CSS, className, stylesheet imports, shared selectors, or CSS/JSX integration repairs.
---

# React CSS Integration

- Use `className` for static CSS classes and reserve the `style` prop for values that are genuinely data-dependent.
- Copy shared class and id names exactly from SHARED_CONTRACT and PROJECT_MEMORY.
- Follow the task's requested prefix and the project's existing naming convention. Do not independently rename the CSS-facing API inside one component.
- Ensure the stylesheet is imported exactly once through the evidenced project entry or component convention; never invent a package or CSS-module setup.
- Keep semantic elements and accessible names independent of styling wrappers.
- When mapping data, use stable domain keys when available; do not use an array index merely to satisfy React.
- For external links opened in a new tab, preserve the project's safe `rel` convention and give links meaningful accessible text or names.
- Do not import `React` solely for JSX when the detected toolchain uses the automatic JSX runtime.

Before returning, compare every emitted `className` and stylesheet path against the exact cross-file contract.
