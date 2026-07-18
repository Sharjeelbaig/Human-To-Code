/**
 * Strict, versioned configuration.
 *
 * Configuration is JSON and is never interpreted by a model. Unknown fields
 * are rejected so misspellings and future/legacy semantics cannot silently
 * weaken a run. Credentials are deliberately not part of the schema: provider
 * adapters must read them from their provider-specific environment variables.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import type {
  Config,
  ProviderConfig,
  ProviderName,
  TargetLanguage,
} from "../core/types.ts";

export const CONFIG_FILENAME = "human-to-code.config.json";
export const CONFIG_SCHEMA_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 1024 * 1024;

const LANGUAGES: readonly TargetLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "html",
  "css",
];

const PROVIDERS: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "ollama",
  "grok",
  "gemini",
];

/** Stable defaults for this package release. They are not model aliases. */
const DEFAULT_MODEL: Readonly<Record<ProviderName, string>> = Object.freeze({
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  ollama: "qwen2.5-coder:7b",
  grok: "grok-4.1",
  gemini: "gemini-2.5-pro",
});

export type DocumentationMode = "local-first" | "offline";
export type SandboxEngine = "auto" | "docker" | "podman";

export interface ProviderConfigV1 extends ProviderConfig {
  /** Required acknowledgement whenever a non-default endpoint is configured. */
  trustCustomEndpoint?: true;
  /** Name of an environment variable; never the credential value itself. */
  apiKeyEnv?: string;
  /**
   * Conservative model-specific API rates used to reserve a worst-case cost
   * before every remote request. Remote adapters refuse to run without them.
   */
  pricing?: ProviderPricingV1;
}

export interface ProviderPricingV1 {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  /** Required when both rates are intentionally zero. */
  unmetered?: true;
}

export interface DocumentationConfigV1 {
  mode: DocumentationMode;
  /** Repository-relative paths containing project/private documentation. */
  privatePaths: string[];
  /** Extra official domains approved by the operator, without schemes/paths. */
  officialDomains: string[];
  /** Exact dependency/version URL mappings used only after local evidence. */
  officialSources: OfficialDocumentationSourceV1[];
}

export interface OfficialDocumentationSourceV1 {
  ecosystem: "react" | "nestjs" | "fastapi" | "rust";
  dependency: string;
  version: string;
  url: string;
}

export interface PrivacyConfigV1 {
  /** Remote providers remain disabled until project-level consent is explicit. */
  remoteProviderConsent: boolean;
  /** Telemetry is opt-in and is also disabled by DO_NOT_TRACK. */
  telemetry: boolean;
  /** Repository-relative paths that must not enter a context manifest. */
  excludedPaths: string[];
  maxFileBytes: number;
  maxContextTokens: number;
}

export interface SandboxConfigV1 {
  required: boolean;
  engine: SandboxEngine;
  /** v1 never permits validation commands to access the network. */
  network: "none";
}

export interface BudgetConfigV1 {
  maxCostUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
  maxRepairs: number;
  timeoutMs: number;
}

export interface WorkspaceOverrideV1 {
  root: string;
  provider?: ProviderConfigV1;
  documentation?: Partial<DocumentationConfigV1>;
  privacy?: Partial<PrivacyConfigV1>;
  budgets?: Partial<BudgetConfigV1>;
}

/**
 * ConfigV1 extends the alpha fields to avoid breaking programmatic callers
 * while adding the production safety policy. Project analysis, rather than
 * `language`, is authoritative for mixed-language workspaces.
 */
export interface ConfigV1 extends Omit<Config, "provider"> {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  provider: ProviderConfigV1;
  workspaces: WorkspaceOverrideV1[];
  documentation: DocumentationConfigV1;
  privacy: PrivacyConfigV1;
  sandbox: SandboxConfigV1;
  budgets: BudgetConfigV1;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value) as DeepReadonly<T>;
}

