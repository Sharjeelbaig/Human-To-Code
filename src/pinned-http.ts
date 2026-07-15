/** Dependency-free HTTP(S) transport whose socket is pinned to a vetted IP. */

import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface PinnedDestination {
  /** Original hostname used for Host and TLS certificate verification. */
  hostname: string;
  /** Exact vetted address used by the socket; no second DNS lookup occurs. */
  address: string;
  family: 4 | 6;
}

function abortError(): DOMException {
  return new DOMException("The provider request was aborted.", "AbortError");
}

function requestBody(init: RequestInit, method: "GET" | "POST"): Buffer {
  if (method === "GET") {
    if (init.body !== undefined && init.body !== null) {
      throw new TypeError("Pinned GET requests must not contain a request body.");
    }
    return Buffer.alloc(0);
  }
  if (typeof init.body === "string") return Buffer.from(init.body, "utf8");
  if (init.body instanceof Uint8Array) return Buffer.from(init.body);
  if (init.body === undefined || init.body === null) return Buffer.alloc(0);
  throw new TypeError("Pinned provider transport accepts only bounded string or byte request bodies.");
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function webResponse(message: IncomingMessage): Response {
  const status = message.statusCode;
  if (status === undefined || status < 200 || status > 599) {
    message.destroy();
    throw new Error("Provider returned an unsupported HTTP status.");
  }
  const hasNoBody = status === 204 || status === 205 || status === 304;
  const body = hasNoBody
    ? null
    : Readable.toWeb(message) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status,
    statusText: message.statusMessage ?? "",
    headers: responseHeaders(message),
  });
}

function normalizedHeaders(
  url: URL,
  init: RequestInit,
  body: Buffer,
  method: "GET" | "POST",
): Record<string, string> {
  const source = new Headers(init.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of source.entries()) headers[name] = value;
  for (const name of [
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete headers[name];
  }
  // Host is derived from the reviewed URL and cannot be supplied by a caller.
  headers.host = url.host;
  if (method === "POST") headers["content-length"] = String(body.byteLength);
  else delete headers["content-length"];
  headers.connection = "close";
  return headers;
}

/**
 * GET or POST using a socket connected to `destination.address`. HTTPS
 * retains the original hostname for SNI and certificate identity checks.
 * Environment proxy variables and the OS resolver are intentionally bypassed.
 */
export function pinnedHttpFetch(
  rawUrl: string,
  init: RequestInit,
  destination: PinnedDestination,
): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new TypeError("Pinned provider transport supports only HTTP(S)."));
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return Promise.reject(new TypeError("Pinned HTTP URLs must not contain credentials or fragments."));
  }
  if (destination.family !== isIP(destination.address)) {
    return Promise.reject(new TypeError("Pinned provider destination address/family is invalid."));
  }
  if (destination.hostname !== url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase()) {
    return Promise.reject(new TypeError("Pinned provider hostname does not match its reviewed URL."));
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return Promise.reject(new TypeError("Pinned HTTP transport permits only GET or POST."));
  }
  let body: Buffer;
  try {
    body = requestBody(init, method);
  } catch (error) {
    return Promise.reject(error);
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError());
  const headers = normalizedHeaders(url, init, body, method);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const common: HttpRequestOptions = {
    protocol: url.protocol,
    hostname: destination.address,
    family: destination.family,
    port,
    method,
    path: `${url.pathname}${url.search}`,
    headers,
    agent: false,
    maxHeaderSize: 64 * 1024,
    setHost: false,
  };

  return new Promise<Response>((resolveResponse, reject) => {
    let message: IncomingMessage | undefined;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanupBeforeResponse();
      reject(error);
    };
    const onAbort = (): void => {
      const error = abortError();
      message?.destroy(error);
      request.destroy(error);
    };
    const cleanupBeforeResponse = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onResponse = (incoming: IncomingMessage): void => {
      message = incoming;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      // Keep the abort listener until the response body closes so timeout and
      // caller cancellation also stop a stalled download.
      incoming.once("close", cleanupBeforeResponse);
      try {
        const result = webResponse(incoming);
        settled = true;
        resolveResponse(result);
      } catch (error) {
        finishError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const request = url.protocol === "https:"
      ? httpsRequest({
          ...(common as HttpsRequestOptions),
          // For DNS names this controls both SNI and certificate hostname
          // validation. IP-literal endpoints are verified against their IP SAN.
          ...(isIP(destination.hostname) === 0 ? { servername: destination.hostname } : {}),
        }, onResponse)
      : httpRequest(common, onResponse);
    request.once("error", finishError);
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end(body);
  });
}
