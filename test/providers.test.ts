import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { ProviderConfigV1 } from "../src/config/config.ts";
import {
  generateValidated,
  ProviderError,
  type JsonSchemaV1,
  type ProviderGenerationRequestV1,
} from "../src/llms/provider.ts";
import {
  OllamaProvider,
  OpenAIResponsesProvider,
  type ProviderFetch,
  type ProviderHostnameResolver,
} from "../src/llms/adapters.ts";
import { pinnedHttpFetch } from "../src/tools/security/pinned-http.ts";

const RESPONSE_SCHEMA: JsonSchemaV1 = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

const TEST_PRICING = Object.freeze({
  inputUsdPerMillionTokens: 10,
  outputUsdPerMillionTokens: 20,
});

function request(
  overrides: Partial<ProviderGenerationRequestV1> = {},
): ProviderGenerationRequestV1 {
  return {
    operation: "patch",
    model: "requested-model",
    messages: [
      { role: "system", content: "Follow the reviewed contract." },
      { role: "user", content: "Produce the patch." },
    ],
    responseSchema: RESPONSE_SCHEMA,
    timeoutMs: 2_000,
    maxOutputTokens: 1_024,
    ...overrides,
  };
}

const PUBLIC_RESOLVER: ProviderHostnameResolver = async (hostname) =>
  hostname === "localhost" ? ["127.0.0.1"] : ["93.184.216.34"];

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

async function localServerPort(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeLocalServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

test("pinned HTTP transport connects to the vetted address without resolving the URL host", async (t) => {
  const received: Array<{ method: string; host: string; body: string }> = [];
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      received.push({
        method: incoming.method ?? "",
        host: incoming.headers.host ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(incoming.method === "POST" ? "{\"ok\":true}" : "{\"ok\":false}");
    });
  });
  t.after(async () => closeLocalServer(server));
  const port = await localServerPort(server);
  const hostname = "intentionally-unresolvable.invalid";
  const destination = { hostname, address: "127.0.0.1", family: 4 as const };

  const post = await pinnedHttpFetch(
    `http://${hostname}:${port}/chat`,
    { method: "POST", body: "{\"request\":true}" },
    destination,
  );
  assert.deepEqual(await post.json(), { ok: true });
  const get = await pinnedHttpFetch(
    `http://${hostname}:${port}/docs?version=1`,
    { method: "GET" },
    destination,
  );
  assert.deepEqual(await get.json(), { ok: false });

  assert.deepEqual(received, [
    {
      method: "POST",
      host: `${hostname}:${port}`,
      body: "{\"request\":true}",
    },
    { method: "GET", host: `${hostname}:${port}`, body: "" },
  ]);
  await assert.rejects(
    pinnedHttpFetch(
      `http://${hostname}:${port}/docs`,
      { method: "GET", body: "forbidden" },
      destination,
    ),
    /must not contain a request body/u,
  );
});

test("OpenAI uses Responses strict JSON Schema and records resolved identity", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const fetch: ProviderFetch = async (url, init) => {
    calledUrl = url;
    calledInit = init;
    return response(
      {
        id: "resp_123",
        model: "resolved-model-2026-01-01",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "{\"ok\":true}" }],
          },
        ],
        usage: { input_tokens: 17, output_tokens: 5 },
      },
      { headers: { "x-request-id": "request_123" } },
    );
  };
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      fetch,
      resolveHostname: PUBLIC_RESOLVER,
      env: { OPENAI_API_KEY: "openai-test-key" },
      requestIdFactory: () => "client-openai-1",
    },
  );

  const sourceSchema: JsonSchemaV1 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { const: true } },
    uniqueItems: true,
  };
  const result = await provider.generate(request({ responseSchema: sourceSchema }));

  assert.equal(calledUrl, "https://api.openai.com/v1/responses");
  assert.equal(
    new Headers(calledInit?.headers).get("authorization"),
    "Bearer openai-test-key",
  );
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, "requested-model");
  assert.deepEqual(body.input, [{ role: "user", content: "Produce the patch." }]);
  assert.match(String(body.instructions), /Follow the reviewed contract/u);
  assert.deepEqual(body.text, {
    format: {
      type: "json_schema",
      name: "human_to_code_patch_v1",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { enum: [true] } },
      },
    },
  });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.resolvedModelId, "resolved-model-2026-01-01");
  assert.equal(result.requestId, "request_123");
  assert.deepEqual(result.usage, {
    inputTokens: 17,
    outputTokens: 5,
    costUsd: 0.00027,
  });
  assert.equal(result.finishReason, "stop");
});

