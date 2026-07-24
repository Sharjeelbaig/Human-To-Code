# Getting help

Thanks for using human-to-code. Here is the fastest route to an answer.

## Before you open anything

Most problems come from one of these, so it is worth a minute:

1. **Node version.** human-to-code requires Node **24 or newer**. Check with
   `node --version`.
2. **Config errors name the exact field.** A message like
   `` Unknown configuration field `direct.planing`. `` means that dotted path,
   nothing more subtle. The full field list is in
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
3. **`NEEDS_INPUT` means nothing was found to convert**, not that a run failed.
   Check that your `.human` files and `@human` markers are in file types
   discovery supports, and are not inside an ignored directory.
4. **Remote providers are blocked until you consent.** `SECURITY_BLOCKED` on a
   remote provider means `privacy.remoteProviderConsent` is still `false`.
5. **Run it with `--json`.** The machine-readable output names the exact status,
   the per-unit skip reasons, and the request counts. It is the single most
   useful thing to paste into an issue.

## Where to go

| Situation | Where |
| --- | --- |
| Something is broken or behaves wrong | [Open a bug report](https://github.com/Sharjeelbaig/Human-To-Code/issues/new?template=bug_report.yml) |
| You want a capability that does not exist | [Open a feature request](https://github.com/Sharjeelbaig/Human-To-Code/issues/new?template=feature_request.yml) |
| You are not sure whether it is a bug | [Open a question issue](https://github.com/Sharjeelbaig/Human-To-Code/issues/new) and say what you expected |
| You found a security vulnerability | **Do not open a public issue.** Follow [SECURITY.md](SECURITY.md) |
| You want to contribute a change | [CONTRIBUTING.md](CONTRIBUTING.md) |

## What to include in a bug report

The issue template asks for these, and a report with them usually gets resolved
in one round trip instead of four:

- The exact command you ran and its full output, ideally with `--json`.
- Your `human-to-code.config.json` with **credentials and private paths
  removed**  -  the config never stores a credential, but check anyway.
- Your Node version, OS, package version (`npx human-to-code --help` prints the
  banner; `npm ls human-to-code` prints the version).
- A minimal `.human` file or `@human` marker that reproduces it.

## Response expectations

This is a preview-stage project maintained in the open by volunteers. Issues are
read, but there is no support SLA. A clear, reproducible report is the single
biggest thing you can do to get a fast fix  -  and a pull request is welcome for
anything you would rather not wait on.
