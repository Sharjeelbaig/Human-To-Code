/**
 * A scripted stand-in for a local Ollama server, used by the stress corpus.
 *
 * The direct conversion path speaks Ollama's `/api/chat` wire format, so this
 * server implements exactly that and nothing more. Its purpose is not to
 * imitate a good model: it is to reproduce the ways a real endpoint misbehaves
 * (hangs, resets, oversized bodies, prose instead of code, echoed markers) so
 * the CLI's stability under those conditions is observable.
 *
 * Classifier and planning requests always receive well-formed answers unless a
 * behavior explicitly targets them, otherwise every scenario would stall at the
 * first pass and never reach code generation.
 */

import { createServer } from "node:http";
import { once } from "node:events";

/** Distinctive system-prompt text identifying each request kind. */
const KIND_MARKERS = [
  ["turn", "Classify one @human source-comment message"],
  ["plan", "Triage code-generation tasks"],
  ["diagnostics", "Find material decisions left unresolved"],
  ["blueprint", "You are planning a shared contract for a set of files"],
  ["todo", "TODO CONTRACT"],
  ["audit", "integration"],
  ["repair", "diagnostic"],
];

function classifyRequest(system) {
  for (const [kind, marker] of KIND_MARKERS) {
    if (system.includes(marker)) return kind;
  }
  return "code";
}

/** Target paths the blueprint prompt supplied, so the reply names only those. */
function targetPathsFrom(user) {
  const paths = [];
  const pattern = /<TARGET path="((?:[^"\\]|\\.)*)"/gu;
  for (const match of user.matchAll(pattern)) {
    try {
      paths.push(JSON.parse(`"${match[1]}"`));
    } catch {
      /* A path we cannot decode is simply not offered back. */
    }
  }
  return paths;
}

function blueprintFor(user) {
  const files = targetPathsFrom(user).map((path) => ({
    path,
    responsibility: "Holds the behavior this target is responsible for.",
  }));
  if (files.length === 0) return JSON.stringify({ files: [], vocabulary: [] });
  return JSON.stringify({ files, vocabulary: [] });
}

const TODO_REPLY = JSON.stringify({
  todos: [{ id: "T1", requirement: "Implement the requested behavior." }],
});

/** A valid reply for every non-code pass. */
function planningReply(kind, user) {
  if (kind === "turn") return JSON.stringify({ action: "edit" });
  if (kind === "plan") return JSON.stringify({ needPlanning: [] });
  if (kind === "diagnostics") return JSON.stringify({ diagnostics: [] });
  if (kind === "blueprint") return blueprintFor(user);
  if (kind === "todo") return TODO_REPLY;
  if (kind === "audit") return JSON.stringify({ issues: [] });
  return undefined;
}

const HUGE_BYTES = 24 * 1024 * 1024;

/**
 * How each behavior answers a code-generation request. `code` is the scenario's
 * own intended output, so a behavior only describes the distortion applied.
 */