const DEFAULT_CONFIG_VALUE: ConfigV1 = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  language: "typescript",
  languages: ["typescript"],
  filesToIgnore: ["node_modules", ".git", "dist"],
  allowNonHumanFiles: false,
  provider: {
    // A fresh `npx human-to-code .` installation starts with a loopback-only
    // provider. Remote code transmission is never an implicit default.
    name: "ollama",
    model: DEFAULT_MODEL.ollama,
  },
  workspaces: [],
  documentation: {
    mode: "local-first",
    privatePaths: [],
    officialDomains: [],
    officialSources: [],
  },
  privacy: {
    remoteProviderConsent: false,
    telemetry: false,
    excludedPaths: [],
    maxFileBytes: 512_000,
    maxContextTokens: 64_000,
  },
  sandbox: {
    required: true,
    engine: "auto",
    network: "none",
  },
  budgets: {
    maxCostUsd: 10,
    // Cumulative run ceilings. Preflight accounting uses a pessimistic
    // tokenizer-independent upper bound and charges failed remote attempts.
    maxInputTokens: 2_000_000,
    maxOutputTokens: 120_000,
    maxRequests: 12,
    maxRepairs: 2,
    timeoutMs: 900_000,
  },
};

/** Frozen defaults. Callers receive a deep clone, never this object. */
export const DEFAULT_CONFIG: DeepReadonly<ConfigV1> = deepFreeze(
  DEFAULT_CONFIG_VALUE,
);

/** Thrown for malformed or unsafe config; messages are safe to show users. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** The configured default model id for a provider in this package release. */
export function defaultModelFor(name: ProviderName): string {
  return DEFAULT_MODEL[name];
}

function cloneDefaults(): ConfigV1 {
  return structuredClone(DEFAULT_CONFIG) as ConfigV1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ConfigError(`Unknown configuration field \`${field(path, key)}\`.`);
    }
  }
}

const CREDENTIAL_KEY_SUFFIXES = [
  "apikey",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "password",
  "passphrase",
  "credential",
  "credentials",
  "privatekey",
  "authorization",
] as const;

function rejectCredentialKeys(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectCredentialKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      normalized !== "apikeyenv" &&
      (normalized === "key" ||
        normalized === "secret" ||
        normalized === "token" ||
        normalized.endsWith("secret") ||
        CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)))
    ) {
      throw new ConfigError(
        `Credential-like field \`${field(path, key)}\` is prohibited; use the provider-specific environment variable.`,
      );
    }
    rejectCredentialKeys(nested, field(path, key));
  }
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigError(`\`${path}\` must be an object.`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`\`${path}\` must be a boolean.`);
  }
  return value;
}

function expectString(value: unknown, path: string, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new ConfigError(
      `\`${path}\` must be a non-empty, trimmed string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function expectNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new ConfigError(
      `\`${path}\` must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function expectStringArray(
  value: unknown,
  path: string,
  validator: (item: string, itemPath: string) => string = expectString,
): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`\`${path}\` must be an array of strings.`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string") {
      throw new ConfigError(`\`${path}[${index}]\` must be a string.`);
    }
    return validator(item, `${path}[${index}]`);
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigError(`\`${path}\` must not contain duplicates.`);
  }
  return result;
}

function validateRelativePath(
  value: string,
  path: string,
  allowRoot = false,
): string {
  expectString(value, path, 1024);
  if (
    isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.startsWith("\\") ||
    value.includes("\\")
  ) {
    throw new ConfigError(`\`${path}\` must be a portable repository-relative path.`);
  }
  if (allowRoot && value === ".") return value;
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ConfigError(`\`${path}\` must not contain empty, dot, or parent segments.`);
  }
  return value;
}

function validateIgnoreName(value: string, path: string): string {
  expectString(value, path, 255);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new ConfigError(`\`${path}\` must be a file or directory name, not a path.`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

function isUnsafeLiteralAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  if (family === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("ff")
    );
  }
  return false;
}

