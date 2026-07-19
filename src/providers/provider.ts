/** Provider-neutral generation, budgets, schema gates, and retry policy. */

import { setTimeout as delay } from "node:timers/promises";
import {
  ArtifactValidationError,
  canonicalJson,
  type JsonValue,
} from "../core/contracts.ts";
import { scanSecrets, type ContextRequestV1 } from "../context/context.ts";

export type ProviderOperation = "contract" | "context" | "patch" | "repair";
export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessageV1 {
  role: ProviderMessageRole;
  content: string;
  name?: string;
}

export type JsonSchemaV1 = Readonly<Record<string, JsonValue>>;

export interface ProviderToolDefinitionV1 {
  name: string;
  description: string;
  inputSchema: JsonSchemaV1;
}

export interface ProviderCapabilitiesV1 {
  /** False means prompts/tools carry the schema; local validation is still mandatory. */
  nativeStructuredOutput: boolean;
  toolCalling: boolean;
  cancellation: boolean;
  tokenCounting: "exact" | "estimated" | "unavailable";
  usageReporting: boolean;
  remote: boolean;
  maxContextTokens?: number;
}

export interface ProviderGenerationRequestV1 {
  operation: ProviderOperation;
  model: string;
  messages: ProviderMessageV1[];
  responseSchema: JsonSchemaV1;
  tools?: ProviderToolDefinitionV1[];
  timeoutMs: number;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderRequestUsageV1 {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export type ProviderFinishReason =
  | "stop"
  | "tool_call"
  | "length"
  | "refusal"
  | "other";

export interface ProviderGenerationResultV1 {
  output: unknown;
  resolvedModelId: string;
  requestId: string;
  usage: ProviderRequestUsageV1;
  finishReason: ProviderFinishReason;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: Readonly<ProviderCapabilitiesV1>;
  /**
   * Conservative upper bound for one request. Remote adapters must implement
   * this so the host can reserve spend before any bytes leave the machine.
   */
  maximumRequestCostUsd?(request: ProviderGenerationRequestV1): number;
  generate(request: ProviderGenerationRequestV1): Promise<ProviderGenerationResultV1>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CONTEXT_REQUEST_TOOL: Readonly<ProviderToolDefinitionV1> = deepFreeze({
  name: "request_context",
  description: "Request bounded additional project evidence. The host validates, authorizes, and counts every request.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "requestId", "kind", "workspace", "query", "reason", "maxItems", "path"],
    properties: {
      schemaVersion: { const: 1 },
      requestId: { type: "string", minLength: 1, maxLength: 128 },
      kind: { type: "string", enum: ["symbol", "file", "dependency-doc", "diagnostic"] },
      workspace: { type: "string", minLength: 1, maxLength: 4096 },
      query: { type: "string", minLength: 1, maxLength: 4096 },
      reason: { type: "string", minLength: 1, maxLength: 4096 },
      maxItems: { type: "integer", minimum: 1, maximum: 20 },
      path: { type: ["string", "null"], minLength: 1, maxLength: 4096 },
    },
  },
});

export const COMPILER_CONTEXT_TOOLS: readonly ProviderToolDefinitionV1[] = deepFreeze([
  CONTEXT_REQUEST_TOOL,
]);

export type ProviderErrorCode =
  | "timeout"
  | "rate_limit"
  | "server"
  | "authentication"
  | "refusal"
  | "schema"
  | "safety"
  | "budget"
  | "cancelled"
  | "configuration"
  | "network"
  | "internal";

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "timeout",
  "rate_limit",
  "server",
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly options: {
    statusCode?: number;
    requestId?: string;
    cause?: unknown;
  };
  readonly retryable: boolean;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      statusCode?: number;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.options = options;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

function numericStatus(error: Record<string, unknown>): number | undefined {
  const value = error.statusCode ?? error.status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Normalize SDK/HTTP errors without treating arbitrary network failures as retry-safe. */
export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof ArtifactValidationError) {
    return new ProviderError("schema", "Provider output failed local schema validation.", { cause: error });
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const code = typeof record.code === "string" ? record.code : "";
    const statusCode = numericStatus(record);
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
    if (name === "AbortError" || code === "ABORT_ERR") {
      return new ProviderError("cancelled", "Provider request was cancelled.", { requestId, cause: error });
    }
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || /timeout/iu.test(name)) {
      return new ProviderError("timeout", "Provider request timed out.", { statusCode, requestId, cause: error });
    }
    if (statusCode === 401 || statusCode === 403) {
      return new ProviderError("authentication", "Provider authentication or authorization failed.", { statusCode, requestId, cause: error });
    }
    if (statusCode === 429) {
      return new ProviderError("rate_limit", "Provider rate limit was reached.", { statusCode, requestId, cause: error });
    }
    if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
      return new ProviderError("server", "Provider server failed the request.", { statusCode, requestId, cause: error });
    }
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
      return new ProviderError("network", "Provider network connection failed.", { statusCode, requestId, cause: error });
    }
  }
  return new ProviderError("internal", "Provider request failed unexpectedly.", { cause: error });
}

