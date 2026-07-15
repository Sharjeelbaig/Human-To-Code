import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateConfig,
  loadConfig,
  ConfigError,
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
} from "../src/config.ts";

test("validateConfig fills defaults from an empty object", () => {
  const c = validateConfig({});
  assert.equal(c.language, "typescript");
  assert.equal(c.provider.name, "anthropic");
  assert.equal(c.provider.model, "claude-opus-4-8");
  assert.equal(c.allowNonHumanFiles, false);
});

test("validateConfig accepts a valid language", () => {
  assert.equal(validateConfig({ language: "python" }).language, "python");
});

test("validateConfig rejects an unknown language", () => {
  assert.throws(() => validateConfig({ language: "rust" }), ConfigError);
});

test("provider model defaults per provider", () => {
  const c = validateConfig({ provider: { name: "openai" } });
  assert.equal(c.provider.model, "gpt-4o");
});

test("validateConfig rejects an unknown provider", () => {
  assert.throws(
    () => validateConfig({ provider: { name: "cohere" } }),
    ConfigError,
  );
});

test("baseUrl must be https", () => {
  assert.throws(
    () =>
      validateConfig({
        provider: { name: "ollama", baseUrl: "http://ollama.com" },
      }),
    ConfigError,
  );
  const ok = validateConfig({
    provider: { name: "ollama", baseUrl: "https://ollama.com" },
  });
  assert.equal(ok.provider.baseUrl, "https://ollama.com");
});

test("validateConfig rejects non-object root", () => {
  assert.throws(() => validateConfig([]), ConfigError);
  assert.throws(() => validateConfig("nope"), ConfigError);
});

test("loadConfig returns defaults when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  try {
    const { config, fromFile } = await loadConfig(dir);
    assert.equal(fromFile, false);
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads and validates a config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  try {
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ language: "javascript", provider: { name: "gemini" } }),
    );
    const { config, fromFile } = await loadConfig(dir);
    assert.equal(fromFile, true);
    assert.equal(config.language, "javascript");
    assert.equal(config.provider.name, "gemini");
    assert.equal(config.provider.model, "gemini-2.5-pro");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig surfaces invalid JSON as ConfigError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  try {
    await writeFile(join(dir, CONFIG_FILENAME), "{ not json ");
    await assert.rejects(() => loadConfig(dir), ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