/** Validate a custom endpoint without performing any network access. */
export function validateProviderBaseUrl(
  raw: string,
  provider: ProviderName,
  trusted: boolean,
): string {
  const value = expectString(raw, "provider.baseUrl", 2048);
  if (!trusted) {
    throw new ConfigError(
      "`provider.trustCustomEndpoint` must be true when `provider.baseUrl` is set.",
    );
  }

  let url: URL;
  if (!value.startsWith("https://") && !value.startsWith("http://")) {
    throw new ConfigError("`provider.baseUrl` must use an explicit lowercase URL scheme.");
  }
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("`provider.baseUrl` must be an absolute URL.");
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("`provider.baseUrl` must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("`provider.baseUrl` must not contain a query or fragment.");
  }

  const loopback = isLoopback(url.hostname);
  if (url.protocol === "http:") {
    if (provider !== "ollama" || !loopback) {
      throw new ConfigError(
        "Plain HTTP is permitted only for an explicitly trusted Ollama loopback endpoint.",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new ConfigError("`provider.baseUrl` must use https:// (or Ollama HTTP loopback).");
  }

  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  if (
    (!loopback && isUnsafeLiteralAddress(hostname)) ||
    (!loopback &&
      (hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal")))
  ) {
    throw new ConfigError("`provider.baseUrl` must not target a private network.");
  }
  if (loopback && provider !== "ollama") {
    throw new ConfigError("Only the local Ollama provider may use a loopback endpoint.");
  }
  if (isIP(hostname) === 0 && !loopback && !hostname.includes(".")) {
    throw new ConfigError("`provider.baseUrl` hostname must be a fully qualified domain.");
  }
  return value;
}

function validateProvider(raw: unknown, path = "provider"): ProviderConfigV1 {
  const value = expectObject(raw, path);
  assertKnownKeys(
    value,
    ["name", "model", "baseUrl", "trustCustomEndpoint", "apiKeyEnv", "pricing"],
    path,
  );

  const name = value.name;
  if (typeof name !== "string" || !PROVIDERS.includes(name as ProviderName)) {
    throw new ConfigError(`\`${path}.name\` must be one of: ${PROVIDERS.join(", ")}.`);
  }
  const providerName = name as ProviderName;
  const model =
    value.model === undefined
      ? DEFAULT_MODEL[providerName]
      : expectString(value.model, `${path}.model`, 256);

  const result: ProviderConfigV1 = { name: providerName, model };
  if (value.pricing !== undefined) {
    const pricing = expectObject(value.pricing, `${path}.pricing`);
    assertKnownKeys(
      pricing,
      ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "unmetered"],
      `${path}.pricing`,
    );
    const inputUsdPerMillionTokens = expectNumber(
        pricing.inputUsdPerMillionTokens,
        `${path}.pricing.inputUsdPerMillionTokens`,
        0,
        1_000_000,
      );
    const outputUsdPerMillionTokens = expectNumber(
        pricing.outputUsdPerMillionTokens,
        `${path}.pricing.outputUsdPerMillionTokens`,
        0,
        1_000_000,
      );
    if (pricing.unmetered !== undefined && pricing.unmetered !== true) {
      throw new ConfigError(`\`${path}.pricing.unmetered\` may only be true.`);
    }
    const bothZero = inputUsdPerMillionTokens === 0 && outputUsdPerMillionTokens === 0;
    if (bothZero !== (pricing.unmetered === true)) {
      throw new ConfigError(
        `\`${path}.pricing.unmetered\` must be true exactly when both configured rates are zero.`,
      );
    }
    result.pricing = {
      inputUsdPerMillionTokens,
      outputUsdPerMillionTokens,
      ...(pricing.unmetered === true ? { unmetered: true } : {}),
    };
  }
  if (value.apiKeyEnv !== undefined) {
    if (
      typeof value.apiKeyEnv !== "string" ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value.apiKeyEnv)
    ) {
      throw new ConfigError(
        `\`${path}.apiKeyEnv\` must be an uppercase environment-variable name.`,
      );
    }
    result.apiKeyEnv = value.apiKeyEnv;
  }
  if (value.trustCustomEndpoint !== undefined && value.trustCustomEndpoint !== true) {
    throw new ConfigError(`\`${path}.trustCustomEndpoint\` may only be true.`);
  }
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== "string") {
      throw new ConfigError(`\`${path}.baseUrl\` must be a string.`);
    }
    result.baseUrl = validateProviderBaseUrl(
      value.baseUrl,
      providerName,
      value.trustCustomEndpoint === true,
    );
    result.trustCustomEndpoint = true;
    const endpoint = new URL(result.baseUrl);
    const officialOllama =
      providerName === "ollama" &&
      endpoint.protocol === "https:" &&
      endpoint.hostname === "ollama.com";
    if (endpoint.protocol === "http:" && result.apiKeyEnv !== undefined) {
      throw new ConfigError(
        `\`${path}.apiKeyEnv\` is not allowed for a local HTTP Ollama endpoint.`,
      );
    }
    if (officialOllama && result.apiKeyEnv === undefined) {
      result.apiKeyEnv = "OLLAMA_API_KEY";
    }
  } else if (value.trustCustomEndpoint !== undefined) {
    throw new ConfigError(
      `\`${path}.trustCustomEndpoint\` is only valid with \`${path}.baseUrl\`.`,
    );
  }
  return result;
}