test("OpenAI keeps policy in instructions and preserves conversational trust roles", async () => {
  let calledInit: RequestInit | undefined;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      fetch: async (_url, init) => {
        calledInit = init;
        return response({
          id: "role-response",
          model: "resolved-model",
          status: "completed",
          output_text: "{\"ok\":true}",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    },
  );
  await provider.generate(request({
    messages: [
      { role: "system", content: "reviewed host policy" },
      { role: "user", content: "untrusted project request" },
      { role: "assistant", content: "prior model output" },
      { role: "tool", name: "request_context", content: "untrusted evidence" },
    ],
  }));
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.match(String(body.instructions), /reviewed host policy/u);
  assert.doesNotMatch(String(body.instructions), /untrusted project request/u);
  assert.deepEqual(body.input, [
    { role: "user", content: "untrusted project request" },
    { role: "assistant", content: "prior model output" },
    {
      role: "user",
      content: "<untrusted-tool-transcript name=\"request_context\">untrusted evidence</untrusted-tool-transcript>",
    },
  ]);
});

test("OpenAI custom endpoints require a separately named credential", () => {
  const config: ProviderConfigV1 = {
    name: "openai",
    model: "model",
    pricing: TEST_PRICING,
    baseUrl: "https://models.example.com/v1",
    trustCustomEndpoint: true,
  };
  assert.throws(
    () =>
      new OpenAIResponsesProvider(config, {
        resolveHostname: PUBLIC_RESOLVER,
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "configuration",
  );
});

test("OpenAI binds a custom endpoint to its configured environment key", async () => {
  let authorization = "";
  const provider = new OpenAIResponsesProvider(
    {
      name: "openai",
      model: "requested-model",
      pricing: TEST_PRICING,
      baseUrl: "https://models.example.com/v1",
      trustCustomEndpoint: true,
      apiKeyEnv: "PRIVATE_PROVIDER_KEY",
    },
    {
      env: {
        OPENAI_API_KEY: "must-not-be-used",
        PRIVATE_PROVIDER_KEY: "endpoint-bound-key",
      },
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "client-openai-custom",
      fetch: async (_url, init) => {
        authorization = new Headers(init.headers).get("authorization") ?? "";
        return response({
          id: "response-custom",
          model: "resolved",
          status: "completed",
          output_text: "{\"ok\":true}",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    },
  );
  await provider.generate(request());
  assert.equal(authorization, "Bearer endpoint-bound-key");
});

test("provider adapter refuses a model that differs from reviewed config", async () => {
  let called = false;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "reviewed-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      fetch: async () => {
        called = true;
        return response({});
      },
    },
  );
  await assert.rejects(
    provider.generate(request({ model: "different-model" })),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "configuration",
  );
  assert.equal(called, false);
});

test("local Ollama uses loopback without a key and native schema format", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const provider = new OllamaProvider(
    { name: "ollama", model: "qwen3-coder" },
    {
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "client-ollama-local",
      fetch: async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return response({
          model: "qwen3-coder:latest",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: "{\"ok\":true}" },
          prompt_eval_count: 11,
          eval_count: 4,
        });
      },
    },
  );

  const result = await provider.generate(request({ model: "qwen3-coder" }));

  assert.equal(calledUrl, "http://localhost:11434/api/chat");
  assert.equal(new Headers(calledInit?.headers).has("authorization"), false);
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body.format, RESPONSE_SCHEMA);
  assert.equal(body.model, "qwen3-coder");
  assert.equal(provider.capabilities.remote, false);
  assert.equal(provider.capabilities.nativeStructuredOutput, true);
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.resolvedModelId, "qwen3-coder:latest");
});

test("local Ollama provider uses the production DNS-pinned POST transport", async (t) => {
  let requestPath = "";
  let requestBody = "";
  const server = createServer((incoming, outgoing) => {
    requestPath = incoming.url ?? "";
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("utf8");
      outgoing.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "local-pinned-server",
      });
      outgoing.end(JSON.stringify({
        model: "qwen3-coder:local-resolved",
        done: true,
        done_reason: "stop",
        message: { role: "assistant", content: "{\"ok\":true}" },
        prompt_eval_count: 7,
        eval_count: 3,
      }));
    });
  });
  t.after(async () => closeLocalServer(server));
  const port = await localServerPort(server);
  const provider = new OllamaProvider(
    {
      name: "ollama",
      model: "qwen3-coder",
      baseUrl: `http://localhost:${port}/api`,
      trustCustomEndpoint: true,
    },
    {
      resolveHostname: async () => ["127.0.0.1"],
      requestIdFactory: () => "local-pinned-client",
    },
  );

  const result = await provider.generate(request({ model: "qwen3-coder" }));
  assert.equal(requestPath, "/api/chat");
  assert.equal((JSON.parse(requestBody) as Record<string, unknown>).model, "qwen3-coder");
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.requestId, "local-pinned-server");
  assert.equal(result.resolvedModelId, "qwen3-coder:local-resolved");
});

