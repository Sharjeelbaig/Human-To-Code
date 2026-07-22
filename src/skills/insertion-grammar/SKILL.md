---
name: insertion-grammar
description: Produce code matching the exact grammar position of an inline human marker. Use for statement, JSX child, CSS declaration, CSS rule-list, HTML-content, member, expression, or other block-local replacements.
---

# Insertion Grammar

The surrounding source owns everything outside `<CURRENT_MARKER>`. Return only a syntactically valid replacement for that position.

- `statement`: emit statements valid in the enclosing body; do not repeat the function, method, class, or braces.
- `jsx-child`: emit one JSX expression or element in the existing JSX container; do not output a component or stylesheet.
- `css-declarations`: emit declarations for the current rule; do not repeat its selector or braces.
- `css-rule-list`: emit complete rules with selectors and balanced braces.
- `html-content`: emit nodes/text valid at that location; do not repeat the document shell unless requested there.
- Whole-file targets may own imports and top-level declarations. Inline targets may not rewrite file structure or add imports unless the insertion contract explicitly permits it.

Preserve indentation ownership, delimiters, commas, semicolons, JSX braces, and comment boundaries already outside the marker. Never wrap the replacement in Markdown fences. Silently splice the candidate into the shown source and reject any shape that would not parse.
