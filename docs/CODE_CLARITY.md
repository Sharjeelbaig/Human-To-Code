# Source clarity and naming practices

The source should explain how reviewed human language becomes bounded code even
when a contributor has not read every architecture document. Names and comments
are part of the safety design: unclear code makes scope, trust, and mutation
mistakes easier to introduce.

For the current command-to-function and variable handoffs these names describe,
see [WORKFLOWS.md](WORKFLOWS.md).

These practices apply to new code immediately. Existing code should move toward
them when its owning module is changed; avoid unrelated mass renames that create
review noise or break the embedding API.

## Name from the lifecycle outward

A public or cross-module function name should normally contain:

```text
action + domain object + lifecycle qualifier (when needed)
```

| Prefer | Avoid | What the preferred name tells the reader |
| --- | --- | --- |
| `discoverHumanInstructionSources` | `discover` | Finds `.human` inputs rather than arbitrary files. |
| `generateGuidedCodeChangeRun` | `generateRun` | Generates a reviewed guided change, not any run. |
| `validateGuidedCodeChangeRun` | `validateStoredRun` | Validates the guided code-change lifecycle. |
| `applyVerifiedCodeChangeRun` | `apply` | Mutates files only for an eligible verified run. |
| `collectUniqueValues` | `unique` | Returns values rather than answering a boolean question. |
| `hasUniqueEditAnchor` | `unique` | A boolean name states the condition it represents. |

Short names remain appropriate inside a small, obvious scope. `path` in a
five-line path helper is clearer than repeating `projectRelativePath`; `data`,
`result`, `item`, or `value` should be replaced when two meanings are possible.

## Use the project vocabulary consistently

Do not invent synonyms for established lifecycle concepts.

| Concept | Preferred vocabulary |
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
| User's real checkout | `workingTree` |

Use `compile` only for actual compiler work. Use `generate` for model output,
`validate` for host checks, and `apply` only for working-tree mutation.

## Make units and state visible

- Boolean names begin with `is`, `has`, `can`, `should`, `was`, or `needs`.
- Collections use plural nouns; maps and sets state what their keys represent.
- Paths use `Path`, `Root`, or `Directory`; hashes use `Hash`; identifiers use
  `Id`; byte, token, money, and time values use `Bytes`, `Tokens`, `Usd`, or
  `Ms` suffixes.
- Distinguish `source`, `baseline`, `candidate`, and `workingTree`; never call
  all four `root` inside the same operation.
- Names crossing a trust boundary describe validation state when useful:
  `rawProviderOutput`, `validatedPatch`, `reviewedContract`.
- Avoid unexplained abbreviations except established formats and protocols such
  as `JSON`, `HTTP`, `SHA`, `API`, and `CLI`.

## Comments explain role, boundary, and reason

Every module starts with a `/** ... */` responsibility header. For modules in
the conversion path, prefer this form:

```ts
/**
 * Human-to-code role: select the least-privilege project evidence the model
 * may use to turn a reviewed request into code.
 */
```

Add a function comment when a function is a lifecycle checkpoint, crosses a
trust boundary, mutates files, executes untrusted project commands, or enforces
a non-obvious invariant. A useful comment answers at least one of these:

- Where is this used between human instruction and final code?
- What input is untrusted, reviewed, generated, validated, or persisted?
- What authority does this function deliberately not have?
- Why must this check happen before the next stage?
- Does it read, generate, validate, execute, persist, apply, or roll back?

Do not narrate syntax:

```ts
// Bad: Loop through operations.
// Good: Reject the whole patch on the first out-of-scope operation so a model
// cannot smuggle an allowed edit beside a prohibited one.
```

Comments are not a substitute for names. If a comment merely translates a
vague name, improve the name first. Comments must be updated in the same change
as the behavior they describe.

## Public API changes

The embedding API is intentionally stable. When an exported name is unclear:

1. Add the clearer name as the primary implementation.
2. Update internal code, tests, and documentation to use it.
3. Keep the old name only as a small `@deprecated` alias when compatibility is
   required.
4. Remove the alias only in a documented breaking release.

Do not maintain two implementations. The legacy alias must point to the new
symbol so behavior cannot drift.

## Review checklist

- Can a reader identify the lifecycle stage from each public function name?
- Do booleans read like true/false questions?
- Do paths, hashes, IDs, units, and collections advertise their shape?
- Are model output, repository text, diagnostics, and provider responses named
  as untrusted until validation occurs?
- Does every source module begin with an accurate responsibility header?
- Do checkpoint comments explain role or invariant rather than restating code?
- Are compatibility aliases explicitly deprecated and documented?
- Were tests and the glossary updated when a public name changed?

`test/source-clarity.test.ts` enforces module responsibility headers and rejects
context-free exported names unless they are documented compatibility aliases.
Human review remains responsible for semantic naming quality.
