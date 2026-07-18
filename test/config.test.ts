import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_FILENAME,
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DEFAULT_CONFIG,
  defaultConfigJson,
  loadConfig,
  migrateLegacyConfig,
  validateConfig,
} from "../src/config/config.ts";

const V1 = { schemaVersion: CONFIG_SCHEMA_VERSION } as const;

test("validateConfig fills v1 defaults", () => {
  const config = validateConfig(V1);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.language, "typescript");
  assert.deepEqual(config.humanFileExtensions, []);
  assert.equal(config.provider.name, "ollama");
  assert.equal(config.provider.model, "qwen2.5-coder:7b");
  assert.equal(config.allowNonHumanFiles, false);
  assert.equal(config.sandbox.required, true);
  assert.equal(config.sandbox.network, "none");
  assert.equal(config.privacy.remoteProviderConsent, false);
  assert.equal(config.budgets.maxRepairs, 2);
});

test("schema version is mandatory and unsupported versions fail", () => {
  assert.throws(() => validateConfig({}), /migrate-config/);
  assert.throws(() => validateConfig({ schemaVersion: 2 }), /Unsupported/);
});

test("schema v1 cannot disable strong sandbox validation", () => {
  assert.throws(
    () => validateConfig({ ...V1, sandbox: { required: false } }),
    /must be true/u,
  );
});

test("defaults are deeply frozen and every result is deeply cloned", () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.provider), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.filesToIgnore), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.humanFileExtensions), true);

  const first = validateConfig(V1);
  const second = validateConfig(V1);
  first.provider.model = "changed";
  first.filesToIgnore.push("custom");
  first.privacy.excludedPaths.push("private");
  assert.equal(second.provider.model, "qwen2.5-coder:7b");
  assert.ok(!second.filesToIgnore.includes("custom"));
  assert.deepEqual(second.privacy.excludedPaths, []);
});

test("validateConfig accepts known legacy-compatible fields", () => {
  const config = validateConfig({
    ...V1,
    language: "python",
    filesToIgnore: ["vendor"],
    allowNonHumanFiles: true,
    provider: { name: "openai", model: "pinned-model" },
  });
  assert.equal(config.language, "python");
  assert.deepEqual(config.filesToIgnore, ["vendor"]);
  assert.equal(config.allowNonHumanFiles, true);
  assert.equal(config.provider.model, "pinned-model");
});

test("languages accepts multiple targets and drives the primary language", () => {
  const config = validateConfig({ ...V1, languages: ["html", "css", "typescript"] });
  assert.deepEqual(config.languages, ["html", "css", "typescript"]);
  assert.equal(config.language, "html");
});

test("a lone legacy language becomes the languages list", () => {
  const config = validateConfig({ ...V1, language: "python" });
  assert.deepEqual(config.languages, ["python"]);
});

test("language must be a member of languages when both are set", () => {
  const config = validateConfig({ ...V1, language: "css", languages: ["html", "css"] });
  assert.equal(config.language, "css");
  assert.deepEqual(config.languages, ["css", "html"]);
  assert.throws(
    () => validateConfig({ ...V1, language: "python", languages: ["html"] }),
    ConfigError,
  );
});

test("languages rejects empty lists, unknown entries, and duplicates", () => {
  assert.throws(() => validateConfig({ ...V1, languages: [] }), ConfigError);
  assert.throws(() => validateConfig({ ...V1, languages: ["cobol"] }), ConfigError);
  assert.throws(() => validateConfig({ ...V1, languages: ["html", "html"] }), ConfigError);
});

test("humanFileExtensions validates exact .human paths and enabled extensions", () => {
  const config = validateConfig({
    ...V1,
    languages: ["typescript", "javascript", "html"],
    humanFileExtensions: [
      { path: "index.human", extension: ".html" },
      { path: "src/script.human", extension: "mjs" },
    ],
  });
  assert.deepEqual(config.humanFileExtensions, [
    { path: "index.human", extension: "html" },
    { path: "src/script.human", extension: "mjs" },
  ]);

  const invalidMappings = [
    [{ path: "../script.human", extension: "js" }],
    [{ path: "/script.human", extension: "js" }],
    [{ path: "script.ts", extension: "js" }],
    [{ path: "script.strict.human", extension: "js" }],
    [{ path: "script.human", extension: "exe" }],
    [{ path: "script.human", extension: "js", typo: true }],
  ];
  for (const humanFileExtensions of invalidMappings) {
    assert.throws(
      () => validateConfig({ ...V1, languages: ["typescript", "javascript"], humanFileExtensions }),
      ConfigError,
    );
  }
  assert.throws(
    () => validateConfig({
      ...V1,
      languages: ["typescript"],
      humanFileExtensions: [{ path: "script.human", extension: "js" }],
    }),
    /must be listed in `languages`/u,
  );
  assert.throws(
    () => validateConfig({
      ...V1,
      languages: ["javascript"],
      humanFileExtensions: [
        { path: "script.human", extension: "js" },
        { path: "script.human", extension: "mjs" },
      ],
    }),
    /duplicate paths/u,
  );
});

