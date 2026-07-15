#!/usr/bin/env node
/**
 * human-to-code CLI (deterministic core).
 *
 * Implemented now: `--init`, discovery + planning report (`--dry-run` style),
 * and `--check` (CI: are there human sources without an up-to-date strict IR?).
 * The `human -> strict` and `strict -> code` steps are added in later build
 * steps; until then the CLI reports the plan instead of generating code.
 */

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFIG_FILENAME,
  ConfigError,
  defaultConfigJson,
  defaultModelFor,
  loadConfig,
} from "./config.ts";
import { discover, secretsTrackedError } from "./discovery.ts";
import type { ProviderName } from "./types.ts";

const HELP = `human-to-code — compile .human files to code via a strict IR

Usage:
  human-to-code [path] [options]

Arguments:
  path                 Directory to scan (default: ".")

Options:
  --init               Write a default ${CONFIG_FILENAME} and exit
  --dry-run            Show the plan without generating anything (default today)
  --check              Exit non-zero if any .human lacks an up-to-date .strict.human
  --file <path>        Restrict to a single source file
  --provider <name>    Override provider (openai|anthropic|ollama|grok|gemini)
  -h, --help           Show this help

Exit codes: 0 ok · 1 error · 2 --check found stale/missing strict IR
`;

interface Cli {
  path: string;
  init: boolean;
  dryRun: boolean;
  check: boolean;
  file?: string;
  provider?: string;
  help: boolean;
}

function parse(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      init: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      file: { type: "string" },
      provider: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cli: Cli = {
    path: positionals[0] ?? ".",
    init: values.init === true,
    dryRun: values["dry-run"] === true,
    check: values.check === true,
    help: values.help === true,
  };
  if (typeof values.file === "string") cli.file = values.file;
  if (typeof values.provider === "string") cli.provider = values.provider;
  return cli;
}

const VALID_PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "ollama",
  "grok",
  "gemini",
];

async function runInit(root: string): Promise<number> {
  const target = join(root, CONFIG_FILENAME);
  if (existsSync(target)) {
    console.error(`${CONFIG_FILENAME} already exists — not overwriting.`);
    return 1;
  }
  await writeFile(target, defaultConfigJson(), "utf8");
  console.log(`Wrote ${CONFIG_FILENAME}.`);
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parse(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(HELP);
    return 1;
  }

  if (cli.help) {
    console.log(HELP);
    return 0;
  }

  const root = resolve(cli.path);

  if (cli.init) {
    return runInit(root);
  }

  // Load + validate config (structured JSON, never LLM-parsed).
  let config;
  try {
    ({ config } = await loadConfig(root));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error: ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (cli.provider) {
    if (!VALID_PROVIDERS.includes(cli.provider as ProviderName)) {
      console.error(
        `Unknown --provider "${cli.provider}". Valid: ${VALID_PROVIDERS.join(", ")}.`,
      );
      return 1;
    }
    // A provider override carries that provider's current default model,
    // rather than silently keeping the previous provider's model id.
    const name = cli.provider as ProviderName;
    config.provider.name = name;
    config.provider.model = defaultModelFor(name);
    delete config.provider.baseUrl;
  }

  // Discover sources.
  const result = await discover(root, config.filesToIgnore);

  // Security gate: refuse to run if secrets.human is git-tracked.
  if (result.secrets) {
    const msg = secretsTrackedError(result.secrets);
    if (msg) {
      console.error(msg);
      return 1;
    }
  }

  const strictPaths = new Set(result.strict.map((f) => f.relPath));

  // Which .human files have no corresponding strict IR yet?
  const humanFiltered = cli.file
    ? result.human.filter((f) => f.relPath === toPosixRel(root, cli.file!))
    : result.human;

  const missingStrict = humanFiltered.filter(
    (f) => f.strictSibling && !strictPaths.has(f.strictSibling),
  );

  // --check: CI gate.
  if (cli.check) {
    if (missingStrict.length > 0) {
      console.error(
        `--check failed: ${missingStrict.length} human file(s) without a strict IR:`,
      );
      for (const f of missingStrict) console.error(`  ${f.relPath}`);
      return 2;
    }
    console.log("--check passed: every .human has a .strict.human.");
    return 0;
  }

  // Report the plan (generation is added in a later build step).
  console.log(`Scanned ${result.root}`);
  console.log(`Language: ${config.language}`);
  console.log(
    `Provider: ${config.provider.name} (${config.provider.model})`,
  );
  console.log(
    `Found: ${humanFiltered.length} .human, ${result.strict.length} .strict.human, ` +
      `${result.ignoredCount} ignored${result.secrets ? ", secrets.human present" : ""}`,
  );
  if (missingStrict.length > 0) {
    console.log(`Would generate strict IR for ${missingStrict.length} file(s):`);
    for (const f of missingStrict) console.log(`  ${f.relPath} -> ${f.strictSibling}`);
  }
  console.log(
    "\nNote: human -> strict and strict -> code generation are not implemented yet.",
  );
  return 0;
}

function toPosixRel(root: string, file: string): string {
  const abs = resolve(root, file);
  return abs.slice(root.length + 1).split(/[\\/]/).join("/");
}

// Only run when invoked as a script (not when imported by tests).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.filename === process.argv[1]
) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    });
}