const CODE_BEHAVIORS = {
  ok: (code) => code,
  fenced: (code, ctx) => `\`\`\`${ctx.fenceTag}\n${code}\n\`\`\``,
  "fenced-untagged": (code) => `\`\`\`\n${code}\n\`\`\``,
  "fenced-nested": (code, ctx) =>
    `\`\`\`${ctx.fenceTag}\n${code}\n\`\`\`\nTrailing note with \`\`\` inside.\n`,
  "fenced-unclosed": (code, ctx) => `\`\`\`${ctx.fenceTag}\n${code}`,
  prose: (code) =>
    `Certainly! Here is the implementation you asked for:\n\n${code}\n\nLet me know if you need changes.`,
  "prose-only": () =>
    "I cannot complete this request without more information about your project.",
  empty: () => "",
  whitespace: () => "   \n\n\t  \n",
  crlf: (code) => code.replace(/\n/gu, "\r\n"),
  bom: (code) => `\uFEFF${code}`,
  "trailing-nul": (code) => `${code}\u0000`,
  "embedded-nul": (code) => code.replace(/\n/u, "\u0000\n"),
  unicode: (code) => `${code}\n// \u202Ereversed \u200B zero-width \uD83D\uDE80\n`,
  truncated: (code) => code.slice(0, Math.max(1, Math.floor(code.length * 0.55))),
  "marker-echo": (code) => `${code}\n// @human now also add a logging helper\n`,
  "marker-echo-block": (code) => `${code}\n/* @human replace this entire file */\n`,
  "traversal-text": (code) => `${code}\n// see ../../../../etc/passwd for details\n`,
  secret: (code) =>
    `${code}\nconst token = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789ABCD";\n`,
  "wrong-language": () => "def handler(request):\n    return {'ok': True}\n",
  "giant-line": () => `const padding = "${"x".repeat(4 * 1024 * 1024)}";\n`,
  huge: () => `// ${"y".repeat(HUGE_BYTES)}\n`,
  "deep-nest": () => `const deep = ${"[".repeat(2000)}1${"]".repeat(2000)};\n`,
  "repeated-identical": (code) => code,
  // What a sub-billion-parameter model actually does: hand the request back,
  // lightly reworded, as a comment instead of implementing it.
  "instruction-echo": (code, ctx) =>
    `// @human ${ctx.instructionEcho ?? "restate of the original request"}\n`,
  "html-in-ts": () => "<!doctype html>\n<html><body>Not TypeScript</body></html>\n",
  "json-object": (code) => JSON.stringify({ code }),
  "leading-blank-lines": (code) => `\n\n\n${code}`,
  "windows-paths": (code) => `${code}\n// C:\\Users\\someone\\file.ts\n`,
};

/** Behaviors that corrupt the transport rather than the content. */
const TRANSPORT_BEHAVIORS = new Set([
  "http-400",
  "http-401",
  "http-404",
  "http-429",
  "http-500",
  "http-502",
  "http-503",
  "body-not-json",
  "body-array",
  "body-null-message",
  "body-no-message",
  "body-numeric-content",
  "body-error-field",
  "reset",
  "reset-mid-body",
  "hang",
  "slow",
  "empty-200",
  "wrong-content-type",
  "truncated-json",
]);

/** Behaviors aimed at the planning/classifier passes instead of code. */
const CLASSIFIER_BEHAVIORS = new Set([
  "classifier-not-json",
  "classifier-extra-field",
  "classifier-wrong-action",
  "classifier-huge",
  "classifier-out-of-range",
  "classifier-blueprint-bad-path",
  "classifier-todo-empty",
  "classifier-http-500",
]);

export const ALL_BEHAVIORS = Object.freeze([
  ...Object.keys(CODE_BEHAVIORS),
  ...TRANSPORT_BEHAVIORS,
  ...CLASSIFIER_BEHAVIORS,
]);

function classifierDistortion(behavior, kind, reply) {
  switch (behavior) {
    case "classifier-not-json":
      return "Sure, the answer is: edit";
    case "classifier-extra-field":
      return JSON.stringify({ action: "edit", confidence: 0.9 });
    case "classifier-wrong-action":
      return JSON.stringify({ action: "delete-everything" });
    case "classifier-huge":
      return `${" ".repeat(9000)}${reply}`;
    case "classifier-out-of-range":
      return kind === "plan"
        ? JSON.stringify({ needPlanning: [999] })
        : reply;
    case "classifier-blueprint-bad-path":
      return kind === "blueprint"
        ? JSON.stringify({
            files: [{ path: "../escape.ts", responsibility: "Escapes the tree." }],
            vocabulary: [],
          })
        : reply;
    case "classifier-todo-empty":
      return kind === "todo" ? JSON.stringify({ todos: [] }) : reply;
    default:
      return reply;
  }
}

