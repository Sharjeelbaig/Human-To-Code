<p align="center">
  <img src="assets/banner.svg" alt="human-to-code — write intent in plain language, compile it to real code" width="100%">
</p>

<p align="center">
  <a href="#status--roadmap"><img alt="status: alpha" src="https://img.shields.io/badge/status-alpha-orange"></a>
  <img alt="node >= 23.6" src="https://img.shields.io/badge/node-%E2%89%A5%2023.6-brightgreen">
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/deps-0-informational">
</p>

`human-to-code` turns natural-language **`.human`** files into TypeScript, JavaScript, or Python — not by piping your whole codebase through an LLM and hoping, but through a small, reviewable intermediate representation that keeps the output reproducible.

```text
foo.human    →    foo.strict.human    →    foo.ts
plain English      strict IR (reviewed)      real code
      └── LLM ──┘         └── deterministic compiler ──┘
```

The LLM only writes the **middle** layer. Turning that layer into code is a plain compiler: **same IR in, identical code out — every run.**

## Why the middle layer?

- 🔁 **Reproducible** — `strict → code` uses no LLM, so builds are bit-for-bit stable.
- 🔗 **Coherent across files** — a shared symbol table keeps names and signatures aligned, so a function defined in one file is called by the same name in another.
- 🛡️ **Safe to review** — you diff a small, constrained IR instead of trusting freeform generated code. See [SECURITY.md](SECURITY.md).

## Quick start

> [!WARNING]
> **Alpha.** The deterministic core (config, discovery, CLI planning) works today. The `.human → strict → code` generators are in progress, and it isn't on npm yet.

```bash
git clone https://github.com/sharjeelbaig/human-to-code
cd human-to-code
node src/cli.ts --help        # Node >= 23.6 runs the TypeScript directly — no build step
```

Planned published usage:

```bash
npx human-to-code .           # compile every .human file in the project
npx human-to-code --init      # write a default config
npx human-to-code --check     # CI gate: fail if a .human has no strict IR
```

## Configuration

`human-to-code.config.json` (plain JSON — never parsed by an LLM):

```json
{
  "language": "typescript",
  "filesToIgnore": ["node_modules", ".git", "dist"],
  "allowNonHumanFiles": false,
  "provider": { "name": "anthropic", "model": "claude-opus-4-8" }
}
```

Provider credentials come from **environment variables**, never a committed file. `secrets.human` is git-ignored, and the tool refuses to run if it's git-tracked.

## Status & roadmap

- [x] Deterministic core — config, discovery, CLI, security gates
- [ ] `.strict.human` grammar + parser
- [ ] Deterministic `strict → code` backend (TypeScript first)
- [ ] `human → strict` LLM front-end (constrained output, hash-locked)
- [ ] `--watch`, cost reporting, more target languages

<details>
<summary>How it fits together (architecture)</summary>

The one non-deterministic step (`human → strict`) is confined to a single LLM call whose output is a committed, diffable IR. Everything downstream is a deterministic compiler with snapshot tests. A hand-written `.strict.human` always wins over a generated one, so you can drop to precise control whenever you want. Full design notes live in the project plan.

</details>

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `node --test`.

## License

[MIT](LICENSE) © the human-to-code authors
