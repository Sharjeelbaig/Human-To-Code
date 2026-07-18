#!/usr/bin/env node
/** Production CLI: analyze -> reviewed contract -> grounded patch -> validation -> explicit apply. */

import { constants as fsConstants, realpathSync } from "node:fs";
import { copyFile, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeProject, type ProjectProfileV1 } from "./analysis/analyzer.ts";
import {
  CONFIG_FILENAME,
  ConfigError,
  defaultConfigJson,
  defaultModelFor,
  loadConfig,
  migrateLegacyConfig,
  validateConfig,
  type ConfigV1,
} from "./config/config.ts";
import { ContextSecurityError } from "./context/context.ts";
import { DocumentationError } from "./context/documentation.ts";
import { discover, DiscoveryError, secretsTrackedError } from "./config/discovery.ts";
import {
  PlanningError,
  contractPathForSource,
  createDraftContract,
  loadReviewedContract,
  writeDraftContract,
} from "./pipeline/planner.ts";
import { ProviderError, type ProviderAdapter } from "./providers/provider.ts";
import { createOllamaProvider, createOpenAIProvider } from "./providers/providers.ts";
import { RunStore } from "./pipeline/run-store.ts";
import {
  applyUnit,
  discoverDirectUnits,
  generateConversionUnits,
  generateCode,
  generateRepairCode,
  renderReceipt,
  validateCandidateProject,
  validateGeneratedUnit,
  type ConversionUnit,
  type ConversionProgress,
  type StagedValidationProgress,
} from "./agents/direct/index.ts";
import type { ProviderName, SourceFile } from "./core/types.ts";
import {
  applyVerifiedRun,
  buildContextPreview,
  generateRun,
  resolveWorkspaceConfig,
  rollbackAppliedRun,
  validateStoredRun,
  type WorkflowOutcome,
} from "./agents/guided/index.ts";

const HELP = `human-to-code — reviewed, grounded, isolated human-to-code compiler agent

Usage:
  human-to-code [root] [-y]                    Convert .human files and @human markers to code (default; fast deterministic engine)
  human-to-code build [root] [-y]              Alias of the default convert flow
  human-to-code guided [root]                  Reviewed/grounded/validated compiler pipeline
  human-to-code analyze [root] [--json]
  human-to-code plan <file.human> [--root <root>]
  human-to-code context <contract> --explain [--offline] [--json]
  human-to-code generate <contract> [--provider <name>] [--model <id>]
  human-to-code validate <run-id> [--sandbox-image <image>] [--manual-passed]
  human-to-code apply <run-id>
  human-to-code rollback <run-id>                Restore a successfully applied run
  human-to-code check [root]
  human-to-code migrate-config [root]
  human-to-code --init [root]

Provider options:
  --provider <name>              openai | ollama (other configured names are unsupported)
  --model <id>                   Exact requested model id; never silently changed
  --base-url <url>               Trusted Ollama Cloud/custom provider base URL
  --api-key-env <ENV_NAME>       Environment variable name only, never a credential value
  --input-cost-per-million <USD> Conservative input-token API rate for remote cost reservation
  --output-cost-per-million <USD> Conservative output-token API rate for remote cost reservation
  --unmetered-provider            Explicitly attest that both remote API rates are zero
  --trust-custom-endpoint        Required acknowledgement for every configured base URL

Other options:
  --root <root>                  Explicit project root
  --file <file.human>            Select one source in guided mode
  --offline                      Use cached/local documentation only
  --explain                      Show outbound context provenance and exact selected content
  --json                         Machine-readable output
  -y, --yes                      Skip the confirmation prompt and write files
  --simple                       Deprecated no-op; the deterministic engine is now the default
  --dry-run                      Analyze and preview only; perform no generation
  --manual-passed                Explicitly attest all reviewed manual acceptance checks
  --sandbox-image <image>        Trusted image reference that must already exist locally
  --docker-binary <path>         Docker-compatible runtime override (for example Podman)
  -h, --help                     Show this help

Exit codes:
  0 verified/successful non-generation command
  1 usage or configuration error
  2 stale contract or failed validation
  3 needs input, unsupported, or inconclusive
  4 security blocked
  5 provider or documentation dependency failure
  6 internal error or partial scan
`;

const COMMANDS = new Set(["build", "convert", "guided", "analyze", "plan", "context", "generate", "validate", "apply", "rollback", "check", "migrate-config"]);
const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "ollama", "grok", "gemini"];

