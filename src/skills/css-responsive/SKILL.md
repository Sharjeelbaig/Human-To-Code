---
name: css-responsive
description: Create mobile-friendly, fluid CSS with media queries, container-aware layouts, viewport handling, and accessible reflow. Use for responsive, adaptive, mobile, breakpoint, media-query, viewport, or reflow requirements.
---

# Responsive CSS

- Start with a usable narrow layout, then add breakpoints where content actually stops fitting.
- Prefer flexible widths, wrapping, `min()`, `max()`, `clamp()`, and Grid/Flex intrinsic sizing over device-specific dimensions.
- Use relative units for breakpoint lengths when text-size changes should affect reflow.
- Ensure vertically scrolling pages reflow near 320 CSS pixels without routine two-dimensional scrolling.
- Allow navigation, button groups, cards, long links, and technology tags to wrap or stack with visible separation.
- Avoid `100vw` for ordinary full-width blocks when scrollbar width could create horizontal overflow.
- Do not reduce text to preserve a desktop composition. Change the composition.
- Keep fixed or sticky UI from obscuring headings, anchors, and keyboard focus; add appropriate scroll offset when needed.

Check narrow, intermediate, and wide states. Every breakpoint must solve an observed layout need and preserve all content and actions.