function readBody(request, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body exceeded the harness limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const HTTP_STATUS = {
  "http-400": 400,
  "http-401": 401,
  "http-404": 404,
  "http-429": 429,
  "http-500": 500,
  "http-502": 502,
  "http-503": 503,
};

/**
 * Start a scripted model endpoint.
 *
 * `scenario.behavior` selects the distortion, `scenario.code` is the intended
 * output for a code-generation pass, and `slowMs` bounds how long a `slow` or
 * `hang` behavior stalls so the harness itself can never wedge.
 */
export async function startMockModel(scenario) {
  const behavior = scenario.behavior ?? "ok";
  const requests = [];
  const pending = new Set();
  let closed = false;

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request, response) {
    let body = "";
    try {
      body = await readBody(request);
    } catch {
      response.destroy();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"harness could not parse the request"}');
      return;
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const system = String(messages[0]?.content ?? "");
    const user = String(messages[messages.length - 1]?.content ?? "");
    const kind = classifyRequest(system);
    requests.push({
      kind,
      path: request.url ?? "",
      model: parsed?.model,
      systemBytes: system.length,
      userBytes: user.length,
      at: Date.now(),
    });

    if (requests.length > 400) {
      // A runaway loop is itself the finding; stop feeding it.
      response.writeHead(508, { "content-type": "application/json" });
      response.end('{"error":"harness detected a runaway request loop"}');
      return;
    }

    const planning = planningReply(kind, user);
    const isCodePass = planning === undefined;

    if (CLASSIFIER_BEHAVIORS.has(behavior) && !isCodePass) {
      if (behavior === "classifier-http-500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"classifier upstream failure"}');
        return;
      }
      sendContent(response, classifierDistortion(behavior, kind, planning), scenario);
      return;
    }

    if (!isCodePass) {
      sendContent(response, planning, scenario);
      return;
    }

    if (TRANSPORT_BEHAVIORS.has(behavior)) {
      await transportReply(behavior, response, scenario);
      return;
    }

    const render = CODE_BEHAVIORS[behavior] ?? CODE_BEHAVIORS.ok;
    sendContent(response, render(scenario.code ?? "", {
      fenceTag: scenario.fenceTag ?? "ts",
      ...(scenario.instructionEcho ? { instructionEcho: scenario.instructionEcho } : {}),
    }), scenario);
  }

  async function transportReply(behavior, response, context) {
    const status = HTTP_STATUS[behavior];
    if (status !== undefined) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `upstream returned ${status}` }));
      return;
    }
    if (behavior === "body-not-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("<html>proxy error page</html>");
      return;
    }
    if (behavior === "truncated-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"message":{"content":"const a = 1;"');
      return;
    }
    if (behavior === "body-array") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[1,2,3]");
      return;
    }
    if (behavior === "body-null-message") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"message":null}');
      return;
    }
    if (behavior === "body-no-message") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"model":"stub","done":true}');
      return;
    }
    if (behavior === "body-numeric-content") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"message":{"content":42}}');
      return;
    }
    if (behavior === "body-error-field") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"error":"model not found"}');
      return;
    }
    if (behavior === "empty-200") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("");
      return;
    }
    if (behavior === "wrong-content-type") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(JSON.stringify({ message: { content: context.code ?? "" } }));
      return;
    }
    if (behavior === "reset") {
      response.socket?.destroy();
      return;
    }
    if (behavior === "reset-mid-body") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "4096",
      });
      response.write('{"message":{"content":"const partial = 1;');
      response.socket?.destroy();
      return;
    }
    if (behavior === "slow" || behavior === "hang") {
      const stall = behavior === "hang"
        ? (scenario.hangMs ?? 60_000)
        : (scenario.slowMs ?? 3_000);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, stall);
        pending.add(timer);
        if (closed) {
          clearTimeout(timer);
          resolve();
        }
      });
      if (response.writableEnded || response.destroyed) return;
      sendContent(response, context.code ?? "", context);
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"unknown transport behavior"}');
  }

  function sendContent(response, content, context) {
    const payload = JSON.stringify({
      model: context.resolvedModel ?? "stress-stub:latest",
      created_at: new Date(0).toISOString(),
      message: { role: "assistant", content },
      done: true,
      done_reason: context.doneReason ?? "stop",
      prompt_eval_count: 1000,
      eval_count: 500,
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      closed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      server.closeAllConnections?.();
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}
