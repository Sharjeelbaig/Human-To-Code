---
name: css-selector-contracts
description: Keep stylesheet selectors identical to HTML, JSX, TSX, DOM, and shared-contract names. Use when CSS and markup are companions, when className or selectors are involved, or when repairing unused, unstyled, or unmatched selectors.
---

# CSS Selector Contracts

Treat selector spelling as an API contract.

1. Extract the exact `class`, `className`, `id`, state-class, and query-selector names present in PROJECT_MEMORY, SHARED_CONTRACT, related files, and the current task.
2. Build rules from that inventory. Copy names byte-for-byte; preserve singular/plural forms, prefixes, and hyphenation.
3. Never invent a synonym because it reads better. If markup has `project-grid`, do not write `.projects-grid`; if it has `about-bio`, do not substitute `.about-text`.
4. Use requested prefix families consistently, such as `about-*` or `project-*`, without collapsing them into unrelated generic names.
5. Style structure through selectors that can match one rendered element. A compound selector's classes must coexist on that element.
6. Add pseudo-classes and state classes only on top of a real base selector. Keep hover and focus behavior paired where appropriate.
7. During repair, prefer changing the incorrect side to the already evidenced shared name. Do not add duplicate alias rules merely to silence an unused-selector warning.

Before returning CSS, reconcile both directions: every component-level class that needs styling has a matching rule, and every emitted component selector has real markup or script evidence.