export interface ProviderBudgetLimitsV1 {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
  maxRepairs: number;
  maxCostUsd: number;
  maxElapsedMs: number;
}

export interface ProviderBudgetUsageV1 {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  repairs: number;
  costUsd: number;
  elapsedMs: number;
}

export interface ProviderRequestReservationV1 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly maximumCostUsd: number;
}

export const DEFAULT_PROVIDER_BUDGETS: Readonly<ProviderBudgetLimitsV1> = Object.freeze({
  maxInputTokens: 250_000,
  maxOutputTokens: 32_000,
  // Matches `budgets.maxRequests` in DEFAULT_CONFIG: multi-pass planning needs
  // headroom well above one request per unit.
  maxRequests: 60,
  maxRepairs: 2,
  maxCostUsd: 25,
  maxElapsedMs: 15 * 60_000,
});

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
}

export class ProviderBudgetTracker {
  readonly limits: Readonly<ProviderBudgetLimitsV1>;
  readonly #startedAt: number;
  readonly #clock: () => number;
  #inputTokens = 0;
  #outputTokens = 0;
  #requests = 0;
  #repairs = 0;
  #costUsd = 0;
  readonly #activeRequestReservations = new Set<ProviderRequestReservationV1>();

  constructor(limits: ProviderBudgetLimitsV1 = DEFAULT_PROVIDER_BUDGETS, clock: () => number = Date.now) {
    for (const key of ["maxInputTokens", "maxOutputTokens", "maxRequests", "maxRepairs", "maxElapsedMs"] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new RangeError(`${key} must be a non-negative safe integer.`);
    }
    if (limits.maxRequests < 1) throw new RangeError("maxRequests must be at least 1.");
    if (limits.maxRepairs > 2) throw new RangeError("maxRepairs cannot exceed the hard limit of 2.");
    if (limits.maxElapsedMs < 1) throw new RangeError("maxElapsedMs must be at least 1.");
    assertFiniteNonNegative(limits.maxCostUsd, "maxCostUsd");
    this.limits = Object.freeze({ ...limits });
    this.#clock = clock;
    this.#startedAt = clock();
  }

  #elapsed(): number {
    return Math.max(0, this.#clock() - this.#startedAt);
  }

