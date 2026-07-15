/**
 * Structured config loader.
 *
 * Config is deterministic JSON (`human-to-code.config.json`), never parsed by
 * an LLM — see plan §1.7 / §2. A hand-rolled validator keeps the tool
 * dependency-free and gives precise error messages.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Config,
  ProviderConfig,
  ProviderName,
  TargetLanguage,
} from "./types.ts";

export const CONFIG_FILENAME = "human-to-code.config.json";

const LANGUAGES: readonly TargetLanguage[] = [
  "typescript",
  "javascript",
  "python",
];

const PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "ollama",
  "grok",
  "gemini",
];

/**
 * Current, non-dated default model per provider. The Anthropic default is the
 * current flagship — the README's `claude-3-5-sonnet-20241022` is retired.
 */
const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  ollama: "llama3.2",
  grok: "grok-4.1",
  gemini: "gemini-2.5-pro",
};

/** The current default model id for a provider. */
export function defaultModelFor(name: ProviderName): string {
  return DEFAULT_MODEL[name];
}

export const DEFAULT_CONFIG: Config = {
  language: "typescript",
  filesToIgnore: ["node_modules", ".git", "dist"],
  allowNonHumanFiles: false,
  provider: {
    name: "anthropic",
    model: DEFAULT_MODEL.anthropic,
  },
};

/** Thrown for any malformed config; message is safe to show the user. */
export class ConfigError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateProvider(raw: unknown): ProviderConfig {
  if (!isObject(raw)) {
    throw new ConfigError("`provider` must be an object.");
  }
  const name = raw.name;
  if (typeof name !== "string" || !PROVIDERS.includes(name as ProviderName)) {
    throw new ConfigError(
      `\`provider.name\` must be one of: ${PROVIDERS.join(", ")}.`,
    );
  }
  const providerName = name as ProviderName;

  let model = raw.model;
  if (model === undefined) {
    model = DEFAULT_MODEL[providerName];
  } else if (typeof model !== "string" || model.length === 0) {
    throw new ConfigError("`provider.model` must be a non-empty string.");
  }

  const provider: ProviderConfig = { name: providerName, model: model as string };

  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== "string") {
      throw new ConfigError("`provider.baseUrl` must be a string.");
    }
    // Enforce TLS — a bad base URL can serve poisoned strict (plan §3.7).
    if (!raw.baseUrl.startsWith("https://")) {
      throw new ConfigError("`provider.baseUrl` must use https://.");
    }
    provider.baseUrl = raw.baseUrl;
  }

  return provider;
}

/** Validate an already-parsed object into a fully-defaulted Config. */
export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) {
    throw new ConfigError("Config root must be a JSON object.");
  }

  const config: Config = {
    ...DEFAULT_CONFIG,
    provider: { ...DEFAULT_CONFIG.provider },
  };

  if (raw.language !== undefined) {
    if (
      typeof raw.language !== "string" ||
      !LANGUAGES.includes(raw.language as TargetLanguage)
    ) {
      throw new ConfigError(
        `\`language\` must be one of: ${LANGUAGES.join(", ")}.`,
      );
    }
    config.language = raw.language as TargetLanguage;
  }

  if (raw.filesToIgnore !== undefined) {
    if (
      !Array.isArray(raw.filesToIgnore) ||
      !raw.filesToIgnore.every((f) => typeof f === "string")
    ) {
      throw new ConfigError("`filesToIgnore` must be an array of strings.");
    }
    config.filesToIgnore = raw.filesToIgnore as string[];
  }

  if (raw.allowNonHumanFiles !== undefined) {
    if (typeof raw.allowNonHumanFiles !== "boolean") {
      throw new ConfigError("`allowNonHumanFiles` must be a boolean.");
    }
    config.allowNonHumanFiles = raw.allowNonHumanFiles;
  }

  if (raw.provider !== undefined) {
    config.provider = validateProvider(raw.provider);
  }

  return config;
}

/**
 * Load config from `<root>/human-to-code.config.json`. Returns the defaults
 * (with a flag) when no config file exists so first-run works with zero setup.
 */
export async function loadConfig(
  root: string,
): Promise<{ config: Config; fromFile: boolean }> {
  const path = join(root, CONFIG_FILENAME);
  if (!existsSync(path)) {
    return {
      config: { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider } },
      fromFile: false,
    };
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Could not read ${CONFIG_FILENAME}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${String(err)}`);
  }

  return { config: validateConfig(parsed), fromFile: true };
}

/** Serialize the default config for `--init`. */
export function defaultConfigJson(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}