test("provider model defaults per provider", () => {
  const config = validateConfig({ ...V1, provider: { name: "openai" } });
  assert.equal(config.provider.model, "gpt-4o");
});

test("unknown root and nested fields are rejected", () => {
  assert.throws(
    () => validateConfig({ ...V1, languge: "python" }),
    /Unknown configuration field `languge`/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: { name: "openai", typo: true },
      }),
    /provider\.typo/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        workspaces: [{ root: "apps/web", privacy: { telemtry: true } }],
      }),
    /telemtry/,
  );
});

test("credential-like fields are rejected at every nesting level", () => {
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: { name: "openai", apiKey: "not-allowed" },
      }),
    /Credential-like field `provider\.apiKey`/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        workspaces: [{ root: ".", provider: { name: "openai", clientSecret: "x" } }],
      }),
    /Credential-like/,
  );
});

test("apiKeyEnv accepts only an environment-variable name", () => {
  const config = validateConfig({
    ...V1,
    provider: { name: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  });
  assert.equal(config.provider.apiKeyEnv, "OPENAI_API_KEY");
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: { name: "openai", apiKeyEnv: "sk-secret-value" },
      }),
    /environment-variable name/,
  );
});

test("remote pricing upper bounds are strict model configuration, never credentials", () => {
  const config = validateConfig({
    ...V1,
    provider: {
      name: "openai",
      model: "reviewed-model",
      pricing: {
        inputUsdPerMillionTokens: 12.5,
        outputUsdPerMillionTokens: 50,
      },
    },
  });
  assert.deepEqual(config.provider.pricing, {
    inputUsdPerMillionTokens: 12.5,
    outputUsdPerMillionTokens: 50,
  });
  assert.throws(
    () => validateConfig({
      ...V1,
      provider: {
        name: "openai",
        pricing: { inputUsdPerMillionTokens: 1 },
      },
    }),
    /outputUsdPerMillionTokens/u,
  );
  assert.throws(
    () => validateConfig({
      ...V1,
      provider: {
        name: "openai",
        pricing: {
          inputUsdPerMillionTokens: -1,
          outputUsdPerMillionTokens: 1,
        },
      },
    }),
    /between 0/u,
  );
  assert.throws(() => validateConfig({
    ...V1,
    provider: {
      name: "openai",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
  }), /unmetered/u);
  const unmetered = validateConfig({
    ...V1,
    provider: {
      name: "openai",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
        unmetered: true,
      },
    },
  });
  assert.equal(unmetered.provider.pricing?.unmetered, true);
});

test("custom HTTPS endpoints require explicit trust and reject unsafe URL forms", () => {
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: { name: "openai", baseUrl: "https://models.example.com" },
      }),
    /trustCustomEndpoint/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: {
          name: "openai",
          baseUrl: "https://user:pass@models.example.com",
          trustCustomEndpoint: true,
        },
      }),
    /credentials/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: {
          name: "openai",
          baseUrl: "https://192.168.1.5/v1",
          trustCustomEndpoint: true,
        },
      }),
    /private network/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: {
          name: "openai",
          baseUrl: "https://models.example.com/v1?key=x",
          trustCustomEndpoint: true,
        },
      }),
    /query or fragment/,
  );

  const config = validateConfig({
    ...V1,
    provider: {
      name: "openai",
      baseUrl: "https://models.example.com/v1",
      trustCustomEndpoint: true,
      apiKeyEnv: "PRIVATE_PROVIDER_KEY",
    },
  });
  assert.equal(config.provider.baseUrl, "https://models.example.com/v1");
  assert.equal(config.provider.apiKeyEnv, "PRIVATE_PROVIDER_KEY");
});

test("plain HTTP is restricted to unauthenticated Ollama loopback", () => {
  const config = validateConfig({
    ...V1,
    provider: {
      name: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      trustCustomEndpoint: true,
    },
  });
  assert.equal(config.provider.baseUrl, "http://127.0.0.1:11434");
  assert.equal(config.provider.apiKeyEnv, undefined);

  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: {
          name: "ollama",
          baseUrl: "http://localhost:11434",
          trustCustomEndpoint: true,
          apiKeyEnv: "OLLAMA_API_KEY",
        },
      }),
    /not allowed for a local HTTP/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        provider: {
          name: "ollama",
          baseUrl: "http://10.0.0.3:11434",
          trustCustomEndpoint: true,
        },
      }),
    /Plain HTTP/,
  );
});

