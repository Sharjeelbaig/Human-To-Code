---
name: css-foundations
description: Create complete, maintainable CSS foundations. Use for CSS files, resets, themes, global styles, design tokens, typography, visual styling, or complete stylesheet generation.
---

# CSS Foundations

Produce a coherent stylesheet, not isolated declarations.

- Inventory the target's required selectors and states before writing rules.
- Start with low-specificity defaults: `box-sizing`, document/body defaults, inherited typography, responsive media, and control font inheritance when the task calls for global CSS.
- Prefer custom properties for repeated colors, spacing, radii, shadows, and type values; keep fallbacks concrete.
- Preserve native behavior. Do not erase list markers, focus outlines, link affordances, overflow, or control appearance unless the replacement is explicit and usable.
- Use logical, fluid sizing where it improves reflow. Avoid unexplained fixed heights and magic offsets.
- Keep selector specificity shallow and consistent. Use `!important` only for an unavoidable external override or a narrowly scoped reduced-motion safety rule.
- Finish complete rule bodies and balanced at-rules. Never emit preprocessor syntax into plain CSS.

Before returning, check that the stylesheet covers the requested visual hierarchy, interactive states, narrow viewport behavior, and every exact selector supplied by project evidence.
