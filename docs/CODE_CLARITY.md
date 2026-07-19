# Source clarity and naming practices

The source should be able to explain how reviewed human language becomes bounded
code, even to someone who hasn't read a single architecture document. Names and
comments are part of the safety design here  -  unclear code makes it easier to
introduce a scope, trust, or mutation mistake without noticing.

For the friendly folder and file map these names describe, see
[CODEBASE_TOUR.md](CODEBASE_TOUR.md).

These practices apply to new code right away. Existing code should drift toward
them whenever its module gets touched for another reason. Please don't do
unrelated mass renames  -  they create review noise and can break the embedding
API.

## Name from the lifecycle outward

A public or cross-module function name should usually contain:

```text
action + domain object + lifecycle qualifier (when needed)
```

| Prefer | Avoid | What the better name tells you |
| --- | --- | --- |
| `discoverHumanInstructionSources` | `discover` | It finds `.human` inputs, not arbitrary files. |
| `generateGuidedCodeChangeRun` | `generateRun` | It generates a reviewed guided change, not just any run. |
| `validateGuidedCodeChangeRun` | `validateStoredRun` | It validates the guided code-change lifecycle. |
| `applyVerifiedCodeChangeRun` | `apply` | It only mutates files for a run that's actually eligible. |
| `collectUniqueValues` | `unique` | It returns values instead of answering a yes/no question. |
| `hasUniqueEditAnchor` | `unique` | A boolean name states the condition it stands for. |

Short names are still fine inside a small, obvious scope. `path` in a five-line
path helper beats repeating `projectRelativePath` everywhere. But `data`,
`result`, `item`, and `value` should be replaced the moment two meanings are
possible.

## Use the project vocabulary consistently

Don't invent synonyms for concepts that already have a name.

| Concept | What to call it |
| --- | --- |
| Natural-language input | `instruction`, `humanSource`, `changeRequest` |
| One direct-mode task | `conversionUnit` |
| Model-produced code before acceptance | `candidateCode` or `candidate` |
| Reviewed authority | `changeContract` or `contract` |
| Model-visible project material | `contextEvidence` or `contextManifest` |
| Structured proposed change | `patch`, `patchSet`, `patchOperation` |
| Unchanged comparison tree | `baseline` |
| Changed isolated tree | `candidate` |
| Validation outcome | `validationReport` |
| The user's real checkout | `workingTree` |

Save `compile` for actual compiler work. Use `generate` for model output,
`validate` for host checks, and `apply` only when the working tree is being
mutated.

## Make units and state visible

- Boolean names start with `is`, `has`, `can`, `should`, `was`, or `needs`.
- Collections get plural nouns, and maps and sets say what their keys are.
- Paths use `Path`, `Root`, or `Directory`. Hashes use `Hash`. Identifiers use
  `Id`. Byte, token, money, and time values use `Bytes`, `Tokens`, `Usd`, or
  `Ms`.
- Keep `source`, `baseline`, `candidate`, and `workingTree` distinct. Never call
  all four of them `root` in the same operation.
- Names crossing a trust boundary should say where they are in that journey when
  it helps: `rawProviderOutput`, `validatedPatch`, `reviewedContract`.
- Skip unexplained abbreviations, except for established formats and protocols
  like `JSON`, `HTTP`, `SHA`, `API`, and `CLI`.

## Comments explain role, boundary, and reason

Every module opens with a `/** ... */` header saying what the file is for.
Write it the way you'd explain the file to someone sitting next to you:

```ts
/**
 * Picks the least-privilege slice of the project the model is allowed to see
 * when turning a reviewed request into code.
 */
```

Keep it about the file's job. A header that just repeats the filename is not
useful, and neither is the same stock phrase pasted across twenty modules.

Add a comment on a function when it's a lifecycle checkpoint, crosses a trust
boundary, mutates files, executes untrusted project commands, or enforces an
invariant you wouldn't guess from reading it. A comment that's pulling its
weight answers at least one of these:

- Where does this sit between the human instruction and the final code?
- Which input here is untrusted, reviewed, generated, validated, or persisted?
- What authority does this function deliberately *not* have?
- Why does this check have to happen before the next stage?
- Does it read, generate, validate, execute, persist, apply, or roll back?

Don't narrate syntax:

```ts
// Bad: Loop through operations.
// Good: Reject the whole patch on the first out-of-scope operation, so a model
// cannot smuggle an allowed edit in beside a prohibited one.
```

Comments aren't a substitute for names. If a comment is just translating a vague
name into English, fix the name instead. And when behavior changes, the comment
changes in the same commit.

## Public API changes

The embedding API is deliberately stable. When an exported name turns out to be
unclear:

1. Add the clearer name as the real implementation.
2. Point internal code, tests, and documentation at it.
3. Keep the old name only as a small `@deprecated` alias, and only if
   compatibility actually requires it.
4. Remove that alias only in a documented breaking release.

Never maintain two implementations. The legacy alias has to point at the new
symbol, so the two can't drift apart.

## Review checklist

- Can a reader tell the lifecycle stage from each public function name?
- Do booleans read like true/false questions?
- Do paths, hashes, IDs, units, and collections advertise their shape?
- Are model output, repository text, diagnostics, and provider responses named
  as untrusted until they've been validated?
- Does every source module start with an accurate header that says what it does?
- Do checkpoint comments explain the role or invariant instead of restating the
  code below them?
- Are compatibility aliases explicitly deprecated and documented?
- Did the tests and the glossary get updated when a public name changed?

`test/source-clarity.test.ts` enforces that every module has a responsibility
header and rejects context-free exported names unless they're documented
compatibility aliases. It can't judge whether a name is *good*  -  that's still on
human review.