test("official Ollama Cloud endpoint defaults only its env variable name", () => {
  const config = validateConfig({
    ...V1,
    provider: {
      name: "ollama",
      baseUrl: "https://ollama.com/api",
      trustCustomEndpoint: true,
    },
  });
  assert.equal(config.provider.apiKeyEnv, "OLLAMA_API_KEY");
});

test("workspace and policy configuration is bounded and path-safe", () => {
  const config = validateConfig({
    ...V1,
    workspaces: [
      {
        root: "apps/web",
        documentation: { privatePaths: ["docs/react"] },
        privacy: { maxContextTokens: 32_000 },
        budgets: { maxRepairs: 1 },
      },
    ],
  });
  assert.equal(config.workspaces[0]?.root, "apps/web");
  assert.deepEqual(config.workspaces[0]?.documentation?.privatePaths, ["docs/react"]);
  assert.equal(config.workspaces[0]?.budgets?.maxRepairs, 1);

  assert.throws(
    () => validateConfig({ ...V1, workspaces: [{ root: "../outside" }] }),
    /parent segments/,
  );
  assert.throws(
    () => validateConfig({ ...V1, filesToIgnore: ["src/generated"] }),
    /name, not a path/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...V1,
        workspaces: [{ root: "apps/web" }, { root: "apps/web" }],
      }),
    /duplicate roots/,
  );
  assert.throws(
    () => validateConfig({ ...V1, budgets: { maxRepairs: 3 } }),
    /between 0 and 2/,
  );
});

test("official documentation mappings are exact, bounded, and version-specific", () => {
  const config = validateConfig({
    ...V1,
    documentation: {
      officialDomains: ["docs.example.com"],
      officialSources: [{
        ecosystem: "fastapi",
        dependency: "pydantic",
        version: "2.11.7",
        url: "https://docs.example.com/pydantic/2.11.7/",
      }],
    },
  });
  assert.equal(config.documentation.officialSources[0]?.version, "2.11.7");
  assert.throws(() => validateConfig({
    ...V1,
    documentation: {
      officialSources: [{
        ecosystem: "fastapi",
        dependency: "pydantic",
        version: "latest",
        url: "https://docs.example.com/pydantic/latest/",
      }],
    },
  }), /exact version identifier/u);
  assert.throws(() => validateConfig({
    ...V1,
    documentation: {
      officialSources: [{
        ecosystem: "fastapi",
        dependency: "pydantic",
        version: "2.11.7",
        url: "http://docs.example.com/pydantic/2.11.7/",
      }],
    },
  }), /credential-free HTTPS/u);
  assert.throws(() => validateConfig({
    ...V1,
    documentation: {
      officialSources: [
        { ecosystem: "react", dependency: "react", version: "19.1.0", url: "https://react.dev/19.1.0/reference/react/" },
        { ecosystem: "react", dependency: "react", version: "19.1.0", url: "https://react.dev/19.1.0/learn/" },
      ],
    },
  }), /duplicate/u);
});

test("migrateLegacyConfig performs an explicit strict upgrade", () => {
  const config = migrateLegacyConfig({
    language: "javascript",
    provider: { name: "gemini" },
  });
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.language, "javascript");
  assert.equal(config.provider.model, "gemini-2.5-pro");
  assert.throws(() => migrateLegacyConfig({ oldMysteryField: true }), /Unknown/);
});

test("loadConfig returns a fresh default when no file exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  try {
    const first = await loadConfig(directory);
    const second = await loadConfig(directory);
    assert.equal(first.fromFile, false);
    assert.deepEqual(first.config, DEFAULT_CONFIG);
    first.config.filesToIgnore.push("changed");
    assert.ok(!second.config.filesToIgnore.includes("changed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadConfig reads a schema-v1 file and rejects legacy JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  try {
    await writeFile(
      join(directory, CONFIG_FILENAME),
      JSON.stringify({ ...V1, language: "javascript", provider: { name: "gemini" } }),
    );
    const loaded = await loadConfig(directory);
    assert.equal(loaded.fromFile, true);
    assert.equal(loaded.config.language, "javascript");
    assert.equal(loaded.config.provider.model, "gemini-2.5-pro");

    await writeFile(join(directory, CONFIG_FILENAME), "{}");
    await assert.rejects(() => loadConfig(directory), /migrate-config/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid JSON and symlinked config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h2c-cfg-"));
  const outside = join(directory, "outside.json");
  try {
    await writeFile(join(directory, CONFIG_FILENAME), "{ not json ");
    await assert.rejects(() => loadConfig(directory), ConfigError);
    await rm(join(directory, CONFIG_FILENAME));

    await writeFile(outside, defaultConfigJson());
    await symlink(outside, join(directory, CONFIG_FILENAME));
    await assert.rejects(() => loadConfig(directory), /non-symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