interface CliOptions {
  positionals: string[];
  json: boolean;
  offline: boolean;
  explain: boolean;
  dryRun: boolean;
  manualPassed: boolean;
  trustCustomEndpoint: boolean;
  yes: boolean;
  simple: boolean;
  init: boolean;
  help: boolean;
  root?: string;
  file?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  inputCostPerMillion?: string;
  outputCostPerMillion?: string;
  unmeteredProvider: boolean;
  sandboxImage?: string;
  dockerBinary?: string;
}

function parse(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "manual-passed": { type: "boolean", default: false },
      "trust-custom-endpoint": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      simple: { type: "boolean", default: false },
      init: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      root: { type: "string" },
      file: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "input-cost-per-million": { type: "string" },
      "output-cost-per-million": { type: "string" },
      "unmetered-provider": { type: "boolean", default: false },
      "sandbox-image": { type: "string" },
      "docker-binary": { type: "string" },
    },
  });
  return {
    positionals,
    json: values.json === true,
    offline: values.offline === true,
    explain: values.explain === true,
    dryRun: values["dry-run"] === true,
    manualPassed: values["manual-passed"] === true,
    trustCustomEndpoint: values["trust-custom-endpoint"] === true,
    yes: values.yes === true,
    simple: values.simple === true,
    init: values.init === true,
    help: values.help === true,
    ...(typeof values.root === "string" ? { root: values.root } : {}),
    ...(typeof values.file === "string" ? { file: values.file } : {}),
    ...(typeof values.provider === "string" ? { provider: values.provider } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values["base-url"] === "string" ? { baseUrl: values["base-url"] } : {}),
    ...(typeof values["api-key-env"] === "string" ? { apiKeyEnv: values["api-key-env"] } : {}),
    ...(typeof values["input-cost-per-million"] === "string" ? { inputCostPerMillion: values["input-cost-per-million"] } : {}),
    ...(typeof values["output-cost-per-million"] === "string" ? { outputCostPerMillion: values["output-cost-per-million"] } : {}),
    unmeteredProvider: values["unmetered-provider"] === true,
    ...(typeof values["sandbox-image"] === "string" ? { sandboxImage: values["sandbox-image"] } : {}),
    ...(typeof values["docker-binary"] === "string" ? { dockerBinary: values["docker-binary"] } : {}),
  };
}

function output(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function profileText(profile: ProjectProfileV1): string {
  const lines = [
    `Analysis: ${profile.status}`,
    `Root: ${profile.root}`,
    `Fingerprint: ${profile.fingerprint}`,
    `Workspaces: ${profile.workspaces.length}`,
  ];
  for (const workspace of profile.workspaces) {
    lines.push(`  ${workspace.id} — ${workspace.variant} — ${workspace.support.tier}`);
    lines.push(`    framework ${workspace.framework.name} ${workspace.framework.resolvedVersion ?? workspace.framework.declaredVersion ?? "version unresolved"}`);
    lines.push(`    validation ${workspace.validationPlan.map((command) => command.category).join(", ") || "none"}`);
  }
  for (const diagnostic of profile.diagnostics) lines.push(`  [${diagnostic.code}] ${diagnostic.message}`);
  return lines.join("\n");
}

function analysisExit(profile: ProjectProfileV1): number {
  if (profile.status === "PARTIAL_SCAN") return 6;
  if (profile.status === "NEEDS_INPUT" || profile.status === "UNSUPPORTED") return 3;
  return 0;
}

function outcomeExit(outcome: WorkflowOutcome): number {
  if (outcome.exitCode !== undefined) return outcome.exitCode;
  if (outcome.status === "VERIFIED") return 0;
  if (outcome.status === "SECURITY_BLOCKED") return 4;
  if (outcome.status === "NEEDS_INPUT" || outcome.status === "UNSUPPORTED" || outcome.status === "INCONCLUSIVE") return 3;
  return 2;
}

function outcomeText(outcome: WorkflowOutcome): string {
  const lines = [`Run ${outcome.runId}: ${outcome.status}`];
  if (outcome.usage !== undefined) {
    const repairs = outcome.usage.repairs ?? 0;
    lines.push(`  Provider API requests: ${outcome.usage.requests}${repairs > 0 ? ` (${repairs} repair${repairs === 1 ? "" : "s"})` : ""}`);
  }
  for (const diagnostic of outcome.diagnostics) lines.push(`  ${diagnostic}`);
  if (outcome.diff) lines.push("", outcome.diff);
  return lines.join("\n");
}

function projectRoot(cli: CliOptions, fallback = "."): string {
  return resolve(cli.root ?? fallback);
}

function relativeInside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new PlanningError("PATH_ESCAPE", "File must be inside the project root.");
  return rel.split(sep).join("/");
}