test("Ollama preserves system, user, assistant, and named tool message roles", async () => {
  let calledInit: RequestInit | undefined;
  const provider = new OllamaProvider(
    { name: "ollama", model: "role-model" },
    {
      resolveHostname: PUBLIC_RESOLVER,
      fetch: async (_url, init) => {
        calledInit = init;
        return response({
          model: "role-model",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: "{\"ok\":true}" },
          prompt_eval_count: 1,
          eval_count: 1,
        });
      },
    },
  );
  await provider.generate(request({
    model: "role-model",
    messages: [
      { role: "system", content: "host policy" },
      { role: "user", content: "user request" },
      { role: "assistant", content: "tool call follows" },
      { role: "tool", name: "request_context", content: "bounded evidence" },
    ],
  }));
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.slice(0, -1), [
    { role: "system", content: "host policy" },
    { role: "user", content: "user request" },
    { role: "assistant", content: "tool call follows" },
    { role: "tool", content: "bounded evidence", tool_name: "request_context" },
  ]);
  assert.equal(messages.at(-1)?.role, "system");
  assert.match(String(messages.at(-1)?.content), /HOST-ENFORCED OUTPUT CONTRACT/u);
});

test("Ollama Cloud uses its API key and prompt schema without native format", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const provider = new OllamaProvider(
    {
      name: "ollama",
      model: "gpt-oss:120b-cloud",
      pricing: TEST_PRICING,
      baseUrl: "https://ollama.com/api",
      trustCustomEndpoint: true,
      apiKeyEnv: "OLLAMA_API_KEY",
    },
    {
      env: { OLLAMA_API_KEY: "ollama-cloud-key" },
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "client-ollama-cloud",
      fetch: async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return response({
          model: "gpt-oss:120b-cloud",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: "{\"ok\":true}" },
          prompt_eval_count: 20,
          eval_count: 5,
        });
      },
    },
  );

  await provider.generate(request({ model: "gpt-oss:120b-cloud" }));

  assert.equal(calledUrl, "https://ollama.com/api/chat");
  assert.equal(
    new Headers(calledInit?.headers).get("authorization"),
    "Bearer ollama-cloud-key",
  );
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, "format"), false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.match(messages.at(-1)?.content ?? "", /Return exactly one JSON value/u);
  assert.match(messages.at(-1)?.content ?? "", /"ok"/u);
  assert.equal(provider.capabilities.remote, true);
  assert.equal(provider.capabilities.nativeStructuredOutput, false);
});

test("Ollama exposes compiler tools only as declared function schemas", async () => {
  let calledInit: RequestInit | undefined;
  const provider = new OllamaProvider(
    { name: "ollama", model: "tool-model" },
    {
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "ollama-tool-client",
      fetch: async (_url, init) => {
        calledInit = init;
        return response({
          model: "tool-model",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: "{\"ok\":true}" },
          prompt_eval_count: 1,
          eval_count: 1,
        });
      },
    },
  );
  await provider.generate(
    request({
      model: "tool-model",
      tools: [
        {
          name: "request_context",
          description: "Request bounded context.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
        },
      ],
    }),
  );
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "request_context",
        description: "Request bounded context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string" } },
        },
      },
    },
  ]);
  assert.equal(Object.hasOwn(body, "command"), false);
});

