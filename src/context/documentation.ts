/** Version-bound, allowlisted official documentation retrieval and cache. */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pinnedHttpFetch, type PinnedDestination } from "../security/pinned-http.ts";
import {
  DEFAULT_OFFICIAL_DOCUMENTATION_HOSTS,
  ContextSecurityError,
  scanSecrets,
  type OfficialDocumentationCandidateV1,
} from "./context.ts";
import { sha256Bytes, sha256Text } from "../core/contracts.ts";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_SCHEMA_VERSION = 1 as const;

export type DocumentationFetch = (url: string, init: RequestInit) => Promise<Response>;
export type DocumentationResolver = (hostname: string) => Promise<readonly string[]>;

export interface DocumentationRequestV1 {
  url: string;
  /** Exact installed language/framework/library version bound to this evidence. */
  version: string;
  reason: string;
  offline?: boolean;
}

export interface DocumentationClientOptions {
  cacheRoot?: string;
  allowedHosts?: readonly string[];
  fetch?: DocumentationFetch;
  resolveHostname?: DocumentationResolver;
  maxBytes?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DocumentationCacheEntryV1 {
  schemaVersion: 1;
  cacheKey: string;
  requestedUrl: string;
  finalUrl: string;
  version: string;
  fetchedAt: string;
  sourceSha256: string;
  contentSha256: string;
  content: string;
  etag?: string;
  lastModified?: string;
}

export class DocumentationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentationError";
    this.code = code;
  }
}

function defaultCacheRoot(env: NodeJS.ProcessEnv): string {
  if (env.HUMAN_TO_CODE_CACHE) return resolve(env.HUMAN_TO_CODE_CACHE, "documentation");
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME, "human-to-code", "documentation");
  if (process.platform === "win32" && env.LOCALAPPDATA) return resolve(env.LOCALAPPDATA, "human-to-code", "documentation");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "human-to-code", "documentation");
  return resolve(homedir(), ".cache", "human-to-code", "documentation");
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname) !== 0) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return allowed.some((candidate) => {
    const value = candidate.toLowerCase().replace(/\.$/u, "");
    return host === value || host.endsWith(`.${value}`);
  });
}

function normalizedAddress(raw: string): { address: string; family: 4 | 6 } | undefined {
  if (raw.length === 0 || raw !== raw.trim() || raw.includes("%")) return undefined;
  const family = isIP(raw);
  if (family === 4) {
    const octets = raw.split(".").map(Number);
    return octets.length === 4 ? { address: octets.join("."), family: 4 } : undefined;
  }
  if (family !== 6) return undefined;
  try {
    const bracketed = new URL(`http://[${raw}]/`).hostname;
    return { address: bracketed.slice(1, -1).toLowerCase(), family: 6 };
  } catch {
    return undefined;
  }
}

