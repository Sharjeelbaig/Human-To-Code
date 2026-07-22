---
name: css-visual-design
description: Create polished, coherent, production-quality web visual systems. Use for CSS, websites, portfolios, landing pages, dashboards, sections, components, themes, visual hierarchy, spacing, typography, colors, and professional UI styling.
---

# CSS Visual Design

Build a deliberate interface, not a collection of independently styled elements.

## Default Direction

- Use a light theme unless the user explicitly requests a dark theme, supplies a color palette, or the existing product has an established theme that must be preserved.
- Start with warm or neutral near-white surfaces, dark readable text, restrained borders, and one intentional accent family. Do not default to navy backgrounds, neon gradients, or glass effects.
- Respect explicit brand colors exactly. Derive supporting tints and shades from them rather than introducing unrelated accents.
- Prefer timeless, product-appropriate styling over trend effects. Every gradient, shadow, blur, animation, and decoration needs a compositional purpose.

## Compose the Page

1. Establish a clear page frame: navigation, main content order, section rhythm, and footer.
2. Give every section one primary job and one obvious visual anchor. Avoid large unexplained empty regions.
3. Use a consistent content container and spacing scale. Align headings, copy, cards, and controls to shared edges.
4. Create hierarchy through type size, weight, measure, spacing, and contrast before adding decoration.
5. Keep related actions visibly grouped and separated from unrelated content.
6. Make repeated items a real grid or list with consistent internal anatomy, alignment, and heights where helpful.

## Build a Small Visual System

- Define reusable custom properties for canvas, surface, text, muted text, border, accent, focus, radii, shadows, and spacing.
- Use a limited type scale and comfortable reading measure. Body copy should usually remain near 45–75 characters per line.
- Keep border radii, borders, shadows, and icon treatment consistent across cards and controls.
- Give buttons and links distinct roles. Primary, secondary, and text actions must not look interchangeable.
- Include complete interaction states: hover, focus-visible, active where meaningful, disabled when applicable, and selected/current states when present.

## Professional Quality Gate

Before returning CSS, confirm that:

- the first viewport communicates identity, purpose, and next action;
- sections have intentional density rather than arbitrary viewport-sized gaps;
- every visible component class in related markup has coherent styling;
- text contrast, focus visibility, target size, reflow, and reduced motion remain usable;
- mobile layout is recomposed where necessary instead of merely shrinking desktop;
- placeholder links, controls, and cards still have stable, realistic visual structure;
- the result reads as one designed product at every viewport, not disconnected snippets.
