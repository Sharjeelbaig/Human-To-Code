# Contributing to human-to-code

Thanks for helping out! This project is in early development, so issues, ideas, and PRs are all welcome.

## Development setup

You only need **Node ≥ 23.6** — it runs the TypeScript source directly, so there's no build step and there are **no dependencies to install**.

```bash
git clone https://github.com/sharjeelbaig/human-to-code
cd human-to-code
node src/cli.ts --help    # run the CLI
node --test               # run the test suite
```

## Project layout

| Path               | What it is                                                            |
| ------------------ | --------------------------------------------------------------------- |
| `src/config.ts`    | Structured JSON config loader + validator                             |
| `src/discovery.ts` | Finds and classifies `.human` / `.strict.human` files; security gates |
| `src/cli.ts`       | Command-line entry point                                              |
| `test/`            | `node:test` suites                                                    |

## The one rule that keeps the project safe

The pipeline is `human → strict → code`. The LLM is confined to `human → strict`; the `strict → code` step is a **deterministic generator with no LLM and no network**.

- Keep `strict → code` deterministic — same IR in, identical code out.
- **Never add a raw-code passthrough** to the strict grammar. It's the one change that would let a malicious `.human` file smuggle arbitrary code past review. If you ever truly need one, it must be explicitly flagged and gated.

## Submitting changes

1. Open an issue first for anything non-trivial so we can agree on direction.
2. Keep PRs focused; add or update `node:test` cases for behavior changes.
3. Make sure `node --test` passes before pushing.

## Reporting security issues

Please don't open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