function validateDocumentation(
  raw: unknown,
  path: string,
  partial: false,
): DocumentationConfigV1;
function validateDocumentation(
  raw: unknown,
  path: string,
  partial: true,
): Partial<DocumentationConfigV1>;
function validateDocumentation(
  raw: unknown,
  path: string,
  partial: boolean,
): DocumentationConfigV1 | Partial<DocumentationConfigV1> {
  const value = expectObject(raw, path);
  assertKnownKeys(value, ["mode", "privatePaths", "officialDomains", "officialSources"], path);
  const result: Partial<DocumentationConfigV1> = {};

  if (!partial || value.mode !== undefined) {
    const mode = value.mode;
    if (mode !== "local-first" && mode !== "offline") {
      throw new ConfigError(`\`${path}.mode\` must be local-first or offline.`);
    }
    result.mode = mode;
  }
  if (!partial || value.privatePaths !== undefined) {
    result.privatePaths = expectStringArray(
      value.privatePaths,
      `${path}.privatePaths`,
      validateRelativePath,
    );
  }
  if (!partial || value.officialDomains !== undefined) {
    result.officialDomains = expectStringArray(
      value.officialDomains,
      `${path}.officialDomains`,
      (domain, itemPath) => {
        expectString(domain, itemPath, 253);
        if (
          domain !== domain.toLowerCase() ||
          domain.includes(":") ||
          domain.includes("/") ||
          domain.startsWith(".") ||
          domain.endsWith(".") ||
          domain.includes("*") ||
          !domain.includes(".") ||
          isIP(domain) !== 0
        ) {
          throw new ConfigError(`\`${itemPath}\` must be a lowercase public domain.`);
        }
        return domain;
      },
    );
  }
  if (!partial || value.officialSources !== undefined) {
    if (!Array.isArray(value.officialSources)) {
      throw new ConfigError(`\`${path}.officialSources\` must be an array.`);
    }
    if (value.officialSources.length > 100) {
      throw new ConfigError(`\`${path}.officialSources\` may contain at most 100 entries.`);
    }
    const sources = value.officialSources.map((raw, index): OfficialDocumentationSourceV1 => {
      const itemPath = `${path}.officialSources[${index}]`;
      const source = expectObject(raw, itemPath);
      assertKnownKeys(source, ["ecosystem", "dependency", "version", "url"], itemPath);
      if (!["react", "nestjs", "fastapi", "rust"].includes(String(source.ecosystem))) {
        throw new ConfigError(`\`${itemPath}.ecosystem\` is not a supported ecosystem.`);
      }
      const dependency = expectString(source.dependency, `${itemPath}.dependency`, 256);
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(dependency)) {
        throw new ConfigError(`\`${itemPath}.dependency\` must be one exact dependency name.`);
      }
      const version = expectString(source.version, `${itemPath}.version`, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/u.test(version)
        || /^(?:latest|next|stable|nightly|main|master|head|dev)$/iu.test(version)
        || /[<>=^~*]/u.test(version)) {
        throw new ConfigError(`\`${itemPath}.version\` must be one exact version identifier.`);
      }
      const url = expectString(source.url, `${itemPath}.url`, 2048);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigError(`\`${itemPath}.url\` must be an absolute HTTPS URL.`);
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) {
        throw new ConfigError(`\`${itemPath}.url\` must be credential-free HTTPS on the default port without a fragment.`);
      }
      let versionedLocation: string;
      try {
        versionedLocation = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
      } catch {
        throw new ConfigError(`\`${itemPath}.url\` contains invalid percent encoding.`);
      }
      if (!versionedLocation.includes(version)) {
        throw new ConfigError(`\`${itemPath}.url\` must visibly bind the exact configured version in its path or query.`);
      }
      return {
        ecosystem: source.ecosystem as OfficialDocumentationSourceV1["ecosystem"],
        dependency,
        version,
        url,
      };
    });
    const identities = sources.map((source) => `${source.ecosystem}\0${source.dependency.toLowerCase()}\0${source.version}`);
    if (new Set(identities).size !== identities.length) {
      throw new ConfigError(`\`${path}.officialSources\` must not contain duplicate ecosystem/dependency/version mappings.`);
    }
    result.officialSources = sources;
  }
  return result;
}

