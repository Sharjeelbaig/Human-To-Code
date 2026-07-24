# What this changes

<!-- One or two sentences. What behavior is different after this merges? -->

Closes #

## Why

<!-- The problem being solved. Link the issue if there is one. -->

## How

<!-- The approach, and anything a reviewer would otherwise have to reverse
     engineer. Call out deliberate trade-offs here rather than in a comment
     thread later. -->

## Checks

All of these must pass locally before review (see
[CONTRIBUTING.md](../CONTRIBUTING.md)):

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run package:check` passes
- [ ] `git status` is clean of tarballs and unrelated files

## Contribution rules this PR follows

- [ ] Behavior changes come with a regression test.
- [ ] Source bytes outside the requested marker range are preserved exactly.
- [ ] Provider calls stay injectable, so tests need no network.
- [ ] No new path executes repository code during discovery or preview.
- [ ] Every added block has a comment saying what it does, with a concrete
      example  -  and every error path has a comment saying how to reproduce it.
- [ ] Model-facing prose lives in `src/prompts/`, not inline in logic.

## Config or docs impact

- [ ] No config change.
- [ ] Config changed  -  `docs/CONFIGURATION.md` is updated, including the
      complete default JSON block. (Two tests in `test/config.test.ts` enforce
      this and will fail otherwise.)
- [ ] User-visible behavior changed  -  `Readme.md` and `CHANGELOG.md` updated.

## Anything reviewers should look at closely

<!-- Uncertain trade-offs, a naming choice you are unsure about, a test you
     could not write. Say so here; it speeds review up rather than slowing it
     down. -->