  assertCanRequest(estimatedInputTokens: number, maximumOutputTokens: number): void {
    if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0
      || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 1) {
      throw new ProviderError("budget", "Token estimates must be non-negative integers and output allowance must be positive.");
    }
    if (this.#elapsed() >= this.limits.maxElapsedMs) throw new ProviderError("budget", "Provider elapsed-time budget is exhausted.");
    if (this.#requests + 1 > this.limits.maxRequests) throw new ProviderError("budget", "Provider request budget is exhausted.");
    if (this.#inputTokens + estimatedInputTokens > this.limits.maxInputTokens) throw new ProviderError("budget", "Provider input-token budget would be exceeded.");
    if (this.#outputTokens + maximumOutputTokens > this.limits.maxOutputTokens) throw new ProviderError("budget", "Provider output-token budget would be exceeded.");
  }

  beginRequest(
    conservativeInputTokens: number,
    maximumOutputTokens: number,
    maximumCostUsd: number,
  ): ProviderRequestReservationV1 {
    this.assertCanRequest(conservativeInputTokens, maximumOutputTokens);
    assertFiniteNonNegative(maximumCostUsd, "maximum request cost");
    if (this.#costUsd + maximumCostUsd > this.limits.maxCostUsd) {
      throw new ProviderError(
        "budget",
        "Provider request would exceed the cumulative USD budget.",
      );
    }
    const reservation = Object.freeze({
      inputTokens: conservativeInputTokens,
      outputTokens: maximumOutputTokens,
      maximumCostUsd,
    });
    this.#activeRequestReservations.add(reservation);
    // Persistable usage is pessimistically charged before transmission. A
    // crash can therefore reduce future capacity, but can never reset it.
    this.#requests += 1;
    this.#inputTokens += conservativeInputTokens;
    this.#outputTokens += maximumOutputTokens;
    this.#costUsd += maximumCostUsd;
    return reservation;
  }

  #consumeReservation(
    reservation: ProviderRequestReservationV1 | undefined,
  ): ProviderRequestReservationV1 | undefined {
    if (reservation === undefined) return undefined;
    if (!this.#activeRequestReservations.delete(reservation)) {
      throw new ProviderError("internal", "Provider request reservation is stale or was already consumed.");
    }
    return reservation;
  }

  cancelRequest(reservation: ProviderRequestReservationV1): void {
    const active = this.#consumeReservation(reservation);
    if (!active) return;
    this.#requests -= 1;
    this.#inputTokens -= active.inputTokens;
    this.#outputTokens -= active.outputTokens;
    this.#costUsd -= active.maximumCostUsd;
  }

  recordUsage(
    usage: ProviderRequestUsageV1,
    reservation?: ProviderRequestReservationV1,
  ): void {
    const active = this.#consumeReservation(reservation);
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
      || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
      throw new ProviderError("schema", "Provider returned invalid token usage.");
    }
    const cost = usage.costUsd ?? (active === undefined || active.maximumCostUsd === 0 ? 0 : Number.NaN);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new ProviderError("schema", "Remote provider returned no enforceable cost usage.");
    }
    if (active === undefined) {
      this.#requests += 1;
      this.#inputTokens += usage.inputTokens;
      this.#outputTokens += usage.outputTokens;
      this.#costUsd += cost;
    } else {
      this.#inputTokens += usage.inputTokens - active.inputTokens;
      this.#outputTokens += usage.outputTokens - active.outputTokens;
      this.#costUsd += cost - active.maximumCostUsd;
    }
    if (active !== undefined && (usage.inputTokens > active.inputTokens
      || usage.outputTokens > active.outputTokens
      || cost > active.maximumCostUsd + Number.EPSILON)) {
      throw new ProviderError(
        "budget",
        "Provider usage exceeded its pre-request conservative reservation.",
      );
    }
    if (this.#requests > this.limits.maxRequests
      || this.#inputTokens > this.limits.maxInputTokens
      || this.#outputTokens > this.limits.maxOutputTokens
      || this.#costUsd > this.limits.maxCostUsd
      || this.#elapsed() > this.limits.maxElapsedMs) {
      throw new ProviderError("budget", "Provider response exceeded a cumulative run budget.");
    }
  }

  /** Count a failed attempt even when the provider returned no usage data. */
  recordFailedRequest(reservation?: ProviderRequestReservationV1): void {
    const active = this.#consumeReservation(reservation);
    if (active === undefined) this.#requests += 1;
    if (this.#requests > this.limits.maxRequests
      || this.#costUsd > this.limits.maxCostUsd
      || this.#elapsed() > this.limits.maxElapsedMs) {
      throw new ProviderError("budget", "Provider request or elapsed-time budget is exhausted.");
    }
  }

  recordRepair(): void {
    if (this.#repairs + 1 > this.limits.maxRepairs || this.#repairs + 1 > 2) {
      throw new ProviderError("budget", "Repair attempt budget is exhausted.");
    }
    this.#repairs += 1;
  }

