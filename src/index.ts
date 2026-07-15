/** Public API surface for programmatic use. */

export type {
  Config,
  ProviderConfig,
  ProviderName,
  TargetLanguage,
  SourceFile,
  SourceKind,
  DiscoveryResult,
} from "./types.ts";

export {
  loadConfig,
  validateConfig,
  defaultConfigJson,
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
  ConfigError,
} from "./config.ts";

export { discover, secretsTrackedError } from "./discovery.ts";
