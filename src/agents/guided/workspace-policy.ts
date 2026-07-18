import type { ProjectProfileV1, WorkspaceProfileV1 } from "../../analysis/analyzer.ts";
import type { ConfigV1 } from "../../config/config.ts";
import {
  canonicalJson,
  validateValidationPlanV1,
  type ChangeContractV1,
  type ValidationPlanV1,
} from "../../core/contracts.ts";
import { ProviderError } from "../../providers/provider.ts";

function workspaceOverride(config: ConfigV1, workspace: WorkspaceProfileV1): ConfigV1["workspaces"][number] | undefined {
  return config.workspaces.find((candidate) =>
    candidate.root === workspace.relativeRoot || candidate.root === workspace.ownership.root);
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function targetWorkspaces(
  profile: ProjectProfileV1,
  contract: ChangeContractV1,
): WorkspaceProfileV1[] {
  const requested = new Set(contract.targetWorkspaces);
  const selected = profile.workspaces.filter((workspace) => requested.has(workspace.id));
  if (selected.length !== requested.size) {
    throw new Error("Contract targets do not match the analyzed workspace profile.");
  }
  return selected;
}

/** Merge workspace overrides conservatively for one atomic guided run. */
export function resolveWorkspaceConfig(
  config: ConfigV1,
  profile: ProjectProfileV1,
  contract: ChangeContractV1,
): ConfigV1 {
  const selected = targetWorkspaces(profile, contract);
  const overrides = selected.map((workspace) => workspaceOverride(config, workspace));
  const providers = selected.map((_, index) => overrides[index]?.provider ?? config.provider);
  const providerIdentity = canonicalJson(providers[0]);
  if (providers.some((provider) => canonicalJson(provider) !== providerIdentity)) {
    throw new ProviderError(
      "configuration",
      "Target workspaces select conflicting provider/model/endpoint overrides; one atomic run cannot silently choose between them.",
    );
  }

  const resolved = structuredClone(config);
  resolved.provider = structuredClone(providers[0]!);
  const docs = overrides.map((item) => item?.documentation).filter((item) => item !== undefined);
  resolved.documentation = {
    mode: docs.some((item) => item.mode === "offline") ? "offline" : config.documentation.mode,
    privatePaths: unique([config.documentation.privatePaths, ...docs.map((item) => item.privatePaths ?? [])].flat()),
    officialDomains: unique([config.documentation.officialDomains, ...docs.map((item) => item.officialDomains ?? [])].flat()),
    officialSources: [...new Map(
      [config.documentation.officialSources, ...docs.map((item) => item.officialSources ?? [])]
        .flat()
        .map((source) => [canonicalJson(source), structuredClone(source)] as const),
    ).values()],
  };
  const privacy = overrides.map((item) => item?.privacy).filter((item) => item !== undefined);
  resolved.privacy = {
    remoteProviderConsent: privacy.every((item) => item.remoteProviderConsent ?? config.privacy.remoteProviderConsent)
      && config.privacy.remoteProviderConsent,
    telemetry: process.env.DO_NOT_TRACK
      ? false
      : privacy.every((item) => item.telemetry ?? config.privacy.telemetry) && config.privacy.telemetry,
    excludedPaths: unique([config.privacy.excludedPaths, ...privacy.map((item) => item.excludedPaths ?? [])].flat()),
    maxFileBytes: Math.min(config.privacy.maxFileBytes, ...privacy.map((item) => item.maxFileBytes ?? config.privacy.maxFileBytes)),
    maxContextTokens: Math.min(config.privacy.maxContextTokens, ...privacy.map((item) => item.maxContextTokens ?? config.privacy.maxContextTokens)),
  };
  const budgets = overrides.map((item) => item?.budgets).filter((item) => item !== undefined);
  resolved.budgets = {
    maxCostUsd: Math.min(config.budgets.maxCostUsd, ...budgets.map((item) => item.maxCostUsd ?? config.budgets.maxCostUsd)),
    maxInputTokens: Math.min(config.budgets.maxInputTokens, ...budgets.map((item) => item.maxInputTokens ?? config.budgets.maxInputTokens)),
    maxOutputTokens: Math.min(config.budgets.maxOutputTokens, ...budgets.map((item) => item.maxOutputTokens ?? config.budgets.maxOutputTokens)),
    maxRequests: Math.min(config.budgets.maxRequests, ...budgets.map((item) => item.maxRequests ?? config.budgets.maxRequests)),
    maxRepairs: Math.min(config.budgets.maxRepairs, ...budgets.map((item) => item.maxRepairs ?? config.budgets.maxRepairs)),
    timeoutMs: Math.min(config.budgets.timeoutMs, ...budgets.map((item) => item.timeoutMs ?? config.budgets.timeoutMs)),
  };
  return resolved;
}

export function createValidationPlan(
  profile: ProjectProfileV1,
  contract: ChangeContractV1,
): ValidationPlanV1 {
  const commands = targetWorkspaces(profile, contract)
    .flatMap((workspace) => workspace.validationPlan)
    .map((command) => ({
      id: command.id,
      argv: [...command.argv],
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      required: command.required,
      category: command.category,
    }));
  const ids = new Set<string>();
  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Validation command id collides across workspaces: ${command.id}.`);
    ids.add(command.id);
  }
  return validateValidationPlanV1({
    schemaVersion: 1,
    profileFingerprint: profile.fingerprint,
    commands,
    manualChecks: [...contract.acceptanceCriteria.manual],
  });
}