  get usage(): ProviderBudgetUsageV1 {
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      requests: this.#requests,
      repairs: this.#repairs,
      costUsd: this.#costUsd,
      elapsedMs: this.#elapsed(),
    };
  }

  get remainingOutputTokens(): number {
    return Math.max(0, this.limits.maxOutputTokens - this.#outputTokens);
  }

  get remainingRequests(): number {
    return Math.max(0, this.limits.maxRequests - this.#requests);
  }

  get remainingElapsedMs(): number {
    return Math.max(0, this.limits.maxElapsedMs - this.#elapsed());
  }
}

export function estimateProviderInputTokens(request: ProviderGenerationRequestV1): number {
  const messageBytes = request.messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
    0,
  );
  const schemaBytes = Buffer.byteLength(canonicalJson(request.responseSchema), "utf8");
  const toolBytes = Buffer.byteLength(canonicalJson(request.tools ?? []), "utf8");
  const bytes = messageBytes + schemaBytes + toolBytes + 256;
  return Math.ceil(bytes / 4);
}

/**
 * A tokenizer-independent upper bound for byte-level model tokenizers. It is
 * intentionally pessimistic and includes host/API framing headroom.
 */
export function conservativeProviderInputTokenUpperBound(
  request: ProviderGenerationRequestV1,
): number {
  const envelope = canonicalJson({
    operation: request.operation,
    model: request.model,
    messages: request.messages,
    responseSchema: request.responseSchema,
    tools: request.tools ?? [],
  });
  return Buffer.byteLength(envelope, "utf8") + 4096;
}

function validateProviderRequest(request: ProviderGenerationRequestV1): void {
  if (!request.model.trim()) throw new ProviderError("configuration", "An explicit provider model is required.");
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new ProviderError("configuration", "Provider request requires at least one message.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60 * 60_000) throw new ProviderError("configuration", "Provider timeout is invalid.");
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new ProviderError("configuration", "Provider output limit is invalid.");
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new ProviderError("configuration", "Provider temperature must be from 0 to 2.");
  let totalMessageBytes = 0;
  request.messages.forEach((message) => {
    if (!(["system", "user", "assistant", "tool"] as const).includes(message.role)
      || typeof message.content !== "string" || message.content.includes("\0")
      || (message.name !== undefined && (typeof message.name !== "string" || message.name.length === 0 || message.name.length > 128))) {
      throw new ProviderError("configuration", "Provider message is invalid.");
    }
    const bytes = Buffer.byteLength(message.content, "utf8");
    totalMessageBytes += bytes;
    if (bytes > 4 * 1024 * 1024 || totalMessageBytes > 8 * 1024 * 1024) {
      throw new ProviderError("budget", "Provider messages exceed the bounded request size.");
    }
    if (scanSecrets(message.content).length > 0) {
      throw new ProviderError("safety", "Credential-like content is blocked at the provider boundary.");
    }
  });
  try {
    canonicalJson(request.responseSchema);
    for (const tool of request.tools ?? []) canonicalJson(tool.inputSchema);
  } catch (error) {
    throw new ProviderError("configuration", "Provider response/tool schema is not canonical JSON.", { cause: error });
  }
  const toolNames = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(tool.name)
      || typeof tool.description !== "string" || tool.description.length === 0 || tool.description.length > 4096
      || toolNames.has(tool.name)) {
      throw new ProviderError("configuration", "Provider tool definition is invalid or duplicated.");
    }
    toolNames.add(tool.name);
  }
}

function outputContainsSecret(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return scanSecrets(value).length > 0;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => outputContainsSecret(item, seen));
  return Object.values(value as Record<string, unknown>).some((item) => outputContainsSecret(item, seen));
}

export interface GenerateValidatedOptions {
  budget?: ProviderBudgetTracker;
  /** Runs after pessimistic budget charging and before network transmission. */
  onBeforeRequest?: () => void | Promise<void>;
}

/**
 * Human-to-code role: obtain model output and accept it only after the host
 * validates the required code-artifact schema. Native JSON Schema support may
 * improve generation quality but never replaces this local validator.
 */