function validatePrivacy(raw: unknown, path: string, partial: false): PrivacyConfigV1;
function validatePrivacy(
  raw: unknown,
  path: string,
  partial: true,
): Partial<PrivacyConfigV1>;
function validatePrivacy(
  raw: unknown,
  path: string,
  partial: boolean,
): PrivacyConfigV1 | Partial<PrivacyConfigV1> {
  const value = expectObject(raw, path);
  assertKnownKeys(
    value,
    [
      "remoteProviderConsent",
      "telemetry",
      "excludedPaths",
      "maxFileBytes",
      "maxContextTokens",
    ],
    path,
  );
  const result: Partial<PrivacyConfigV1> = {};
  if (!partial || value.remoteProviderConsent !== undefined) {
    result.remoteProviderConsent = expectBoolean(
      value.remoteProviderConsent,
      `${path}.remoteProviderConsent`,
    );
  }
  if (!partial || value.telemetry !== undefined) {
    result.telemetry = expectBoolean(value.telemetry, `${path}.telemetry`);
  }
  if (!partial || value.excludedPaths !== undefined) {
    result.excludedPaths = expectStringArray(
      value.excludedPaths,
      `${path}.excludedPaths`,
      validateRelativePath,
    );
  }
  if (!partial || value.maxFileBytes !== undefined) {
    result.maxFileBytes = expectNumber(
      value.maxFileBytes,
      `${path}.maxFileBytes`,
      1_024,
      100_000_000,
      true,
    );
  }
  if (!partial || value.maxContextTokens !== undefined) {
    result.maxContextTokens = expectNumber(
      value.maxContextTokens,
      `${path}.maxContextTokens`,
      1_000,
      2_000_000,
      true,
    );
  }
  return result;
}

function validateBudgets(raw: unknown, path: string, partial: false): BudgetConfigV1;
function validateBudgets(
  raw: unknown,
  path: string,
  partial: true,
): Partial<BudgetConfigV1>;
function validateBudgets(
  raw: unknown,
  path: string,
  partial: boolean,
): BudgetConfigV1 | Partial<BudgetConfigV1> {
  const value = expectObject(raw, path);
  assertKnownKeys(
    value,
    [
      "maxCostUsd",
      "maxInputTokens",
      "maxOutputTokens",
      "maxRequests",
      "maxRepairs",
      "timeoutMs",
    ],
    path,
  );
  const result: Partial<BudgetConfigV1> = {};
  const set = (
    key: keyof BudgetConfigV1,
    min: number,
    max: number,
    integer: boolean,
  ): void => {
    if (!partial || value[key] !== undefined) {
      result[key] = expectNumber(value[key], `${path}.${key}`, min, max, integer);
    }
  };
  set("maxCostUsd", 0, 100_000, false);
  set("maxInputTokens", 1_000, 10_000_000, true);
  set("maxOutputTokens", 1, 1_000_000, true);
  set("maxRequests", 1, 100, true);
  set("maxRepairs", 0, 2, true);
  set("timeoutMs", 1_000, 86_400_000, true);
  return result;
}