async function initConfig(root: string): Promise<number> {
  const target = resolve(root, CONFIG_FILENAME);
  try {
    await writeFile(target, defaultConfigJson(), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError(`${CONFIG_FILENAME} already exists; it was not overwritten.`);
    throw error;
  }
  console.log(`Wrote ${target}. Review provider, model, privacy consent, sandbox, and budgets before remote generation.`);
  return 0;
}

function overrideConfig(config: ConfigV1, cli: CliOptions): ConfigV1 {
  const raw = structuredClone(config) as ConfigV1;
  if (cli.provider !== undefined) {
    if (!PROVIDERS.includes(cli.provider as ProviderName)) throw new ConfigError(`Unknown provider ${JSON.stringify(cli.provider)}.`);
    const name = cli.provider as ProviderName;
    if (raw.provider.name !== name) {
      raw.provider = { name, model: cli.model ?? defaultModelFor(name) };
    }
  }
  if (cli.model !== undefined) raw.provider.model = cli.model;
  if (cli.baseUrl !== undefined) raw.provider.baseUrl = cli.baseUrl;
  if (cli.apiKeyEnv !== undefined) raw.provider.apiKeyEnv = cli.apiKeyEnv;
  if (cli.inputCostPerMillion !== undefined || cli.outputCostPerMillion !== undefined || cli.unmeteredProvider) {
    const input = cli.inputCostPerMillion === undefined
      ? raw.provider.pricing?.inputUsdPerMillionTokens
      : Number(cli.inputCostPerMillion);
    const output = cli.outputCostPerMillion === undefined
      ? raw.provider.pricing?.outputUsdPerMillionTokens
      : Number(cli.outputCostPerMillion);
    if (input === undefined || output === undefined) {
      throw new ConfigError("Both remote input and output cost upper bounds are required.");
    }
    raw.provider.pricing = {
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output,
      ...(cli.unmeteredProvider ? { unmetered: true } : {}),
    };
  }
  if (cli.trustCustomEndpoint) raw.provider.trustCustomEndpoint = true;
  return validateConfig(raw);
}

function isLoopbackProviderHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

function providerFor(config: ConfigV1): ProviderAdapter {
  const remote = config.provider.name === "openai"
    || config.provider.name === "ollama" && config.provider.baseUrl !== undefined
      && !isLoopbackProviderHost(new URL(config.provider.baseUrl).hostname);
  if (remote && config.provider.pricing === undefined) {
    throw new ConfigError(
      "Remote generation requires provider.pricing input/output USD-per-million upper bounds so maxCostUsd cannot fail open.",
    );
  }
  if (config.provider.name === "openai") return createOpenAIProvider(config.provider);
  if (config.provider.name === "ollama") return createOllamaProvider(config.provider);
  throw new ConfigError(`Provider '${config.provider.name}' has no certified HTTP adapter in this release. Use openai or ollama.`);
}

async function safeProject(root: string): Promise<{ profile: ProjectProfileV1; config: ConfigV1; fromFile: boolean }> {
  // Load config first so its declared language can seed the ungrounded `general`
  // fallback when no framework is recognized. Standalone `analyze` deliberately
  // stays pure recognition and does not pass this hint.
  const { config, fromFile } = await loadConfig(root);
  const profile = await analyzeProject(root, { generalLanguage: config.language });
  return { profile, config, fromFile };
}

async function securityDiscovery(root: string, config: ConfigV1): Promise<Awaited<ReturnType<typeof discover>>> {
  const sources = await discover(root, config.filesToIgnore);
  const tracked = secretsTrackedError(sources.secretsFiles);
  if (tracked) throw new ContextSecurityError("SECRET_DETECTED", tracked);
  return sources;
}

async function planCommand(cli: CliOptions, sourceInput: string): Promise<number> {
  const root = projectRoot(cli);
  const { profile } = await safeProject(root);
  const exit = analysisExit(profile);
  if (exit !== 0) {
    output(cli.json ? profile : profileText(profile), cli.json);
    return exit;
  }
  const relPath = relativeInside(root, sourceInput);
  const source: SourceFile = { absPath: resolve(root, sourceInput), relPath, kind: "human", strictSibling: `${relPath.slice(0, -6)}.strict.human` };
  const draft = await createDraftContract(root, source, profile);
  await writeDraftContract(draft);
  const result = {
    status: "NEEDS_INPUT",
    contract: draft.contractPath,
    message: "Draft created. Review targetWorkspaces, targetSymbols, scope, acceptance criteria, risks, then remove the material REVIEW-1 question. Generation rejects unreviewed contracts.",
  };
  output(cli.json ? { ...result, draft: draft.contract } : `${result.message}\n${result.contract}`, cli.json);
  return 3;
}

async function loadContractFor(root: string, contractInput: string): Promise<{ profile: ProjectProfileV1; config: ConfigV1; contract: Awaited<ReturnType<typeof loadReviewedContract>> }> {
  const { profile, config } = await safeProject(root);
  const exit = analysisExit(profile);
  if (exit !== 0) throw new PlanningError("ANALYSIS_NOT_SUPPORTED", `Static analysis status is ${profile.status}.`);
  const contractPath = relativeInside(root, contractInput);
  const contract = await loadReviewedContract(root, contractPath, profile);
  return { profile, config, contract };
}

async function contextCommand(cli: CliOptions, contractInput: string): Promise<number> {
  if (!cli.explain) throw new ConfigError("context requires --explain because the exact outbound material must be reviewable.");
  const root = projectRoot(cli);
  const loaded = await loadContractFor(root, contractInput);
  const config = resolveWorkspaceConfig(overrideConfig(loaded.config, cli), loaded.profile, loaded.contract.contract);
  const manifest = await buildContextPreview(root, loaded.profile, loaded.contract.contract, config, cli.offline);
  if (cli.json) output(manifest, true);
  else {
    const lines = [
      `Context fingerprint: ${manifest.projectFingerprint}`,
      `Selected: ${manifest.evidence.length} items, ${manifest.budget.usedEstimatedTokens} estimated tokens, ${manifest.redactionCount} redactions`,
    ];
    for (const item of manifest.evidence) {
      const location = item.origin === "official_documentation" ? item.url : item.path;
      lines.push("", `--- ${location}:${item.startLine}-${item.endLine} [${item.sha256}] ---`, item.content);
    }
    for (const exclusion of manifest.exclusions) lines.push(`Excluded ${exclusion.location}: ${exclusion.code} — ${exclusion.reason}`);
    output(lines.join("\n"), false);
  }
  return 0;
}

async function generateCommand(cli: CliOptions, contractInput: string): Promise<{ code: number; outcome: WorkflowOutcome }> {
  const root = projectRoot(cli);
  const loaded = await loadContractFor(root, contractInput);
  const config = resolveWorkspaceConfig(overrideConfig(loaded.config, cli), loaded.profile, loaded.contract.contract);
  const provider = providerFor(config);
  const outcome = await generateRun({
    root,
    profile: loaded.profile,
    contract: loaded.contract.contract,
    config,
    provider,
    offline: cli.offline,
  });
  output(cli.json ? outcome : outcomeText(outcome), cli.json);
  return { code: outcomeExit(outcome), outcome };
}

async function validateCommand(cli: CliOptions, runId: string): Promise<number> {
  const outcome = await validateStoredRun({
    runId,
    sandboxImage: cli.sandboxImage,
    dockerBinary: cli.dockerBinary,
    manualChecksPassed: cli.manualPassed,
  });
  output(cli.json ? outcome : outcomeText(outcome), cli.json);
  return outcomeExit(outcome);
}

async function applyCommand(cli: CliOptions, runId: string): Promise<number> {
  const outcome = await applyVerifiedRun(runId);
  output(cli.json ? outcome : outcomeText(outcome), cli.json);
  return outcomeExit(outcome);
}

async function rollbackCommand(cli: CliOptions, runId: string): Promise<number> {
  const outcome = await rollbackAppliedRun(runId);
  output(cli.json ? outcome : outcomeText(outcome), cli.json);
  return outcomeExit(outcome);
}

async function checkCommand(cli: CliOptions, rootInput?: string): Promise<number> {
  const root = resolve(cli.root ?? rootInput ?? ".");
  const { profile, config } = await safeProject(root);
  const profileExit = analysisExit(profile);
  if (profileExit !== 0) {
    output(cli.json ? profile : profileText(profile), cli.json);
    return profileExit;
  }
  const sources = await securityDiscovery(root, config);
  const failures: string[] = [];
  for (const source of sources.human) {
    const contractPath = contractPathForSource(root, source);
    try {
      await loadReviewedContract(root, relative(root, contractPath), profile);
    } catch (error) {
      failures.push(`${source.relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    output(cli.json ? { status: "STALE", failures } : `Check failed:\n${failures.map((item) => `  ${item}`).join("\n")}`, cli.json);
    return 2;
  }
  output(cli.json ? { status: "VERIFIED", humanSources: sources.human.length, profileFingerprint: profile.fingerprint } : `Check passed: ${sources.human.length} .human source(s) have reviewed, current contracts.`, cli.json);
  return 0;
}

async function migrateConfigCommand(cli: CliOptions, rootInput?: string): Promise<number> {
  const root = resolve(cli.root ?? rootInput ?? ".");
  const path = resolve(root, CONFIG_FILENAME);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw new ConfigError(`${CONFIG_FILENAME} must be a bounded regular file.`);
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const migrated = migrateLegacyConfig(raw);
  const backup = `${path}.alpha.bak`;
  const temporary = `${path}.migrating`;
  await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
  try {
    await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  output(`Migrated ${path}. Original preserved at ${backup}.`, cli.json);
  return 0;
}

async function confirmYes(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(promptText)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

interface Spinner {
  /** Clear the spinner, print a line to stdout, then let the spinner resume. */
  note(line: string): void;
  /** Update the text shown next to the animated frame. */
  label(text: string): void;
  /** Stop and clear the spinner. */
  stop(): void;
}

/**
 * A single-line elapsed-time spinner on stderr, so live agent activity is
 * visible without corrupting stdout. Falls back to plain logging when stderr is
 * not a TTY (piped/CI), and does nothing animated in `--json` mode.
 */
function createSpinner(active: boolean): Spinner {
  if (!active || !process.stderr.isTTY) {
    return { note: (line) => console.log(line), label: () => undefined, stop: () => undefined };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let index = 0;
  let text = "working";
  const columns = (): number => (typeof process.stderr.columns === "number" && process.stderr.columns > 12 ? process.stderr.columns : 80);
  const clear = (): void => { process.stderr.write("\r[K"); };
  const tick = (): void => {
    index = (index + 1) % frames.length;
    const seconds = Math.round((Date.now() - started) / 1000);
    let line = `${frames[index] ?? ""} ${text} · ${seconds}s`;
    // Truncate to one terminal row: a wider line wraps, and the carriage-return
    // clear then cannot erase the wrapped remainder — that is what made the
    // spinner spew a new line per frame.
    const max = columns() - 1;
    if (line.length > max) line = `${line.slice(0, max - 1)}…`;
    process.stderr.write(`\r\x1b[K${line}`);
  };
  const timer = setInterval(tick, 120);
  if (typeof timer.unref === "function") timer.unref();
  return {
    note: (line) => { clear(); console.log(line); },
    label: (value) => { text = value; },
    stop: () => { clearInterval(timer); clear(); },
  };
}

/**
 * Simple `.human`/`@human` -> code flow: discover units, show a receipt, and on
 * confirmation write real code files. This is the default `human-to-code .`
 * behavior; the reviewed/validated pipeline is available under `guided`.
 */
async function buildCommand(cli: CliOptions, rootInput?: string): Promise<number> {
  const root = resolve(cli.root ?? rootInput ?? ".");
  const { config } = await loadConfig(root);
  const effective = overrideConfig(config, cli);
  const language = effective.language;
  const providerName = effective.provider.name;
  const model = effective.provider.model;
  const discovery = await discoverDirectUnits(root, language);
  const units = discovery.units;

  if (cli.json) {
    const plan = {
      status: units.length === 0 ? "NEEDS_INPUT" : cli.yes ? "GENERATING" : "NEEDS_CONFIRMATION",
      language,
      provider: providerName,
      model,
      requests: units.length,
      units: units.map((unit) => ({ kind: unit.kind, source: unit.sourcePath, output: unit.outputPath ?? unit.sourcePath })),
      notices: discovery.notices,
    };
    if (!cli.yes || units.length === 0) {
      output(plan, true);
      return units.length === 0 ? 3 : cli.yes ? 0 : 3;
    }
  } else {
    output(renderReceipt(units, providerName, model, language), false);
    for (const notice of discovery.notices) output(`  ! ${notice.message}`, false);
  }
  if (units.length === 0) return 3;
  if (cli.dryRun) {
    if (!cli.json) output("\nDry run: no code was generated.", false);
    return 0;
  }
  const proceed = cli.yes || await confirmYes("\nGenerate and write these files? [y/N] ");
  if (!proceed) {
    output(cli.json ? { status: "ABORTED" } : "Aborted. No files were written.", cli.json);
    return 3;
  }

  const baseUrl = effective.provider.baseUrl;
  const apiKey = providerName === "openai"
    ? process.env[effective.provider.apiKeyEnv ?? "OPENAI_API_KEY"]
    : undefined;
  const localProvider = providerName === "ollama"
    && (baseUrl === undefined || isLoopbackProviderHost(new URL(baseUrl).hostname));
  if (!localProvider && !effective.privacy.remoteProviderConsent) {
    throw new ContextSecurityError(
      "INVALID_CANDIDATE",
      "Direct conversion would send change instructions and possibly source context to a remote provider. Review the provider and set privacy.remoteProviderConsent to true first.",
    );
  }

  // Default engine: deterministic per-marker generation. Each marker is one
  // plain model completion (no tool calls), applied by exact range. One marker
  // failing never aborts the others.
  const describeUnit = (unit: ConversionUnit): string =>
    unit.kind === "file"
      ? `${unit.sourcePath} → ${unit.outputPath}`
      : `${unit.sourcePath} (inline @human, line ${unit.line ?? "?"})`;
  const interactive = !cli.json;
  const spinner = createSpinner(interactive);
  const started = Date.now();
  const onProgress = interactive
    ? (event: ConversionProgress): void => {
        if (event.kind === "start") {
          const retry = event.attempt > 1 ? ` (retry ${event.attempt - 1})` : "";
          spinner.label(`generating ${describeUnit(event.unit)}${retry}`);
        } else if (event.kind === "skip") {
          spinner.note(`  ⊘ skipped ${describeUnit(event.unit)}: ${event.reason}`);
        }
      }
    : undefined;

  if (interactive) output(`\nConverting ${units.length} item(s) with ${model}…`, false);
  let generated;
  try {
    generated = await generateConversionUnits(
      units,
      (unit, context) => {
        if (context.fileMemory
          && context.fileMemory.length > effective.privacy.maxContextTokens * 4) {
          throw new ContextSecurityError(
            "BUDGET_EXCEEDED",
            `FileMemory for ${unit.sourcePath} exceeds the configured context budget.`,
            unit.sourcePath,
          );
        }
        return generateCode(unit.prompt, {
          language,
          provider: providerName,
          model,
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...context,
        });
      },
      { retries: 1, validate: validateGeneratedUnit, ...(onProgress ? { onProgress } : {}) },
    );
  } catch (error) {
    spinner.stop();
    if (error instanceof ContextSecurityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output(cli.json ? { status: "FAILED", error: message } : `\nError: ${message}`, cli.json);
    return 5;
  }

  // Staged project-aware validation: every accepted JS/TS unit joins an
  // in-memory candidate overlay that is type-checked as one TypeScript
  // program against the unchanged baseline before any file is written.
  // Dependency-connected groups that introduce cross-file errors get one
  // bounded repair request per whole-file unit, then fail closed together.
  let repairRequests = 0;
  try {
    const onStagedProgress = interactive
      ? (event: StagedValidationProgress): void => {
          if (event.kind === "project-validate") {
            spinner.label(`validating combined candidate project (${event.files} file(s), pass ${event.pass})`);
          } else if (event.kind === "repair") {
            spinner.label(`repairing ${describeUnit(event.unit)} (bounded repair ${event.attempt})`);
          } else if (event.kind === "reject") {
            spinner.note(`  ⊘ skipped ${describeUnit(event.unit)}: ${event.reason}`);
          }
        }
      : undefined;
    const staged = await validateCandidateProject(root, generated, {
      maxRepairAttemptsPerUnit: 1,
      contextCharBudget: effective.privacy.maxContextTokens * 4,
      repair: (request) => generateRepairCode({
        targetPath: request.targetPath,
        inline: request.unit.kind === "inline",
        instruction: request.unit.prompt,
        currentCode: request.currentCode,
        diagnostics: request.diagnostics,
        relatedFiles: request.relatedFiles,
      }, {
        language,
        provider: providerName,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      }),
      ...(onStagedProgress ? { onProgress: onStagedProgress } : {}),
    });
    generated = staged.results;
    repairRequests = staged.repairRequests;
  } catch (error) {
    spinner.stop();
    if (error instanceof ContextSecurityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output(cli.json ? { status: "FAILED", error: message } : `\nError: ${message}`, cli.json);
    return 5;
  }
  spinner.stop();

  // Apply bottom-to-top so replacing a later marker cannot invalidate an
  // earlier marker's range.
  const ordered = [...generated].sort((left, right) => {
    if (left.unit.kind !== right.unit.kind) return left.unit.kind === "file" ? -1 : 1;
    const byPath = left.unit.sourcePath.localeCompare(right.unit.sourcePath);
    if (byPath !== 0) return byPath;
    return (right.unit.range?.start ?? 0) - (left.unit.range?.start ?? 0);
  });
  const written: string[] = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  for (const { unit, code, error } of ordered) {
    if (error !== undefined) {
      skipped.push({ source: unit.sourcePath, reason: error });
      continue; // already reported live via onProgress
    }
    if (code.trim().length === 0) {
      skipped.push({ source: unit.sourcePath, reason: "empty model output" });
      if (!cli.json) output(`  ⊘ skipped ${describeUnit(unit)}: empty model output`, false);
      continue;
    }
    try {
      const path = await applyUnit(root, unit, code);
      written.push(path);
      if (!cli.json) output(`  ✓ ${describeUnit(unit)}`, false);
    } catch (applyError) {
      const reason = applyError instanceof Error ? applyError.message : String(applyError);
      skipped.push({ source: unit.sourcePath, reason });
      if (!cli.json) output(`  ⊘ skipped ${describeUnit(unit)}: ${reason}`, false);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (cli.json) {
    output({ status: written.length === 0 && skipped.length > 0 ? "FAILED" : "DONE", engine: "simple", written, skipped, repairRequests }, true);
  } else {
    const repairs = repairRequests > 0 ? `, ${repairRequests} bounded repair request(s)` : "";
    output(`\nDone in ${seconds}s. ${written.length} written${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}${repairs}.`, false);
  }
  return written.length === 0 && skipped.length > 0 ? 5 : 0;
}

async function guided(cli: CliOptions, rootInput?: string): Promise<number> {
  const root = resolve(cli.root ?? rootInput ?? ".");
  const { profile, config: loadedConfig } = await safeProject(root);
  const profileExit = analysisExit(profile);
  if (profileExit !== 0) {
    output(cli.json ? profile : profileText(profile), cli.json);
    return profileExit;
  }
  if (cli.dryRun) {
    output(cli.json ? profile : profileText(profile), cli.json);
    return 0;
  }
  const config = overrideConfig(loadedConfig, cli);
  const sources = await securityDiscovery(root, config);
  let selected = sources.human;
  if (cli.file) {
    const wanted = relativeInside(root, cli.file);
    selected = selected.filter((source) => source.relPath === wanted);
  }
  if (selected.length === 0) {
    output(cli.json ? { status: "NEEDS_INPUT", message: "No matching .human change request was found.", profile } : `${profileText(profile)}\n\nNEEDS_INPUT: add a .human change request or select one with --file.`, cli.json);
    return 3;
  }
  if (selected.length > 1) {
    output(cli.json ? { status: "NEEDS_INPUT", sources: selected.map((source) => source.relPath) } : `NEEDS_INPUT: multiple .human sources exist; select one with --file:\n${selected.map((source) => `  ${source.relPath}`).join("\n")}`, cli.json);
    return 3;
  }
  const source = selected[0]!;
  const contractPath = contractPathForSource(root, source);
  let reviewed;
  try {
    reviewed = await loadReviewedContract(root, relative(root, contractPath), profile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof PlanningError && error.code === "UNREADABLE" && /ENOENT/u.test(error.message)) {
      const draft = await createDraftContract(root, source, profile);
      await writeDraftContract(draft);
      output(cli.json ? { status: "NEEDS_INPUT", contract: draft.contractPath, draft: draft.contract } : `Created review draft ${draft.contractPath}. Review and resolve REVIEW-1, then rerun the same npx command.`, cli.json);
      return 3;
    }
    output(cli.json ? { status: "NEEDS_INPUT", contract: contractPath, diagnostic: error instanceof Error ? error.message : String(error) } : `NEEDS_INPUT: ${error instanceof Error ? error.message : String(error)}\nReview ${contractPath}; generation will not bypass the contract gate.`, cli.json);
    return 3;
  }
  const effectiveConfig = resolveWorkspaceConfig(config, profile, reviewed.contract);
  const provider = providerFor(effectiveConfig);
  const generated = await generateRun({ root, profile, contract: reviewed.contract, config: effectiveConfig, provider, offline: cli.offline });
  if (generated.diff === undefined) {
    output(cli.json ? generated : outcomeText(generated), cli.json);
    return outcomeExit(generated);
  }
  const validated = await validateStoredRun({
    runId: generated.runId,
    sandboxImage: cli.sandboxImage,
    dockerBinary: cli.dockerBinary,
    manualChecksPassed: cli.manualPassed,
    provider,
    config: effectiveConfig,
  });
  output(cli.json ? validated : outcomeText(validated), cli.json);
  return outcomeExit(validated);
}

export async function run(argv: string[]): Promise<number> {
  let cli: CliOptions;
  try {
    cli = parse(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 1;
  }
  if (cli.help) {
    console.log(HELP);
    return 0;
  }
  try {
    if (cli.init) return initConfig(projectRoot(cli, cli.positionals[0] ?? "."));
    const first = cli.positionals[0];
    const command = first && COMMANDS.has(first) ? first : undefined;
    const args = command ? cli.positionals.slice(1) : cli.positionals;
    if (command === "analyze") {
      const profile = await analyzeProject(resolve(cli.root ?? args[0] ?? "."));
      output(cli.json ? profile : profileText(profile), cli.json);
      return analysisExit(profile);
    }
    if (command === "plan") {
      if (!args[0]) throw new ConfigError("plan requires a .human file.");
      return planCommand(cli, args[0]);
    }
    if (command === "context") {
      if (!args[0]) throw new ConfigError("context requires a reviewed contract path.");
      return contextCommand(cli, args[0]);
    }
    if (command === "generate") {
      if (!args[0]) throw new ConfigError("generate requires a reviewed contract path.");
      return (await generateCommand(cli, args[0])).code;
    }
    if (command === "validate") {
      if (!args[0]) throw new ConfigError("validate requires a run id.");
      return validateCommand(cli, args[0]);
    }
    if (command === "apply") {
      if (!args[0]) throw new ConfigError("apply requires a run id.");
      return applyCommand(cli, args[0]);
    }
    if (command === "rollback") {
      if (!args[0]) throw new ConfigError("rollback requires a run id.");
      return rollbackCommand(cli, args[0]);
    }
    if (command === "check") return checkCommand(cli, args[0]);
    if (command === "migrate-config") return migrateConfigCommand(cli, args[0]);
    if (command === "guided") return guided(cli, args[0]);
    if (command === "build" || command === "convert") return await buildCommand(cli, args[0]);
    return await buildCommand(cli, args[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ContextSecurityError) {
      output(cli.json ? { status: "SECURITY_BLOCKED", diagnostic: message } : `SECURITY_BLOCKED: ${message}`, cli.json);
      return 4;
    }
    if (error instanceof ProviderError) {
      output(cli.json ? { status: "FAILED", dependency: "provider", code: error.code, diagnostic: message } : `Provider ${error.code}: ${message}`, cli.json);
      return 5;
    }
    if (error instanceof DocumentationError) {
      output(cli.json ? { status: "INCONCLUSIVE", dependency: "documentation", code: error.code, diagnostic: message } : `Documentation ${error.code}: ${message}`, cli.json);
      return 5;
    }
    if (error instanceof DiscoveryError && error.code === "PARTIAL_SCAN") {
      output(cli.json ? { status: "FAILED", code: error.code, diagnostic: message } : `Partial scan: ${message}`, cli.json);
      return 6;
    }
    if (error instanceof PlanningError && ["STALE_PROFILE", "STALE_SOURCE", "INVALID_CONTRACT"].includes(error.code)) {
      output(cli.json ? { status: "STALE", code: error.code, diagnostic: message } : `Stale or invalid contract: ${message}`, cli.json);
      return 2;
    }
    if (error instanceof ConfigError || error instanceof PlanningError || error instanceof DiscoveryError) {
      output(cli.json ? { status: "ERROR", diagnostic: message } : `Error: ${message}`, cli.json);
      return 1;
    }
    console.error(error instanceof Error ? error.stack ?? message : message);
    return 6;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 6;
    });
}