export async function generateValidated<T>(
  adapter: ProviderAdapter,
  request: ProviderGenerationRequestV1,
  validator: (value: unknown) => T,
  options: GenerateValidatedOptions = {},
): Promise<{ value: T; result: ProviderGenerationResultV1 }> {
  validateProviderRequest(request);
  if (request.signal?.aborted) throw new ProviderError("cancelled", "Provider request was cancelled.");
  const remainingOutput = options.budget?.remainingOutputTokens;
  const remainingElapsed = options.budget?.remainingElapsedMs;
  const effectiveRequest = {
    ...request,
    maxOutputTokens: remainingOutput === undefined ? request.maxOutputTokens : Math.min(request.maxOutputTokens, remainingOutput),
    timeoutMs: remainingElapsed === undefined ? request.timeoutMs : Math.min(request.timeoutMs, remainingElapsed),
  };
  const conservativeInput = conservativeProviderInputTokenUpperBound(effectiveRequest);
  let requestReservation: ProviderRequestReservationV1 | undefined;
  if (options.budget) {
    const maximumCost = adapter.maximumRequestCostUsd?.(effectiveRequest);
    if (adapter.capabilities.remote && maximumCost === undefined) {
      throw new ProviderError(
        "configuration",
        "Remote provider has no conservative cost-accounting policy; the request was not sent.",
      );
    }
    requestReservation = options.budget.beginRequest(
      conservativeInput,
      effectiveRequest.maxOutputTokens,
      maximumCost ?? 0,
    );
    try {
      await options.onBeforeRequest?.();
    } catch (error) {
      options.budget.cancelRequest(requestReservation);
      throw new ProviderError(
        "internal",
        "Provider request checkpoint could not be persisted; the request was not sent.",
        { cause: error },
      );
    }
  }
  let result: ProviderGenerationResultV1;
  try {
    result = await adapter.generate(effectiveRequest);
  } catch (error) {
    options.budget?.recordFailedRequest(requestReservation);
    throw normalizeProviderError(error);
  }
  if (!result || typeof result !== "object") {
    options.budget?.recordFailedRequest(requestReservation);
    throw new ProviderError("schema", "Provider returned an invalid result envelope.");
  }
  if (!result.resolvedModelId?.trim() || !result.requestId?.trim()) {
    options.budget?.recordFailedRequest(requestReservation);
    throw new ProviderError("schema", "Provider omitted resolved model or request identity.");
  }
  if (!(["stop", "tool_call", "length", "refusal", "other"] as const).includes(result.finishReason)
    || !Number.isSafeInteger(result.usage?.inputTokens) || result.usage.inputTokens < 0
    || !Number.isSafeInteger(result.usage?.outputTokens) || result.usage.outputTokens < 0
    || (result.usage.costUsd !== undefined && (!Number.isFinite(result.usage.costUsd) || result.usage.costUsd < 0))) {
    options.budget?.recordFailedRequest(requestReservation);
    throw new ProviderError("schema", "Provider returned invalid finish or usage metadata.", { requestId: result.requestId });
  }
  // Usage is charged for refusals, truncation, and malformed structured output too.
  options.budget?.recordUsage(result.usage, requestReservation);
  if (result.usage.outputTokens > effectiveRequest.maxOutputTokens) {
    throw new ProviderError("budget", "Provider exceeded the enforced per-request output-token limit.", { requestId: result.requestId });
  }
  if (result.finishReason === "refusal") throw new ProviderError("refusal", "Provider refused the request.", { requestId: result.requestId });
  if (result.finishReason === "length") throw new ProviderError("budget", "Provider output was truncated by its output limit.", { requestId: result.requestId });
  let detachedOutput: unknown;
  try {
    detachedOutput = structuredClone(result.output);
  } catch (error) {
    throw new ProviderError("schema", "Provider output is not cloneable structured data.", { requestId: result.requestId, cause: error });
  }
  if (outputContainsSecret(detachedOutput)) {
    throw new ProviderError("safety", "Credential-like content in provider output was blocked before persistence.", { requestId: result.requestId });
  }
  let value: T;
  try {
    value = validator(detachedOutput);
  } catch (error) {
    throw new ProviderError("schema", "Provider output failed local schema validation.", { requestId: result.requestId, cause: error });
  }
  return {
    value,
    result: {
      output: detachedOutput,
      resolvedModelId: result.resolvedModelId,
      requestId: result.requestId,
      usage: { ...result.usage },
      finishReason: result.finishReason,
    },
  };
}

