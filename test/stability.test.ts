import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyUnit,
  discoverUnits,
  generateCode,
  validateGeneratedUnit,
  type ConversionUnit,
} from "../src/index.ts";

/**
 * A minimal Ollama-shaped endpoint. `reply` receives the parsed request so a
 * test can answer the classification pass and the coding pass differently.
 */
async function startEndpoint(
  reply: (body: { messages: Array<{ content: string }> }) => {
    status?: number;
    payload?: unknown;
    stallMs?: number;
  },
): Promise<{ baseUrl: string; close: () => Promise<void>; server: Server }> {
  const timers: NodeJS.Timeout[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      const parsed = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const answer = reply(parsed);
      const send = (): void => {
        if (response.writableEnded) return;
        response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.payload ?? {}));
      };
      if (answer.stallMs === undefined) send();
      else timers.push(setTimeout(send, answer.stallMs));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function contentPayload(content: unknown): unknown {
  return {
    model: "stub",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 1,
    eval_count: 1,
  };
}

async function unitFor(source: string, name = "target.ts"): Promise<ConversionUnit> {
  const root = await mkdtemp(join(tmpdir(), "h2c-stability-"));
  await writeFile(join(root, name), source, "utf8");
  const units = await discoverUnits(root, "typescript");
  const unit = units[0];
  if (unit === undefined) throw new Error("fixture produced no conversion unit");
  return unit;
}

test("a provider that stalls forever is abandoned at the configured request budget", async () => {
  const endpoint = await startEndpoint(() => ({
    payload: contentPayload("export const late = 1;\n"),
    stallMs: 30_000,
  }));
  try {
    const started = Date.now();
    await assert.rejects(
      generateCode("add a constant", {
        language: "typescript",
        provider: "ollama",
        model: "stub",
        baseUrl: endpoint.baseUrl,
        timeoutMs: 1_000,
      }),
      /exceeded the 1000ms budget/u,
    );
    // The point is that it returns at all; the bound is what makes it return.
    assert.ok(Date.now() - started < 15_000, "the request was not abandoned near its budget");
  } finally {
    await endpoint.close();
  }
});

test("provider content that is not text is refused instead of throwing a TypeError", async () => {
  for (const content of [42, { code: "x" }, ["x"], true]) {
    const endpoint = await startEndpoint(() => ({ payload: contentPayload(content) }));
    try {
      await assert.rejects(
        generateCode("add a constant", {
          language: "typescript",
          provider: "ollama",
          model: "stub",
          baseUrl: endpoint.baseUrl,
          timeoutMs: 5_000,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /assistant content of type/u);
          assert.doesNotMatch(error.message, /is not a function/u);
          return true;
        },
      );
    } finally {
      await endpoint.close();
    }
  }
});

test("a provider error field is reported as the provider's error, not as missing code", async () => {
  const endpoint = await startEndpoint(() => ({
    payload: { error: "model 'absent' not found, try pulling it first" },
  }));
  try {
    await assert.rejects(
      generateCode("add a constant", {
        language: "typescript",
        provider: "ollama",
        model: "stub",
        baseUrl: endpoint.baseUrl,
        timeoutMs: 5_000,
      }),
      /reported an error: model 'absent' not found/u,
    );
  } finally {
    await endpoint.close();
  }
});

test("generated code carrying a live @human marker is refused before any write", async () => {
  const unit = await unitFor("// @human add a greeter\n");
  await assert.rejects(
    validateGeneratedUnit(
      unit,
      "export const greet = () => \"hi\";\n// @human now add logging too\n",
    ),
    /contains a live @human marker/u,
  );
});

test("a model restating the instruction is diagnosed as that, not as a stray marker", async () => {
  const unit = await unitFor("// @human add the parameters x and y with number types\n");
  await assert.rejects(
    // What a sub-billion-parameter model actually returns: the request, reworded.
    validateGeneratedUnit(unit, "// @human add the parameters that are x and y with number types\n"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /restated the instruction as an @human comment/u);
      assert.match(error.message, /too small for code generation/u);
      return true;
    },
  );
});

test("a genuinely new instruction in generated code keeps the stray-marker wording", async () => {
  const unit = await unitFor("// @human add a greeter\n");
  await assert.rejects(
    validateGeneratedUnit(
      unit,
      "export const greet = () => \"hi\";\n// @human now wire up the database connection pool\n",
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /contains a live @human marker/u);
      assert.doesNotMatch(error.message, /restated the instruction/u);
      return true;
    },
  );
});

test("marker-shaped text discovery would ignore is still allowed in generated code", async () => {
  const unit = await unitFor("// @human add a help string\n");
  // Inside a string literal, so a later run's lexical scan never sees a marker.
  await validateGeneratedUnit(
    unit,
    'export const help = "write // @human to convert";\n',
  );
});

test("a markdown target may legitimately document the marker syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-stability-md-"));
  await writeFile(join(root, "guide.md.human"), "explain the marker syntax\n", "utf8");
  const units = await discoverUnits(root, "markdown");
  const unit = units[0];
  assert.ok(unit, "the markdown fixture produced no unit");
  await validateGeneratedUnit(unit, "# Guide\n\nWrite `// @human add a helper` in any file.\n");
});

test("replacing an inline marker preserves the file mode and leaves no temporary behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-stability-mode-"));
  const target = join(root, "source.ts");
  await writeFile(target, "const before = 1;\n// @human add a constant named after\n", "utf8");
  await chmod(target, 0o640);
  const units = await discoverUnits(root, "typescript");
  const unit = units[0];
  assert.ok(unit, "the fixture produced no unit");

  await applyUnit(root, unit, "export const after = 2;\n");

  const written = await readFile(target, "utf8");
  assert.match(written, /export const after = 2;/u);
  assert.doesNotMatch(written, /@human/u);
  assert.equal((await stat(target)).mode & 0o777, 0o640);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".tmp")),
    [],
    "an atomic replacement left its temporary file behind",
  );
});

test("a failed inline replacement leaves the original source byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-stability-rollback-"));
  const target = join(root, "source.ts");
  const original = "const before = 1;\n// @human add a constant\n";
  await writeFile(target, original, "utf8");
  const units = await discoverUnits(root, "typescript");
  const unit = units[0];
  assert.ok(unit, "the fixture produced no unit");

  // Rewrite the file so the recorded marker range no longer matches: the stale
  // check must refuse, and refusing must not modify anything.
  await writeFile(target, "const shifted = 0;\nconst other = 2;\n", "utf8");
  await assert.rejects(applyUnit(root, unit, "export const after = 2;\n"));
  assert.equal(await readFile(target, "utf8"), "const shifted = 0;\nconst other = 2;\n");
});
