---
name: css-motion
description: Add purposeful CSS transitions and animations with reduced-motion fallbacks. Use for animation, motion, transitions, hover movement, reveal effects, keyframes, or prefers-reduced-motion requirements.
---

# CSS Motion

- Animate only when motion communicates state, hierarchy, or continuity.
- Prefer `transform` and `opacity`; avoid layout-thrashing animation of dimensions or position when an equivalent transform works.
- Keep interaction transitions short and scoped to named properties. Never use `transition: all`.
- Make the resting state usable if animation never runs. Content must not remain invisible waiting for JavaScript that may not load.
- Pair hover motion with keyboard focus styling where the effect represents interactivity.
- Add `@media (prefers-reduced-motion: reduce)` when motion is non-trivial or the task requests it. Remove decorative animation and smooth scrolling without removing feedback or content.
- Avoid infinite animation unless it conveys ongoing activity and has a non-animated accessible interpretation.

Check that reduced-motion rules override every introduced keyframe, transition, transform-driven reveal, and smooth-scroll behavior that could cause discomfort.