export interface RetryProviderOptions {
  maxRetries?: number;
  maxElapsedMs: number;
  signal?: AbortSignal;
  backoffMs?: (retry: number, error: ProviderError) => number;
  onRetry?: (retry: number, error: ProviderError) => void | Promise<void>;
  clock?: () => number;
}

/** Retry only timeout, rate-limit, and 5xx failures; never more than twice. */
export async function withProviderRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryProviderOptions,
): Promise<T> {
  const retries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 2) throw new RangeError("maxRetries must be an integer from 0 to 2.");
  if (!Number.isSafeInteger(options.maxElapsedMs) || options.maxElapsedMs < 1) throw new RangeError("maxElapsedMs must be a positive integer.");
  const clock = options.clock ?? Date.now;
  const started = clock();
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) throw new ProviderError("cancelled", "Provider request was cancelled.");
    try {
      const result = await operation(attempt);
      if (clock() - started > options.maxElapsedMs) {
        throw new ProviderError("budget", "Provider retry operation exceeded its total elapsed-time budget.");
      }
      return result;
    } catch (raw) {
      const error = normalizeProviderError(raw);
      const retry = attempt;
      if (!error.retryable || retry > retries || clock() - started >= options.maxElapsedMs) throw error;
      await options.onRetry?.(retry, error);
      const wait = options.backoffMs?.(retry, error) ?? 250 * 2 ** (retry - 1);
      if (!Number.isFinite(wait) || wait < 0 || wait > 60_000) throw new RangeError("Retry backoff must be from 0 to 60000 ms.");
      if (clock() - started + wait >= options.maxElapsedMs) throw error;
      if (wait > 0) {
        try {
          await delay(wait, undefined, { signal: options.signal });
        } catch {
          throw new ProviderError("cancelled", "Provider retry wait was cancelled.");
        }
      }
    }
  }
}

export interface DeterministicMockOutput {
  output: unknown;
  usage?: ProviderRequestUsageV1;
  finishReason?: ProviderFinishReason;
  requestId?: string;
}

export type DeterministicMockStep =
  | DeterministicMockOutput
  | Error
  | ((request: ProviderGenerationRequestV1, sequence: number) => DeterministicMockOutput | Promise<DeterministicMockOutput>);

/** A no-network provider for deterministic unit/integration and CI runs. */
export class DeterministicMockProvider implements ProviderAdapter {
  readonly name = "mock";
  readonly capabilities: Readonly<ProviderCapabilitiesV1>;
  readonly #resolvedModelId: string;
  readonly #steps: DeterministicMockStep[];
  #sequence = 0;

  constructor(options: {
    resolvedModelId?: string;
    steps: readonly DeterministicMockStep[];
    nativeStructuredOutput?: boolean;
  }) {
    this.#resolvedModelId = options.resolvedModelId ?? "mock-v1";
    this.#steps = [...options.steps];
    this.capabilities = Object.freeze({
      nativeStructuredOutput: options.nativeStructuredOutput ?? false,
      toolCalling: true,
      cancellation: true,
      tokenCounting: "estimated",
      usageReporting: true,
      remote: false,
      maxContextTokens: 1_000_000,
    });
  }

  async generate(request: ProviderGenerationRequestV1): Promise<ProviderGenerationResultV1> {
    if (request.signal?.aborted) throw new ProviderError("cancelled", "Mock request was cancelled.");
    const sequence = ++this.#sequence;
    const step = this.#steps[sequence - 1];
    if (step === undefined) throw new ProviderError("internal", "Deterministic mock response queue is exhausted.");
    if (step instanceof Error) throw step;
    const response = typeof step === "function" ? await step(request, sequence) : step;
    const outputText = (() => {
      try { return canonicalJson(response.output); } catch { return String(response.output); }
    })();
    return {
      output: structuredClone(response.output),
      resolvedModelId: this.#resolvedModelId,
      requestId: response.requestId ?? `mock-${sequence}`,
      usage: response.usage ?? {
        inputTokens: estimateProviderInputTokens(request),
        outputTokens: Math.ceil(Buffer.byteLength(outputText, "utf8") / 4),
      },
      finishReason: response.finishReason ?? "stop",
    };
  }
}

/** Type-only convenience for providers that surface context tool arguments. */
export type CompilerContextToolOutput = ContextRequestV1;
