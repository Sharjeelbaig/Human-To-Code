#!/usr/bin/env node
/**
 * The CLI shell. Exposes the conversion flow and prints the results. The
 * actual conversion policy lives in the direct agent.
 */

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONFIG_FILENAME,
  ConfigError,
  defaultConfigJson,
  defaultModelFor,
  loadConfig,
  validateConfig,
  type ConfigV1,
} from "./config/config.ts";
import { ContextSecurityError } from "./context/context.ts";
import { DiscoveryError } from "./config/discovery.ts";
import { ProviderError, type ProviderAdapter } from "./providers/provider.ts";
import {
  createOllamaProvider,
  createOpenAIProvider,
} from "./providers/providers.ts";
import {
  applyWholeFileBatch,
  applyInlineFileBatch,
  buildProjectMemory,
  collectReferenceFindings,
  candidateTextsForGenerated,
  normalizeGeneratedUnitCode,
  conditionalRequestAllowance,
  plannedRequestCounts,
  discoverDirectUnits,
  generateBlueprint,
  generateConversionUnits,
  generateCode,
  generateIntegrationAudit,
  generateIntegrationRepairCode,
  generateRepairCode,
  generateUnitTodos,
  parseProjectBlueprint,
  parseUnitTodoList,
  reconcileGeneratedIntegrations,
  REFERENCE_EXTENSIONS,
  renderBlueprintFor,
  renderReceipt,
  validateCandidateProject,
  validateGeneratedUnit,
  withholdIncompleteRelatedTargets,
  type ConversionUnit,
  type ConversionProgress,
  type IntegrationProgress,
  type GeneratedConversionUnit,
  type ProjectBlueprint,
  type ReferenceFile,
  type ReferenceFinding,
  type StagedValidationProgress,
  type UnitPlanningOutcome,
} from "./agents/direct/index.ts";
import type { ProviderName } from "./core/types.ts";

const HELP = `human-to-code - turn plain-language requests into code

Usage:
  human-to-code [root] [-y]                    Convert .human files and @human markers to code
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
  --json                         Machine-readable output
  -y, --yes                      Skip the confirmation prompt and write files
  --dry-run                      Analyze and preview only; perform no generation
  -h, --help                     Show this help

Exit codes:
  0 successful command
  1 usage or configuration error
  3 needs input or unsupported
  4 security blocked
  5 provider dependency failure
  6 internal error or partial scan
`;

const PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "ollama",
  "grok",
  "gemini",
];

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
    ...(typeof values.provider === "string"
      ? { provider: values.provider }
      : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values["base-url"] === "string"
      ? { baseUrl: values["base-url"] }
      : {}),
    ...(typeof values["api-key-env"] === "string"
      ? { apiKeyEnv: values["api-key-env"] }
      : {}),
    ...(typeof values["input-cost-per-million"] === "string"
      ? { inputCostPerMillion: values["input-cost-per-million"] }
      : {}),
    ...(typeof values["output-cost-per-million"] === "string"
      ? { outputCostPerMillion: values["output-cost-per-million"] }
      : {}),
    unmeteredProvider: values["unmetered-provider"] === true,
    ...(typeof values["sandbox-image"] === "string"
      ? { sandboxImage: values["sandbox-image"] }
      : {}),
    ...(typeof values["docker-binary"] === "string"
      ? { dockerBinary: values["docker-binary"] }
      : {}),
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

function projectRoot(cli: CliOptions, fallback = "."): string {
  return resolve(cli.root ?? fallback);
}