function validateSandbox(raw: unknown, path: string): Partial<SandboxConfigV1> {
  const value = expectObject(raw, path);
  assertKnownKeys(value, ["required", "engine", "network"], path);
  const result: Partial<SandboxConfigV1> = {};
  if (value.required !== undefined) {
    const required = expectBoolean(value.required, `${path}.required`);
    if (!required) {
      throw new ConfigError(`\`${path}.required\` must be true in schema v1; generated runs always require a strong sandbox.`);
    }
    result.required = true;
  }
  if (value.engine !== undefined) {
    if (value.engine !== "auto" && value.engine !== "docker" && value.engine !== "podman") {
      throw new ConfigError(`\`${path}.engine\` must be auto, docker, or podman.`);
    }
    result.engine = value.engine;
  }
  if (value.network !== undefined) {
    if (value.network !== "none") {
      throw new ConfigError(`\`${path}.network\` must be none in schema v1.`);
    }
    result.network = "none";
  }
  return result;
}

function validateWorkspace(raw: unknown, index: number): WorkspaceOverrideV1 {
  const path = `workspaces[${index}]`;
  const value = expectObject(raw, path);
  assertKnownKeys(value, ["root", "provider", "documentation", "privacy", "budgets"], path);
  if (typeof value.root !== "string") {
    throw new ConfigError(`\`${path}.root\` must be a string.`);
  }
  const result: WorkspaceOverrideV1 = {
    root: validateRelativePath(value.root, `${path}.root`, true),
  };
  if (value.provider !== undefined) result.provider = validateProvider(value.provider, `${path}.provider`);
  if (value.documentation !== undefined) {
    result.documentation = validateDocumentation(value.documentation, `${path}.documentation`, true);
  }
  if (value.privacy !== undefined) {
    result.privacy = validatePrivacy(value.privacy, `${path}.privacy`, true);
  }
  if (value.budgets !== undefined) {
    result.budgets = validateBudgets(value.budgets, `${path}.budgets`, true);
  }
  return result;
}