function mappedIpv4(address: string): string | undefined {
  if (!address.startsWith("::ffff:")) return undefined;
  const tail = address.slice("::ffff:".length);
  if (isIP(tail) === 4) return tail;
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(tail);
  if (!match) return undefined;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function unsafeAddress(address: string): boolean {
  const normalized = normalizedAddress(address)?.address;
  if (!normalized) return true;
  if (isIP(normalized) === 4) {
    const [a = -1, b = -1, c = -1] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && b === 168
      || a === 192 && b === 0 && (c === 0 || c === 2)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113
      || a >= 224;
  }
  const mapped = mappedIpv4(normalized);
  if (mapped) return unsafeAddress(mapped);
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff")
    || normalized.startsWith("64:ff9b:") || normalized.startsWith("100:")
    || normalized.startsWith("2001::") || normalized.startsWith("2001:2:")
    || /^2001:(?:1[0-9a-f]|2[0-9a-f]):/u.test(normalized)
    || normalized.startsWith("2001:db8:") || normalized.startsWith("2002:")
    || normalized.startsWith("3fff:");
}

async function resolveWithSignal(
  resolver: DocumentationResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise<readonly string[]>((complete, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => resolver(hostname)).then(
      (answers) => finish(() => complete(answers)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function validateUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new DocumentationError("INVALID_URL", "Official documentation URL is invalid.", { cause });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.length === 0) {
    throw new DocumentationError("URL_BLOCKED", "Official documentation must use credential-free HTTPS on the default port.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || !hostAllowed(hostname, allowedHosts)) {
    throw new DocumentationError("URL_BLOCKED", "Official documentation host is not on the public allowlist.");
  }
  url.hash = "";
  return url;
}

function validateRequest(request: DocumentationRequestV1): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/u.test(request.version)
    || /^(?:latest|next|stable|nightly|main|master|head|dev)$/iu.test(request.version)
    || /[<>=^~*]/u.test(request.version)) {
    throw new DocumentationError("INVALID_VERSION", "Documentation evidence requires an exact bounded version identifier.");
  }
  if (typeof request.reason !== "string" || request.reason.trim().length === 0 || request.reason.length > 4096) {
    throw new DocumentationError("INVALID_REASON", "Documentation retrieval requires a bounded evidence reason.");
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function metadataValid(value: unknown, key: string, requestedUrl: string, version: string): value is DocumentationCacheEntryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<DocumentationCacheEntryV1>;
  const optionalOkay = (entry.etag === undefined || typeof entry.etag === "string")
    && (entry.lastModified === undefined || typeof entry.lastModified === "string");
  return entry.schemaVersion === 1 && entry.cacheKey === key && entry.requestedUrl === requestedUrl
    && entry.version === version && typeof entry.finalUrl === "string" && typeof entry.fetchedAt === "string"
    && typeof entry.sourceSha256 === "string" && typeof entry.contentSha256 === "string" && typeof entry.content === "string"
    && /^[a-f0-9]{64}$/u.test(entry.sourceSha256) && sha256Text(entry.content) === entry.contentSha256 && optionalOkay;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/gu, (_match, decimal: string) => {
      const code = Number(decimal);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function normalizedContent(source: string, contentType: string): string {
  const clean = source.replace(/\r\n?/gu, "\n");
  if (!/html|xhtml/iu.test(contentType)) return clean.trim();
  return decodeEntities(clean
    .replace(/<(?:script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg)>/giu, "\n")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/code)>/giu, "\n")
    .replace(/<[^>]+>/gu, " "))
    .split("\n")
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .filter((line, index, lines) => line.length > 0 && (index === 0 || line !== lines[index - 1]))
    .join("\n");
}

async function boundedUtf8(response: Response, maximum: number): Promise<{ source: string; sourceHash: string }> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maximum) throw new DocumentationError("RESPONSE_TOO_LARGE", "Official documentation exceeds the response budget.");
  if (!response.body) throw new DocumentationError("EMPTY_RESPONSE", "Official documentation response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new DocumentationError("RESPONSE_TOO_LARGE", "Official documentation exceeds the response budget.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { source: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sourceHash: sha256Bytes(bytes) };
  } catch (cause) {
    throw new DocumentationError("INVALID_UTF8", "Official documentation is not valid UTF-8.", { cause });
  }
}

interface FetchResult {
  status: "not-modified" | "content";
  finalUrl: URL;
  response: Response;
  source?: string;
  sourceHash?: string;
}

export class OfficialDocumentationClient {
  readonly cacheRoot: string;
  readonly #allowedHosts: readonly string[];
  /** An explicitly trusted test seam; production uses the pinned transport. */
  readonly #fetch: DocumentationFetch | undefined;
  readonly #resolver: DocumentationResolver;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(options: DocumentationClientOptions = {}) {
    const env = options.env ?? process.env;
    this.cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot(env));
    this.#allowedHosts = [...new Set(options.allowedHosts ?? DEFAULT_OFFICIAL_DOCUMENTATION_HOSTS)];
    if (this.#allowedHosts.length === 0 || this.#allowedHosts.some((host) => !/^[a-z0-9.-]+$/iu.test(host))) throw new DocumentationError("INVALID_ALLOWLIST", "Documentation allowlist is invalid.");
    this.#fetch = options.fetch;
    this.#resolver = options.resolveHostname ?? defaultResolver;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024 || this.#maxBytes > ABSOLUTE_MAX_BYTES) throw new DocumentationError("INVALID_BUDGET", "Documentation byte budget is invalid.");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 300_000) throw new DocumentationError("INVALID_TIMEOUT", "Documentation timeout is invalid.");
  }

  #cachePath(key: string): string {
    return resolve(this.cacheRoot, `${key}.json`);
  }

  async #readCache(key: string, requestedUrl: string, version: string): Promise<DocumentationCacheEntryV1 | undefined> {
    const path = this.#cachePath(key);
    const metadata = await lstat(path).catch(() => undefined);
    if (!metadata) return undefined;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > this.#maxBytes * 2) throw new DocumentationError("CACHE_TAMPERED", "Documentation cache entry is not a bounded single-link file.");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (cause) {
      throw new DocumentationError("CACHE_TAMPERED", "Documentation cache entry is invalid JSON.", { cause });
    }
    if (!metadataValid(value, key, requestedUrl, version)) throw new DocumentationError("CACHE_TAMPERED", "Documentation cache provenance or content hash is invalid.");
    return value;
  }

  async #publicAnswers(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ key: string; selected: PinnedDestination }> {
    let answers: readonly string[];
    try {
      answers = await resolveWithSignal(this.#resolver, url.hostname, signal);
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new DocumentationError("DNS_FAILURE", "Official documentation hostname could not be resolved.", { cause });
    }
    const normalized = answers.map(normalizedAddress);
    if (answers.length === 0 || normalized.some((answer) => !answer)
      || answers.some(unsafeAddress)) {
      throw new DocumentationError("NETWORK_BLOCKED", "Official documentation hostname resolved outside the public network.");
    }
    const destinations = [...new Map(
      (normalized as Array<{ address: string; family: 4 | 6 }>)
        .map((answer) => [`${answer.family}:${answer.address}`, answer] as const),
    ).values()].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
    const selected = destinations[0];
    if (!selected) throw new DocumentationError("DNS_FAILURE", "Official documentation hostname returned no usable address.");
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
    return {
      key: destinations.map((answer) => `${answer.family}:${answer.address}`).join(","),
      selected: { hostname, ...selected },
    };
  }

  async #request(start: URL, cached?: DocumentationCacheEntryV1): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    let current = start;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        current = validateUrl(current.href, this.#allowedHosts);
        const before = await this.#publicAnswers(current, controller.signal);
        const headers: Record<string, string> = { accept: "text/html, text/markdown, text/plain, application/json;q=0.8", "user-agent": "human-to-code-documentation/0.1" };
        if (redirects === 0 && cached?.etag) headers["if-none-match"] = cached.etag;
        if (redirects === 0 && cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
        let response: Response;
        try {
          const init: RequestInit = { method: "GET", redirect: "manual", headers, signal: controller.signal };
          response = this.#fetch
            ? await this.#fetch(current.href, init)
            : await pinnedHttpFetch(current.href, init, before.selected);
        } catch (cause) {
          if (controller.signal.aborted) throw new DocumentationError("TIMEOUT", "Official documentation request timed out.", { cause });
          throw new DocumentationError("NETWORK_FAILURE", "Official documentation request failed.", { cause });
        }
        const after = await this.#publicAnswers(current, controller.signal);
        if (before.key !== after.key) {
          await response.body?.cancel().catch(() => undefined);
          throw new DocumentationError("DNS_REBINDING", "Official documentation hostname changed addresses during retrieval.");
        }
        if (response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw new DocumentationError("REDIRECT_BLOCKED", "HTTP client followed a redirect outside the policy gate.");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === MAX_REDIRECTS) throw new DocumentationError("REDIRECT_LIMIT", "Official documentation redirect limit was exceeded.");
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) throw new DocumentationError("REDIRECT_BLOCKED", "Official documentation redirect omitted Location.");
          current = validateUrl(new URL(location, current).href, this.#allowedHosts);
          continue;
        }
        if (response.status === 304 && cached) return { status: "not-modified", finalUrl: current, response };
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new DocumentationError("HTTP_FAILURE", `Official documentation returned HTTP ${response.status}.`);
        }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (!new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown", "application/json"]).has(contentType)) {
          await response.body?.cancel().catch(() => undefined);
          throw new DocumentationError("CONTENT_TYPE_BLOCKED", `Official documentation content type is not allowed: ${contentType || "missing"}.`);
        }
        const body = await boundedUtf8(response, this.#maxBytes);
        return { status: "content", finalUrl: current, response, ...body };
      }
      throw new DocumentationError("REDIRECT_LIMIT", "Official documentation redirect limit was exceeded.");
    } finally {
      clearTimeout(timer);
    }
  }

  async retrieve(request: DocumentationRequestV1): Promise<OfficialDocumentationCandidateV1> {
    validateRequest(request);
    const requested = validateUrl(request.url, this.#allowedHosts);
    const key = sha256Text(`${requested.href}\0${request.version}`);
    const cached = await this.#readCache(key, requested.href, request.version);
    if (request.offline) {
      if (!cached) throw new DocumentationError("OFFLINE_MISS", "Version-matched official documentation is not present in the offline cache.");
      return {
        origin: "official_documentation", url: cached.finalUrl, version: cached.version, content: cached.content,
        contentSha256: cached.contentSha256, reason: request.reason, cached: true,
      };
    }
    const fetched = await this.#request(requested, cached);
    if (fetched.status === "not-modified") {
      const entry = cached!;
      return {
        origin: "official_documentation", url: entry.finalUrl, version: entry.version, content: entry.content,
        contentSha256: entry.contentSha256, reason: request.reason, cached: true,
      };
    }
    const source = fetched.source!;
    const contentType = fetched.response.headers.get("content-type") ?? "text/plain";
    const content = normalizedContent(source, contentType);
    if (content.length === 0) throw new DocumentationError("EMPTY_CONTENT", "Official documentation contained no usable text.");
    if (scanSecrets(content).length > 0) throw new ContextSecurityError("SECRET_DETECTED", "Credential-like content in remote documentation was blocked before cache/provider writes.", fetched.finalUrl.href);
    const entry: DocumentationCacheEntryV1 = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cacheKey: key,
      requestedUrl: requested.href,
      finalUrl: fetched.finalUrl.href,
      version: request.version,
      fetchedAt: new Date().toISOString(),
      sourceSha256: fetched.sourceHash!,
      contentSha256: sha256Text(content),
      content,
      ...(fetched.response.headers.get("etag") ? { etag: fetched.response.headers.get("etag")! } : {}),
      ...(fetched.response.headers.get("last-modified") ? { lastModified: fetched.response.headers.get("last-modified")! } : {}),
    };
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    await chmod(this.cacheRoot, 0o700);
    await atomicJson(this.#cachePath(key), entry);
    return {
      origin: "official_documentation", url: entry.finalUrl, version: entry.version, content: entry.content,
      contentSha256: entry.contentSha256, reason: request.reason, cached: false,
    };
  }
}
