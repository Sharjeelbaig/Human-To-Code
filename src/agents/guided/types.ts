import type { ProjectProfileV1 } from "../../analysis/analyzer.ts";
import type { ConfigV1 } from "../../config/config.ts";
import type {
  ChangeContractV1,
  RunStatus,
  UsageSummaryV1,
  ValidationReportV1,
} from "../../core/contracts.ts";
import type { RunStore } from "../../pipeline/run-store.ts";
import type { validateBaselineAndCandidate } from "../../pipeline/validation.ts";
import type { ProviderAdapter } from "../../providers/provider.ts";

export interface ProviderCertificationV1 {
  matrixKey: string;
  certified: boolean;
  reason: string;
}

export interface RunCertificationV1 {
  schemaVersion: 1;
  supportMatrixVersion: string;
  provider: ProviderCertificationV1;
  profileCertified: boolean;
  certified: boolean;
  reasons: string[];
}

export interface GenerateRunOptions {
  root: string;
  profile: ProjectProfileV1;
  contract: ChangeContractV1;
  config: ConfigV1;
  provider: ProviderAdapter;
  store?: RunStore;
  offline?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowOutcome {
  runId: string;
  status: RunStatus;
  diagnostics: string[];
  diff?: string;
  report?: ValidationReportV1;
  /** Cumulative provider usage for runs that reached the provider. */
  usage?: UsageSummaryV1;
  /** Fixed CLI exit code when status alone cannot distinguish the failure. */
  exitCode?: number;
}

export interface ValidateStoredRunOptions {
  runId: string;
  store?: RunStore;
  sandboxImage?: string;
  dockerBinary?: string;
  manualChecksPassed?: boolean;
  /** Present only for guided validation; standalone validate never guesses credentials. */
  provider?: ProviderAdapter;
  /** Must exactly match the configuration persisted during generation. */
  config?: ConfigV1;
  signal?: AbortSignal;
  /** Deterministic test seam; production always uses the strong-sandbox runner. */
  validationRunner?: typeof validateBaselineAndCandidate;
}