/** Validate an already-parsed schema-v1 object into a fully defaulted config. */
export function validateConfig(raw: unknown): ConfigV1 {
  if (!isObject(raw)) throw new ConfigError("Config root must be a JSON object.");
  rejectCredentialKeys(raw);
  assertKnownKeys(
    raw,
    [
      "schemaVersion",
      "language",
      "languages",
      "filesToIgnore",
      "allowNonHumanFiles",
      "provider",
      "workspaces",
      "documentation",
      "privacy",
      "sandbox",
      "budgets",
    ],
    "",
  );

  if (raw.schemaVersion === undefined) {
    throw new ConfigError(
      `Missing \`schemaVersion\`; run \`human-to-code migrate-config\` for alpha configuration.`,
    );
  }
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `Unsupported \`schemaVersion\` ${JSON.stringify(raw.schemaVersion)}; expected ${CONFIG_SCHEMA_VERSION}.`,
    );
  }

  const config = cloneDefaults();
  if (raw.language !== undefined) {
    if (
      typeof raw.language !== "string" ||
      !LANGUAGES.includes(raw.language as TargetLanguage)
    ) {
      throw new ConfigError(`\`language\` must be one of: ${LANGUAGES.join(", ")}.`);
    }
    config.language = raw.language as TargetLanguage;
  }
  if (raw.languages !== undefined) {
    if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
      throw new ConfigError("`languages` must be a non-empty array.");
    }
    const languages = raw.languages.map((entry, index) => {
      if (typeof entry !== "string" || !LANGUAGES.includes(entry as TargetLanguage)) {
        throw new ConfigError(
          `\`languages[${index}]\` must be one of: ${LANGUAGES.join(", ")}.`,
        );
      }
      return entry as TargetLanguage;
    });
    if (new Set(languages).size !== languages.length) {
      throw new ConfigError("`languages` must not contain duplicates.");
    }
    config.languages = languages;
    if (raw.language === undefined) {
      config.language = languages[0]!;
    } else if (!languages.includes(config.language)) {
      throw new ConfigError(
        "`language` must be listed in `languages` when both are set.",
      );
    }
  } else if (raw.language !== undefined) {
    config.languages = [config.language];
  }
  if (raw.filesToIgnore !== undefined) {
    config.filesToIgnore = expectStringArray(
      raw.filesToIgnore,
      "filesToIgnore",
      validateIgnoreName,
    );
  }
  if (raw.allowNonHumanFiles !== undefined) {
    config.allowNonHumanFiles = expectBoolean(raw.allowNonHumanFiles, "allowNonHumanFiles");
  }
  if (raw.provider !== undefined) config.provider = validateProvider(raw.provider);

  if (raw.workspaces !== undefined) {
    if (!Array.isArray(raw.workspaces)) {
      throw new ConfigError("`workspaces` must be an array.");
    }
    config.workspaces = raw.workspaces.map(validateWorkspace);
    const roots = config.workspaces.map(({ root }) => root.toLowerCase());
    if (new Set(roots).size !== roots.length) {
      throw new ConfigError("`workspaces` must not contain duplicate roots.");
    }
  }
  if (raw.documentation !== undefined) {
    config.documentation = {
      ...config.documentation,
      ...validateDocumentation(raw.documentation, "documentation", true),
    };
  }
  if (raw.privacy !== undefined) {
    config.privacy = {
      ...config.privacy,
      ...validatePrivacy(raw.privacy, "privacy", true),
    };
  }
  if (raw.sandbox !== undefined) {
    config.sandbox = {
      ...config.sandbox,
      ...validateSandbox(raw.sandbox, "sandbox"),
    };
  }
  if (raw.budgets !== undefined) {
    config.budgets = {
      ...config.budgets,
      ...validateBudgets(raw.budgets, "budgets", true),
    };
  }

  return config;
}

/**
 * Explicitly migrate the dependency-free 0.0.1 shape. It intentionally accepts
 * only the four known legacy keys and then validates the resulting v1 object.
 */
export function migrateLegacyConfig(raw: unknown): ConfigV1 {
  if (!isObject(raw)) throw new ConfigError("Legacy config root must be a JSON object.");
  if (raw.schemaVersion !== undefined) return validateConfig(raw);
  rejectCredentialKeys(raw);
  assertKnownKeys(
    raw,
    ["language", "filesToIgnore", "allowNonHumanFiles", "provider"],
    "",
  );
  return validateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, ...raw });
}

/**
 * Load `<root>/human-to-code.config.json`. A missing file returns cloned
 * defaults; unreadable, non-regular, symlinked, oversized, or legacy files fail.
 */
export async function loadConfig(
  root: string,
): Promise<{ config: ConfigV1; fromFile: boolean }> {
  const path = join(root, CONFIG_FILENAME);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: cloneDefaults(), fromFile: false };
    }
    throw new ConfigError(`Could not inspect ${CONFIG_FILENAME}: ${String(error)}`);
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ConfigError(`${CONFIG_FILENAME} must be a regular, non-symlink file.`);
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new ConfigError(`${CONFIG_FILENAME} exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
  }

  let handle;
  try {
    // O_NOFOLLOW closes the lstat/open replacement race on platforms that
    // support it; the descriptor identity comparison also detects replacement.
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new ConfigError(`Could not securely open ${CONFIG_FILENAME}: ${String(error)}`);
  }

  let text: string;
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new ConfigError(`${CONFIG_FILENAME} changed while it was being opened.`);
    }
    if (openedMetadata.size > MAX_CONFIG_BYTES) {
      throw new ConfigError(`${CONFIG_FILENAME} exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
    }
    text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
      throw new ConfigError(`${CONFIG_FILENAME} exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Could not read ${CONFIG_FILENAME}: ${String(error)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${String(error)}`);
  }
  return { config: validateConfig(parsed), fromFile: true };
}

/** Serialize a fresh schema-v1 default config for initialization. */
export function defaultConfigJson(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}
