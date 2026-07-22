---
name: css-accessibility
description: Style accessible interfaces with visible keyboard focus, readable contrast, usable targets, predictable states, and zoom-safe reflow. Use for accessibility, a11y, ARIA-related presentation, focus, keyboard, contrast, forms, or interactive controls.
---

# Accessible CSS

- Keep a persistent, clearly visible keyboard focus indicator. Prefer `:focus-visible`; never remove `outline` without an equal or stronger replacement.
- Do not rely on color alone for interactive or validation states. Preserve text, icon, shape, underline, or border cues.
- Maintain readable foreground/background contrast, including muted text, borders, focus rings, gradients, and hover states.
- Give controls comfortable hit areas and spacing; do not use tiny text links as the only action when the design calls for a button-like control.
- Preserve semantic visibility. Do not visually hide labels, headings, or content unless the task explicitly requires an accessible hiding technique.
- Do not create context changes on focus. Hover-only content must also be reachable through focus or another explicit control.
- Support zoom and reflow without clipped text, overlapping fixed UI, or hidden keyboard focus.
- Keep decorative layers `pointer-events: none` when they could cover controls.

Verify normal, hover, keyboard-focus, active, disabled, and error states that exist in the task.
