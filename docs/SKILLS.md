# Model skill folders

`src/skills` contains package-owned markdown guidance for the direct generation engine. Each direct child directory is one skill. Its lowercase hyphenated folder name is both the stable id and the default trigger vocabulary.

The loader applies progressive disclosure: it selects skills immediately before blueprint, todo, coding, audit, and repair requests. CSS work always receives the foundations and visual-design skills; companion CSS/markup work receives selector-contract guidance; other folders must match meaningful words in the language, target path, task, or bounded project evidence. Non-web work receives no CSS skill context.

The default visual direction is professional and light-first: coherent page structure, near-white surfaces, readable dark text, restrained borders, and one purposeful accent family. An explicit user palette, dark-theme request, or established project design always takes precedence.

## Local human-to-code skills

The general library is designed for file, line, and code-block instructions—not autonomous product planning.

| Group | Folders |
| --- | --- |
| Core local contract | `local-intent`, `insertion-grammar`, `scope-symbol-contracts`, `minimal-local-change` |
| Semantic behavior | `type-correctness`, `control-flow`, `data-flow`, `error-handling` |
| Lifecycles and relationships | `async-lifecycle`, `resource-lifecycle`, `reference-contracts` |
| Conditional domains | `api-contracts`, `database-queries`, `security-sensitive-code`, `test-context`, `configuration-context`, `documentation-context` |
| Target languages | `typescript-local-code`, `javascript-local-code`, `python-local-code`, `rust-local-code`, `go-local-code`, `java-local-code`, `csharp-local-code`, `sql-local-code`, `shell-local-code` |

Core skills are selected for coding/repair phases. `insertion-grammar` is selected only for inline markers. Exactly the matching language skill is eligible from the real language/extension, while domain skills require corresponding instruction or bounded project evidence.

For example, this marker selects local intent, insertion grammar, scope contracts, minimal change, TypeScript, type correctness, and control flow. The comment is discovered by `npx human-to-code .`; the code block itself is ordinary project source and never runs during skill selection:

```ts
function load(): Result {
  const result = read();
  // @human return early when result is undefined
  return result;
}
```

An async Python repository instruction can additionally select database, async, error, and resource-lifecycle guidance. A Python task that merely parses CSS text does not receive CSS or JavaScript skills.

## Run the normal path

This command scans the current project, shows the conversion receipt, and—after confirmation—runs the selected skills only for the model requests that need them:

```bash
npx human-to-code .
```

## Add a skill

Create one direct child folder whose name describes the capability. `SKILL.md` is required. Additional `.md` files in the same folder are loaded in lexical order after `SKILL.md`, but only when that folder is selected.

This example becomes eligible for CSS requests containing “table” or “tables”; the loader needs no registry edit:

```text
src/skills/css-tables/
├── SKILL.md
└── examples.md
```

`SKILL.md` should keep the standard frontmatter limited to `name` and `description`, with the folder name and `name` identical:

```markdown
---
name: css-tables
description: Build readable responsive data tables. Use for CSS table, grid-table, column, overflow, and narrow-screen table tasks.
---

# CSS Tables

- Preserve header relationships and readable source order.
- Add horizontal overflow only at the table boundary when reflow is not viable.
```

The markdown block above is model guidance. It is read only when `css-tables` is selected; it is never executed as project code or shell input.

## Limits and failure reproduction

Only real directories and real markdown files are accepted; symlinked folders/files are ignored. A markdown file above 12,000 characters fails loudly, at most 64 folders are discovered, at most 12 skills and 48,000 total characters are attached to one request, and unknown or malformed folder names are skipped.

This intentionally bypasses the copy step and reproduces a package-build error where compiled JavaScript exists but installed skill markdown would be missing:

```bash
npm run clean
npx tsc -p tsconfig.json
node dist/cli.js --help
```

The block above is diagnostic only. A correct build runs the markdown copier after TypeScript:

```bash
npm run build
npm run typecheck
npm test
npm run package:check
```

That verification block compiles source, copies skills to `dist/skills`, checks types, exercises folder routing and prompt attachment, and installs the packed tarball to prove the published `npx` path can discover the markdown.