async function initConfig(root: string): Promise<number> {
  const target = resolve(root, CONFIG_FILENAME);
  try {
    await writeFile(target, defaultConfigJson(), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ConfigError(
        `${CONFIG_FILENAME} already exists; it was not overwritten.`,
      );
    throw error;
  }
  console.log(
    `Wrote ${target}. Review provider, model, privacy consent, sandbox, and budgets before remote generation.`,
  );
  return 0;
}

function overrideConfig(config: ConfigV1, cli: CliOptions): ConfigV1 {
  const raw = structuredClone(config) as ConfigV1;
  if (cli.provider !== undefined) {
    if (!PROVIDERS.includes(cli.provider as ProviderName))
      throw new ConfigError(
        `Unknown provider ${JSON.stringify(cli.provider)}.`,
      );
    const name = cli.provider as ProviderName;
    if (raw.provider.name !== name) {
      raw.provider = { name, model: cli.model ?? defaultModelFor(name) };
    }
  }
  if (cli.model !== undefined) raw.provider.model = cli.model;
  if (cli.baseUrl !== undefined) raw.provider.baseUrl = cli.baseUrl;
  if (cli.apiKeyEnv !== undefined) raw.provider.apiKeyEnv = cli.apiKeyEnv;
  if (
    cli.inputCostPerMillion !== undefined ||
    cli.outputCostPerMillion !== undefined ||
    cli.unmeteredProvider
  ) {
    const input =
      cli.inputCostPerMillion === undefined
        ? raw.provider.pricing?.inputUsdPerMillionTokens
        : Number(cli.inputCostPerMillion);
    const output =
      cli.outputCostPerMillion === undefined
        ? raw.provider.pricing?.outputUsdPerMillionTokens
        : Number(cli.outputCostPerMillion);
    if (input === undefined || output === undefined) {
      throw new ConfigError(
        "Both remote input and output cost upper bounds are required.",
      );
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
  const host = hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  );
}

function providerFor(config: ConfigV1): ProviderAdapter {
  const remote =
    config.provider.name === "openai" ||
    (config.provider.name === "ollama" &&
      config.provider.baseUrl !== undefined &&
      !isLoopbackProviderHost(new URL(config.provider.baseUrl).hostname));
  if (remote && config.provider.pricing === undefined) {
    throw new ConfigError(
      "Remote generation requires provider.pricing input/output USD-per-million upper bounds so maxCostUsd cannot fail open.",
    );
  }
  if (config.provider.name === "openai")
    return createOpenAIProvider(config.provider);
  if (config.provider.name === "ollama")
    return createOllamaProvider(config.provider);
  throw new ConfigError(
    `Provider '${config.provider.name}' has no certified HTTP adapter in this release. Use openai or ollama.`,
  );
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
    return {
      note: (line) => console.log(line),
      label: () => undefined,
      stop: () => undefined,
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let index = 0;
  let text = "working";
  const columns = (): number =>
    typeof process.stderr.columns === "number" && process.stderr.columns > 12
      ? process.stderr.columns
      : 80;
  const clear = (): void => {
    process.stderr.write("\r[K");
  };
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
    note: (line) => {
      clear();
      console.log(line);
    },
    label: (value) => {
      text = value;
    },
    stop: () => {
      clearInterval(timer);
      clear();
    },
  };
}

/**
 * Simple `.human`/`@human` -> code flow: discover units, show a receipt, and on
 * confirmation write real code files. This is the default `human-to-code .`
 * behavior.
 */
async function buildCommand(
  cli: CliOptions,
  rootInput?: string,
): Promise<number> {
  const root = resolve(cli.root ?? rootInput ?? ".");
  const { config } = await loadConfig(root);
  const effective = overrideConfig(config, cli);
  const language = effective.language;
  const languages = effective.languages;
  const providerName = effective.provider.name;
  const model = effective.provider.model;
  const discovery = await discoverDirectUnits(
    root,
    languages,
    effective.humanFileExtensions,
  );
  const units = discovery.units;
  const conditionalRequests = effective.direct.reconcileIntegrations
    ? conditionalRequestAllowance(units, languages)
    : undefined;

  if (cli.json) {
    const plan = {
      status:
        units.length === 0
          ? "NEEDS_INPUT"
          : cli.yes
            ? "GENERATING"
            : "NEEDS_CONFIRMATION",
      language,
      languages,
      provider: providerName,
      model,
      context: "project-memory-v1",
      // `requests` keeps its established meaning — the planned minimum — so an
      // existing consumer is not silently redefined. The breakdown is additive.
      requests: units.length,
      plannedRequests: plannedRequestCounts(units, effective.direct.planning),
      ...(conditionalRequests !== undefined
        ? {
            additionalRequests: {
              conditional: true,
              integrationAuditUpTo: conditionalRequests.integrationAuditUpTo,
              integrationRepairUpTo: conditionalRequests.integrationRepairUpTo,
              compilerRepairUpTo: conditionalRequests.compilerRepairUpTo,
            },
          }
        : {}),
      units: units.map((unit) => ({
        kind: unit.kind,
        source: unit.sourcePath,
        output: unit.outputPath ?? unit.sourcePath,
        language: unit.language ?? language,
      })),
      notices: discovery.notices,
    };
    if (!cli.yes || units.length === 0) {
      output(plan, true);
      return units.length === 0 ? 3 : cli.yes ? 0 : 3;
    }
  } else {
    output(
      renderReceipt(units, providerName, model, languages, {
        reconcileIntegrations: effective.direct.reconcileIntegrations,
        planning: effective.direct.planning,
      }),
      false,
    );
    for (const notice of discovery.notices)
      output(`  ! ${notice.message}`, false);
  }
  if (units.length === 0) return 3;
  if (cli.dryRun) {
    if (!cli.json) output("\nDry run: no code was generated.", false);
    return 0;
  }
  const proceed =
    cli.yes || (await confirmYes("\nGenerate and write these files? [y/N] "));
  if (!proceed) {
    output(
      cli.json ? { status: "ABORTED" } : "Aborted. No files were written.",
      cli.json,
    );
    return 3;
  }

  const baseUrl = effective.provider.baseUrl;
  const apiKey =
    providerName === "openai"
      ? process.env[effective.provider.apiKeyEnv ?? "OPENAI_API_KEY"]
      : undefined;
  const localProvider =
    providerName === "ollama" &&
    (baseUrl === undefined ||
      isLoopbackProviderHost(new URL(baseUrl).hostname));
  if (!localProvider && !effective.privacy.remoteProviderConsent) {
    throw new ContextSecurityError(
      "INVALID_CANDIDATE",
      "Direct conversion would send change instructions and possibly source context to a remote provider. Review the provider and set privacy.remoteProviderConsent to true first.",
    );
  }

  const contextCharBudget = effective.privacy.maxContextTokens * 4;
  const projectMemory = await buildProjectMemory(root, units, {
    scannedPaths: discovery.scannedPaths,
    ignoredNames: effective.filesToIgnore,
    excludedPaths: effective.privacy.excludedPaths,
    maxFileBytes: effective.privacy.maxFileBytes,
  });

  // Default engine: deterministic per-target generation, optionally preceded by
  // a shared planning pass. One target failing never aborts the others.
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
          const retry =
            event.attempt > 1 ? ` (retry ${event.attempt - 1})` : "";
          spinner.label(`generating ${describeUnit(event.unit)}${retry}`);
        } else if (event.kind === "plan") {
          spinner.label(`planning ${describeUnit(event.unit)}`);
        } else if (event.kind === "refine") {
          spinner.label(
            `completing ${describeUnit(event.unit)} (${event.unaddressed} unaddressed item(s))`,
          );
        } else if (event.kind === "skip") {
          spinner.note(
            `  ⊘ skipped ${describeUnit(event.unit)}: ${event.reason}`,
          );
        }
      }
    : undefined;

  if (interactive)
    output(`\nConverting ${units.length} item(s) with ${model}…`, false);

  const planning = effective.direct.planning;
  const requestOptions = {
    provider: providerName,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  // One shared planning request, before any file is generated. Each target is
  // generated in isolation afterwards, so this is the only chance for them to
  // agree on names. Best-effort: a failure loses the shared contract, never the
  // run.
  const plannedTargets = projectMemory.plannedTargets;
  let blueprint: ProjectBlueprint | undefined;
  let blueprintRequests = 0;
  let blueprintNotice: string | undefined;
  const wholeFileTargets = new Set(
    units.filter((unit) => unit.kind === "file").map((unit) => unit.outputPath),
  );
  if (
    planning.enabled &&
    planning.projectBlueprint &&
    wholeFileTargets.size >= 2
  ) {
    if (interactive)
      spinner.label(
        `agreeing a shared contract across ${plannedTargets.length} file(s)`,
      );
    blueprintRequests = 1;
    try {
      const raw = await generateBlueprint(
        {
          targets: plannedTargets.map((target) => ({
            path: target.path,
            language: target.language,
            instruction: target.purposes.join(" | "),
          })),
          currentTree: discovery.scannedPaths.slice(0, 72),
        },
        { ...requestOptions, language },
      );
      blueprint = parseProjectBlueprint(
        raw,
        new Set(plannedTargets.map((target) => target.path)),
      );
      projectMemory.adoptBlueprint(blueprint);
    } catch (error) {
      blueprintNotice =
        `shared contract unavailable (${error instanceof Error ? error.message : String(error)});` +
        " files were generated without it";
      if (interactive) spinner.note(`  ! ${blueprintNotice}`);
    }
  }
  // One todo request per unit, when its kind is enabled. Returning undefined
  // leaves that unit on the single-pass path.
  const planningOutcomes: UnitPlanningOutcome[] = [];
  const todoEnabled = (unit: ConversionUnit): boolean =>
    planning.enabled &&
    (unit.kind === "file" ? planning.fileTodo : planning.markerTodo);
  const planningEnabledFor =
    planning.enabled && (planning.fileTodo || planning.markerTodo)
      ? async (unit: ConversionUnit, context: { projectMemory?: string }) => {
          if (!todoEnabled(unit)) return undefined;
          const target =
            unit.kind === "file" ? unit.outputPath! : unit.sourcePath;
          const raw = await generateUnitTodos(
            {
              targetPath: target,
              instruction: unit.prompt,
              inline: unit.kind === "inline",
              ...(blueprint
                ? { blueprint: renderBlueprintFor(blueprint, target) }
                : {}),
              ...(context.projectMemory
                ? { projectMemory: context.projectMemory }
                : {}),
            },
            {
              ...requestOptions,
              language: unit.language ?? language,
              targetPath: target,
            },
          );
          // Deliberately unconstrained by the shared vocabulary: a todo may also
          // expect target-local artifacts the blueprint has no reason to name
          // (a @media block, a local helper). Injection safety comes from the
          // name charset in the parser, and cross-file drift is caught
          // deterministically by reference checking, not by dropping coverage.
          return parseUnitTodoList(raw);
        }
      : undefined;
  let generated: GeneratedConversionUnit[];
  try {
    generated = await generateConversionUnits(
      units,
      (unit, context) => {
        if (
          (context.fileMemory?.length ?? 0) +
            (context.projectMemory?.length ?? 0) >
          contextCharBudget
        ) {
          throw new ContextSecurityError(
            "BUDGET_EXCEEDED",
            `Combined FileMemory and ProjectMemory for ${unit.sourcePath} exceed the configured context budget.`,
            unit.sourcePath,
          );
        }
        return generateCode(unit.prompt, {
          language: unit.language ?? language,
          ...requestOptions,
          targetPath: unit.kind === "file" ? unit.outputPath! : unit.sourcePath,
          ...(unit.insertionContext
            ? { insertionContext: unit.insertionContext }
            : {}),
          ...(unit.insertionOwner
            ? { insertionOwner: unit.insertionOwner }
            : {}),
          ...(unit.surroundingSource
            ? { surroundingSource: unit.surroundingSource }
            : {}),
          ...context,
        }).then((code) => normalizeGeneratedUnitCode(unit, code));
      },
      {
        retries: 1,
        validate: validateGeneratedUnit,
        projectMemory,
        contextCharBudget,
        maxCodingPasses: planning.enabled ? planning.maxCodingPassesPerUnit : 1,
        ...(planningEnabledFor !== undefined
          ? { plan: planningEnabledFor }
          : {}),
        ...(planningEnabledFor !== undefined
          ? { shouldPlan: todoEnabled }
          : {}),
        onPlanningOutcome: (outcome) => planningOutcomes.push(outcome),
        ...(onProgress ? { onProgress } : {}),
      },
    );
  } catch (error) {
    spinner.stop();
    if (error instanceof ContextSecurityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output(
      cli.json ? { status: "FAILED", error: message } : `\nError: ${message}`,
      cli.json,
    );
    return 5;
  }

  generated = withholdIncompleteRelatedTargets(generated, projectMemory);

  // Deterministic cross-file reference checking over complete candidate
  // files. One bounded repair is allowed for findings that prove generated
  // behavior is unreachable.
  const crossCheckGeneratedReferences = async (): Promise<
    ReferenceFinding[]
  > => {
    const referenceFiles: ReferenceFile[] = [];
    const seenReferencePaths = new Set<string>();
    const completeCandidates = await candidateTextsForGenerated(generated);
    for (const [target, content] of completeCandidates) {
      if (
        !REFERENCE_EXTENSIONS.has(extname(target).toLowerCase()) ||
        seenReferencePaths.has(target)
      )
        continue;
      seenReferencePaths.add(target);
      referenceFiles.push({ path: target, content, generated: true });
    }
    for (const path of discovery.scannedPaths) {
      if (
        seenReferencePaths.has(path) ||
        !REFERENCE_EXTENSIONS.has(extname(path).toLowerCase())
      )
        continue;
      try {
        const content = await readFile(resolve(root, path), "utf8");
        seenReferencePaths.add(path);
        referenceFiles.push({ path, content, generated: false });
      } catch {
        continue;
      }
    }
    return collectReferenceFindings(referenceFiles);
  };

  let referenceFindings: ReferenceFinding[] = [];
  let referenceRepairRequests = 0;
  if (effective.direct.crossFileChecks) {
    if (interactive) spinner.label("cross-checking generated references");
    referenceFindings = await crossCheckGeneratedReferences();
    const blockingByPath = new Map<string, ReferenceFinding[]>();
    for (const finding of referenceFindings.filter(
      (item) => item.severity === "blocking",
    )) {
      blockingByPath.set(finding.path, [
        ...(blockingByPath.get(finding.path) ?? []),
        finding,
      ]);
    }

    for (const [path, findings] of blockingByPath) {
      const candidates = generated.filter(
        (item) =>
          (item.unit.kind === "file"
            ? item.unit.outputPath
            : item.unit.sourcePath) === path &&
          item.error === undefined &&
          item.code.trim().length > 0,
      );
      if (candidates.length === 0) continue;
      const selector = findings.find((finding) => finding.selector)?.selector;
      const item =
        selector === undefined
          ? candidates[candidates.length - 1]!
          : (candidates.find((candidate) =>
              candidate.code.includes(selector),
            ) ?? candidates[candidates.length - 1]!);
      const completeCandidates = await candidateTextsForGenerated(generated);
      const relatedFiles = [...completeCandidates]
        .filter(([relatedPath]) => relatedPath !== path)
        .slice(0, 8)
        .map(([relatedPath, content]) => ({ path: relatedPath, content }));
      try {
        if (interactive)
          spinner.label(`repairing unreachable generated behavior in ${path}`);
        referenceRepairRequests += 1;
        const repaired = await generateRepairCode(
          {
            targetPath: path,
            inline: item.unit.kind === "inline",
            instruction: item.unit.prompt,
            currentCode: item.code,
            diagnostics: findings.map((finding) => ({
              path: finding.path,
              code: 9001,
              message: `${finding.code}: ${finding.detail}`,
            })),
            hints: [
              "Make the generated selector or reference match the actual structure in the related candidate files.",
              ...(findings.some(
                (finding) => finding.code === "EMPTY_VISUAL_ZERO_SIZE",
              )
                ? [
                    "An empty visual element needs a real box. Add dimensions or stretch it from a positioned containing block, for example with absolute positioning and inset.",
                  ]
                : []),
              "Preserve the original instruction and change only this marker replacement.",
            ],
            relatedFiles,
            projectMemory: projectMemory.renderFor(
              item.unit,
              Math.floor(contextCharBudget / 3),
            ),
          },
          {
            language: item.unit.language ?? language,
            provider: providerName,
            model,
            targetPath: path,
            ...(baseUrl ? { baseUrl } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
        );
        item.code = normalizeGeneratedUnitCode(item.unit, repaired);
        await validateGeneratedUnit(item.unit, item.code);
        projectMemory.remember(item.unit, item.code);
      } catch (error) {
        if (error instanceof ContextSecurityError) throw error;
      }
    }

    if (blockingByPath.size > 0)
      referenceFindings = await crossCheckGeneratedReferences();
    const remainingBlocking = referenceFindings.filter(
      (finding) => finding.severity === "blocking",
    );
    for (const finding of remainingBlocking) {
      const reason = `cross-file behavior check failed: ${finding.detail}`;
      for (const item of generated) {
        const target =
          item.unit.kind === "file"
            ? item.unit.outputPath!
            : item.unit.sourcePath;
        if (target !== finding.path || item.error !== undefined) continue;
        item.error = reason;
        item.code = "";
      }
    }
    generated = withholdIncompleteRelatedTargets(generated, projectMemory);
    if (interactive) {
      for (const finding of referenceFindings) {
        spinner.note(
          `  ${finding.severity === "blocking" ? "no" : "!"} ${finding.code}: ${finding.detail}`,
        );
      }
    }
  }

  // bounded audit -> target repair -> verification cycle over generated groups.
  let integrationAuditRequests = 0;
  let integrationRepairRequests = 0;
  if (effective.direct.reconcileIntegrations) {
    try {
      const onIntegrationProgress = interactive
        ? (event: IntegrationProgress): void => {
            if (event.kind === "integration-audit") {
              spinner.label(
                `auditing ${event.files} related generated file(s) (pass ${event.pass})`,
              );
            } else if (event.kind === "integration-repair") {
              spinner.label(
                `reconciling ${describeUnit(event.unit)} (${event.issues} issue(s))`,
              );
            } else if (event.kind === "reject") {
              spinner.note(
                `  ⊘ skipped ${describeUnit(event.unit)}: ${event.reason}`,
              );
            }
          }
        : undefined;
      const integrated = await reconcileGeneratedIntegrations(generated, {
        maxAuditPassesPerGroup: 2,
        maxRepairAttemptsPerUnit: 1,
        contextCharBudget,
        audit: (request) =>
          generateIntegrationAudit(
            {
              files: request.files,
              relationships: request.relationships,
              ...(request.projectMemory
                ? { projectMemory: request.projectMemory }
                : {}),
            },
            {
              language: request.unit.language ?? language,
              provider: providerName,
              model,
              ...(baseUrl ? { baseUrl } : {}),
              ...(apiKey ? { apiKey } : {}),
            },
          ),
        repair: (request) =>
          generateIntegrationRepairCode(
            {
              targetPath: request.targetPath,
              instruction: request.instruction,
              currentCode: request.currentCode,
              issues: request.issues,
              relatedFiles: request.relatedFiles,
              ...(request.projectMemory
                ? { projectMemory: request.projectMemory }
                : {}),
            },
            {
              language: request.unit.language ?? language,
              provider: providerName,
              model,
              targetPath: request.targetPath,
              ...(baseUrl ? { baseUrl } : {}),
              ...(apiKey ? { apiKey } : {}),
            },
          ),
        projectMemory,
        ...(onIntegrationProgress ? { onProgress: onIntegrationProgress } : {}),
      });
      generated = integrated.results;
      integrationAuditRequests = integrated.auditRequests;
      integrationRepairRequests = integrated.repairRequests;
    } catch (error) {
      spinner.stop();
      if (error instanceof ContextSecurityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      output(
        cli.json ? { status: "FAILED", error: message } : `\nError: ${message}`,
        cli.json,
      );
      return 5;
    }
  }

  // Staged project-aware validation: every accepted JS/TS unit joins an
  // in-memory candidate overlay. TypeScript and explicitly opted-in JavaScript
  // are type-checked against the unchanged baseline before any file is written.
  // Dependency-connected groups that introduce cross-file errors get one
  // bounded repair request per whole-file unit, then fail closed together.
  let repairRequests = referenceRepairRequests;
  try {
    const onStagedProgress = interactive
      ? (event: StagedValidationProgress): void => {
          if (event.kind === "project-validate") {
            spinner.label(
              `validating combined candidate project (${event.files} file(s), pass ${event.pass})`,
            );
          } else if (event.kind === "repair") {
            spinner.label(
              `repairing ${describeUnit(event.unit)} (bounded repair ${event.attempt})`,
            );
          } else if (event.kind === "reject") {
            spinner.note(
              `  ⊘ skipped ${describeUnit(event.unit)}: ${event.reason}`,
            );
          }
        }
      : undefined;
    const staged = await validateCandidateProject(root, generated, {
      maxRepairAttemptsPerUnit: 1,
      contextCharBudget: effective.privacy.maxContextTokens * 4,
      repair: (request) =>
        generateRepairCode(
          {
            targetPath: request.targetPath,
            inline: request.unit.kind === "inline",
            instruction: request.unit.prompt,
            currentCode: request.currentCode,
            diagnostics: request.diagnostics,
            hints: request.hints,
            relatedFiles: request.relatedFiles,
            ...(request.projectMemory
              ? { projectMemory: request.projectMemory }
              : {}),
          },
          {
            language: request.unit.language ?? language,
            provider: providerName,
            model,
            targetPath: request.targetPath,
            ...(baseUrl ? { baseUrl } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
        ),
      projectMemory,
      ...(onStagedProgress ? { onProgress: onStagedProgress } : {}),
    });
    generated = staged.results;
    repairRequests += staged.repairRequests;
  } catch (error) {
    spinner.stop();
    if (error instanceof ContextSecurityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    output(
      cli.json ? { status: "FAILED", error: message } : `\nError: ${message}`,
      cli.json,
    );
    return 5;
  }
  spinner.stop();

  generated = withholdIncompleteRelatedTargets(generated, projectMemory);

  // Apply bottom-to-top so replacing a later marker cannot invalidate an
  // earlier marker's range.
  const ordered = [...generated].sort((left, right) => {
    if (left.unit.kind !== right.unit.kind)
      return left.unit.kind === "file" ? -1 : 1;
    const byPath = left.unit.sourcePath.localeCompare(right.unit.sourcePath);
    if (byPath !== 0) return byPath;
    return (right.unit.range?.start ?? 0) - (left.unit.range?.start ?? 0);
  });
  const written: string[] = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const wholeFiles = ordered.filter((item) => item.unit.kind === "file");
  const incompleteWholeFiles = wholeFiles.filter(
    (item) => item.error !== undefined || item.code.trim().length === 0,
  );
  if (incompleteWholeFiles.length > 0) {
    const blocker = incompleteWholeFiles[0]!;
    const blockerReason = blocker.error ?? "empty model output";
    const batchReason = `whole-file conversion batch was withheld because ${blocker.unit.sourcePath} failed: ${blockerReason}`;
    for (const item of wholeFiles) {
      if (item.error !== undefined || item.code.trim().length === 0) continue;
      item.error = batchReason;
      item.code = "";
      if (!cli.json)
        output(`  ⊘ skipped ${describeUnit(item.unit)}: ${batchReason}`, false);
    }
  }

  const applicableWholeFiles = wholeFiles.filter(
    (item) => item.error === undefined && item.code.trim().length > 0,
  );
  if (applicableWholeFiles.length > 0) {
    try {
      const paths = await applyWholeFileBatch(root, applicableWholeFiles);
      written.push(...paths);
      if (!cli.json) {
        for (const item of applicableWholeFiles)
          output(`  ✓ ${describeUnit(item.unit)}`, false);
      }
    } catch (applyError) {
      const reason =
        applyError instanceof Error ? applyError.message : String(applyError);
      for (const item of applicableWholeFiles) {
        skipped.push({ source: item.unit.sourcePath, reason });
        if (!cli.json)
          output(`  ⊘ skipped ${describeUnit(item.unit)}: ${reason}`, false);
      }
    }
  }
  for (const item of wholeFiles) {
    if (item.error !== undefined)
      skipped.push({ source: item.unit.sourcePath, reason: item.error });
    else if (item.code.trim().length === 0)
      skipped.push({
        source: item.unit.sourcePath,
        reason: "empty model output",
      });
  }

  const inline = ordered.filter((item) => item.unit.kind === "inline");
  for (const item of inline) {
    if (item.error !== undefined)
      skipped.push({ source: item.unit.sourcePath, reason: item.error });
    else if (item.code.trim().length === 0)
      skipped.push({
        source: item.unit.sourcePath,
        reason: "empty model output",
      });
  }
  const applicableInlineByPath = new Map<string, typeof inline>();
  for (const item of inline.filter(
    (entry) => entry.error === undefined && entry.code.trim().length > 0,
  )) {
    applicableInlineByPath.set(item.unit.sourcePath, [
      ...(applicableInlineByPath.get(item.unit.sourcePath) ?? []),
      item,
    ]);
  }
  for (const applications of applicableInlineByPath.values()) {
    try {
      const path = await applyInlineFileBatch(applications);
      written.push(path);
      if (!cli.json)
        for (const item of applications)
          output(`  yes ${describeUnit(item.unit)}`, false);
    } catch (applyError) {
      const reason =
        applyError instanceof Error ? applyError.message : String(applyError);
      for (const item of applications) {
        skipped.push({ source: item.unit.sourcePath, reason });
        if (!cli.json)
          output(`  no skipped ${describeUnit(item.unit)}: ${reason}`, false);
      }
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const todoRequests = planningOutcomes.reduce(
    (total, outcome) => total + outcome.todoRequests,
    0,
  );
  const codingRequests = planningOutcomes.reduce(
    (total, outcome) => total + outcome.codingRequests,
    0,
  );
  const refinementsRejected = planningOutcomes.filter(
    (outcome) => outcome.refinementRejected !== undefined,
  );
  if (cli.json) {
    output(
      {
        status: written.length === 0 && skipped.length > 0 ? "FAILED" : "DONE",
        engine: "simple",
        written,
        skipped,
        blueprintRequests,
        ...(blueprintNotice !== undefined ? { blueprintNotice } : {}),
        todoRequests,
        codingRequests,
        ...(refinementsRejected.length > 0
          ? {
              refinementsRejected: refinementsRejected.map((outcome) => ({
                target:
                  outcome.unit.kind === "file"
                    ? outcome.unit.outputPath!
                    : outcome.unit.sourcePath,
                reason: outcome.refinementRejected!,
              })),
            }
          : {}),
        ...(effective.direct.crossFileChecks
          ? {
              referenceFindings: referenceFindings.map((finding) => ({
                code: finding.code,
                severity: finding.severity,
                path: finding.path,
                detail: finding.detail,
              })),
            }
          : {}),
        ...(effective.direct.reconcileIntegrations
          ? {
              integrationAuditRequests,
              integrationRepairRequests,
              integrationRequests:
                integrationAuditRequests + integrationRepairRequests,
            }
          : {}),
        repairRequests,
      },
      true,
    );
  } else {
    const integrationRequests =
      integrationAuditRequests + integrationRepairRequests;
    const integrations =
      integrationRequests > 0
        ? `, ${integrationAuditRequests} integration audit request(s), ${integrationRepairRequests} integration repair request(s)`
        : "";
    const repairs =
      repairRequests > 0 ? `, ${repairRequests} bounded repair request(s)` : "";
    const planned =
      blueprintRequests + todoRequests > 0
        ? `, ${blueprintRequests} blueprint and ${todoRequests} todo request(s)`
        : "";
    output(
      `\nDone in ${seconds}s. ${written.length} written${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}${planned}${integrations}${repairs}.`,
      false,
    );
    for (const outcome of refinementsRejected) {
      const target =
        outcome.unit.kind === "file"
          ? outcome.unit.outputPath!
          : outcome.unit.sourcePath;
      output(`  ! ${target}: ${outcome.refinementRejected}`, false);
    }
  }
  return written.length === 0 && skipped.length > 0 ? 5 : 0;
}

/** Runs the direct conversion workflow. */
export async function runHumanToCodeCli(argv: string[]): Promise<number> {
  let cli: CliOptions;
  try {
    cli = parse(argv);
  } catch (error) {
    // this block runs when the user provides invalid arguments like `npx human-to-code . --xyzblahblah`
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 1;
  }
  if (cli.help) {
    // this block runs when the user types `npx human-to-code --help` or `npx human-to-code -h`
    console.log(HELP);
    return 0;
  }
  try {
    if (cli.init) {
      // This codeblock runs when the user passes the init flag for example `npx human-to-code . --init`
      return initConfig(projectRoot(cli, cli.positionals[0] ?? "."));
    }
    return await buildCommand(cli, cli.positionals[0]);
  } catch (error) {
    // these are error scenarios after successfully running the build command, for example, provider errors, discovery errors, etc.
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ContextSecurityError) {
      // To reproduce: Run the CLI without adding `"remoteProviderConsent": true` to your config, while explicitly asking for a remote provider:
      // npx human-to-code . --provider openai
      output(
        cli.json
          ? { status: "SECURITY_BLOCKED", diagnostic: message }
          : `SECURITY_BLOCKED: ${message}`,
        cli.json,
      );
      return 4;
    }
    if (error instanceof ProviderError) {
      // To reproduce: Pass an invalid API key via the environment variable and force remote generation:
      // OPENAI_API_KEY=sk-fakekey npx human-to-code . --provider openai -y
      output(
        cli.json
          ? {
              status: "FAILED",
              dependency: "provider",
              code: error.code,
              diagnostic: message,
            }
          : `Provider ${error.code}: ${message}`,
        cli.json,
      );
      return 5;
    }
    if (error instanceof DiscoveryError && error.code === "PARTIAL_SCAN") {
      // To reproduce: Create a directory you don't have read access to in the project root:
      // mkdir unreadable_dir && chmod 000 unreadable_dir && npx human-to-code .
      output(
        cli.json
          ? { status: "FAILED", code: error.code, diagnostic: message }
          : `Partial scan: ${message}`,
        cli.json,
      );
      return 6;
    }
    if (error instanceof ConfigError || error instanceof DiscoveryError) {
      // To reproduce: Provide an invalid provider option to the CLI:
      // npx human-to-code . --provider not-a-real-provider
      output(
        cli.json
          ? { status: "ERROR", diagnostic: message }
          : `Error: ${message}`,
        cli.json,
      );
      return 1;
    }
    console.error(error instanceof Error ? (error.stack ?? message) : message);
    return 6;
  }
}

// This function checks if this file was executed directly by Node (e.g. `npx human-to-code .` or `node dist/cli.js`)
// rather than being imported as a library by another script (e.g. `import { runHumanToCodeCli } from "human-to-code/cli"`).
function isMainModule(): boolean {
  // Step 1: Find out what file the user told Node to execute in the terminal.
  // (Example: if you run `node dist/cli.js`, this variable holds the path to `dist/cli.js`)
  const entry = process.argv[1]; 
  
  // Step 2: If there is no file, it means another script imported us, so we are not the main program.
  // (Example: this runs when your custom agent does `import { runHumanToCodeCli } from "./cli"`)
  if (!entry) return false; 
  
  try {
    // Step 3: Check if the file the user ran is THIS exact file.
    // 'realpathSync' is used to trace through any file shortcuts to find the true file paths before comparing them.
    // (Example: this returns true when you run `npx human-to-code .` because npx acts as a shortcut to this file)
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); 
  } catch {
    // Step 4: If tracing shortcuts fails, fallback to doing a basic text comparison of the two file paths.
    return resolve(entry) === resolve(fileURLToPath(import.meta.url)); 
  }
}

if (isMainModule()) {
  runHumanToCodeCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = 6;
    });
}
