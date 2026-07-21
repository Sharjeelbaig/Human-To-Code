# Contributing to human-to-code

Thanks for helping improve human-to-code.

From a source checkout:

```bash
git clone https://github.com/sharjeelbaig/human-to-code
cd human-to-code
npm ci
npm run build
npm test
npm run typecheck
npm run package:check
```

The command users depend on is:

```bash
npx human-to-code .
```

`src/cli.ts` owns argument parsing and output. `src/agents/direct/` owns
request discovery, prompt calls, local and project memory, candidate validation,
integration reconciliation, receipts, and guarded writes. `src/prompts/` owns
model-facing messages. `src/providers/` owns provider transport.

Keep changes focused. Add a regression test for behavior changes, preserve exact
source bytes outside requested marker ranges, and keep provider calls injectable
in tests. Never add a path that executes repository code during discovery or
preview. Always add comments for what any code line or block does with example, like "This codeblock runs when we pass the init flag for example `npx human-to-code . --init`" or "This codeblock runs when we give invalid arguments like `npx human-to-code . --blahblah`".

Before opening a pull request, run every development check shown above and make
sure `git status` contains no generated package tarballs or unrelated files.