test("custom Ollama Cloud endpoint requires an explicit environment key name", () => {
  assert.throws(
    () =>
      new OllamaProvider({
        name: "ollama",
        model: "model",
        pricing: TEST_PRICING,
        baseUrl: "https://ollama.example.com/api",
        trustCustomEndpoint: true,
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "configuration",
  );
});

test("Ollama Cloud malformed JSON is terminal schema failure", async () => {
  const provider = new OllamaProvider(
    {
      name: "ollama",
      model: "cloud-model",
      pricing: TEST_PRICING,
      baseUrl: "https://ollama.com/api",
      trustCustomEndpoint: true,
      apiKeyEnv: "OLLAMA_API_KEY",
    },
    {
      env: { OLLAMA_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "malformed-cloud",
      fetch: async () =>
        response({
          model: "cloud-model",
          done: true,
          message: { role: "assistant", content: "```json\n{\"ok\":true}\n```" },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
    },
  );
  await assert.rejects(
    provider.generate(request({ model: "cloud-model" })),
    (error: unknown) => error instanceof ProviderError && error.code === "schema",
  );
});

test("generateValidated locally rejects a schema-invalid Cloud object", async () => {
  const provider = new OllamaProvider(
    {
      name: "ollama",
      model: "cloud-model",
      pricing: TEST_PRICING,
      baseUrl: "https://ollama.com/api",
      trustCustomEndpoint: true,
      apiKeyEnv: "OLLAMA_API_KEY",
    },
    {
      env: { OLLAMA_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "invalid-shape-cloud",
      fetch: async () =>
        response({
          model: "cloud-model",
          done: true,
          message: { role: "assistant", content: "{\"wrong\":true}" },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
    },
  );
  await assert.rejects(
    generateValidated(provider, request({ model: "cloud-model" }), (value) => {
      const object = value as Record<string, unknown>;
      if (object.ok !== true) throw new Error("missing ok");
      return object;
    }),
    (error: unknown) => error instanceof ProviderError && error.code === "schema",
  );
});

test("provider credentials cannot cross redirect origins", async () => {
  let calls = 0;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      requestIdFactory: () => "redirect-client",
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 307,
          headers: { location: "https://attacker.example/steal" },
        });
      },
    },
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ProviderError && error.code === "safety",
  );
  assert.equal(calls, 1);
});

test("provider blocks private DNS answers before sending a request", async () => {
  let called = false;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: async () => ["10.1.2.3"],
      fetch: async () => {
        called = true;
        return response({});
      },
    },
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ProviderError && error.code === "safety",
  );
  assert.equal(called, false);
});

test("provider blocks IPv4-mapped and scoped IPv6 DNS answers", async (t) => {
  for (const unsafe of ["::ffff:7f00:1", "fe80::1%lo0"]) {
    await t.test(unsafe, async () => {
      let called = false;
      const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
        {
          env: { OPENAI_API_KEY: "key" },
          resolveHostname: async () => [unsafe],
          fetch: async () => {
            called = true;
            return response({});
          },
        },
      );
      await assert.rejects(
        provider.generate(request()),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "safety",
      );
      assert.equal(called, false);
    });
  }
});

test("same-origin redirects are re-resolved and DNS changes are blocked", async () => {
  let resolves = 0;
  let calls = 0;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: async () => {
        resolves += 1;
        return resolves === 1 ? ["93.184.216.34"] : ["93.184.216.35"];
      },
      requestIdFactory: () => "rebind-client",
      fetch: async () => {
        calls += 1;
        return new Response(null, {
          status: 307,
          headers: { location: "/v1/responses-redirected" },
        });
      },
    },
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ProviderError && error.code === "safety",
  );
  assert.equal(calls, 1);
});

test("HTTP rate limits are normalized and remain retryable", async () => {
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      fetch: async () => new Response(null, { status: 429 }),
    },
  );
  await assert.rejects(provider.generate(request()), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "rate_limit");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("provider timeout aborts the in-flight fetch and reports timeout", async () => {
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    },
  );
  await assert.rejects(
    provider.generate(request({ timeoutMs: 10 })),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );
});

test("provider timeout also bounds hostname resolution", async () => {
  let called = false;
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: async () =>
        await new Promise<readonly string[]>(() => undefined),
      fetch: async () => {
        called = true;
        return response({});
      },
    },
  );
  await assert.rejects(
    provider.generate(request({ timeoutMs: 10 })),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );
  assert.equal(called, false);
});

test("caller cancellation interrupts hostname resolution and remains cancellation", async () => {
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: async () => {
        markStarted?.();
        return await new Promise<readonly string[]>(() => undefined);
      },
      fetch: async () => response({}),
    },
  );
  const generated = provider.generate(request({
    signal: controller.signal,
    timeoutMs: 1_000,
  }));
  await started;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(
    generated,
    (error: unknown) =>
      error instanceof ProviderError && error.code === "cancelled",
  );
});

test("production pinned transport cancels a stalled response body", async (t) => {
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.once("end", () => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.write("{\"model\":");
    });
  });
  t.after(async () => closeLocalServer(server));
  const port = await localServerPort(server);
  const provider = new OllamaProvider(
    {
      name: "ollama",
      model: "stall-model",
      baseUrl: `http://localhost:${port}/api`,
      trustCustomEndpoint: true,
    },
    {
      resolveHostname: async () => ["127.0.0.1"],
      requestIdFactory: () => "stall-client",
    },
  );
  await assert.rejects(
    provider.generate(request({ model: "stall-model", timeoutMs: 50 })),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );
});

test("provider response bytes are bounded before JSON parsing", async () => {
  const provider = new OpenAIResponsesProvider(
    { name: "openai", model: "requested-model", pricing: TEST_PRICING },
    {
      env: { OPENAI_API_KEY: "key" },
      resolveHostname: PUBLIC_RESOLVER,
      maxResponseBytes: 1_024,
      fetch: async () =>
        new Response(JSON.stringify({ padding: "x".repeat(2_000) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ProviderError && error.code === "budget",
  );
});
