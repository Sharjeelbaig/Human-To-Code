---
name: css-layout
description: Build resilient CSS Grid and Flexbox layouts for pages, sections, containers, navigation, heroes, cards, galleries, dashboards, and spacing systems. Use when the task mentions layout or structural UI composition.
---

# CSS Layout

- Choose Grid for two-dimensional tracks and Flexbox for one-dimensional distribution; do not apply both without a concrete reason.
- Center content with a bounded container such as `width: min(100% - 2rem, 72rem)` instead of repeated arbitrary margins.
- Use `gap` for sibling spacing and a small consistent spacing scale.
- Let content determine height. Reserve `min-height` for intentional viewport sections and avoid clipping text with fixed heights.
- Make grid tracks shrinkable: use forms such as `minmax(min(100%, 18rem), 1fr)` when a fixed minimum could overflow.
- Add `min-width: 0` to flex/grid children when long content must shrink within tracks.
- Position decorative absolute layers inside a positioned containing block, give empty visuals a real size or `inset`, and place content above them deliberately.
- Keep source order meaningful; visual layout must not make keyboard or reading order confusing.

Verify at narrow and wide widths that content does not overlap fixed navigation, cards align without forced equal text lengths, and no decorative layer blocks interaction.
