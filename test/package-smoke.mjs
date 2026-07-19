import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryPackage = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const packed = JSON.parse(
  execFileSync(npm, ["pack", "--json", "--ignore-scripts"], {
    cwd: projectRoot,
    encoding: "utf8",
  }),
);
assert.equal(packed.length, 1);

const tarball = join(projectRoot, packed[0].filename);
const installRoot = mkdtempSync(join(tmpdir(), "human-to-code-package-"));

try {
  execFileSync(npm, ["install", "--ignore-scripts", tarball], {
    cwd: installRoot,
    stdio: "pipe",
  });

  const installedPackage = JSON.parse(
    readFileSync(
      join(installRoot, "node_modules", "human-to-code", "package.json"),
      "utf8",
    ),
  );
  assert.equal(installedPackage.bin["human-to-code"], "./dist/cli.js");
  assert.equal(
    installedPackage.version,
    repositoryPackage.version,
    "The packed package version must match the repository manifest.",
  );

  // The staged JS/TS project validation path needs the TypeScript compiler and
  // bundled node builtin typings at runtime in a clean install.
  assert.equal(typeof installedPackage.dependencies.typescript, "string");
  assert.equal(typeof installedPackage.dependencies["@types/node"], "string");
  assert.ok(existsSync(join(installRoot, "node_modules", "typescript", "package.json")));
  assert.ok(existsSync(join(installRoot, "node_modules", "@types", "node", "package.json")));

  const entry = join(
    installRoot,
    "node_modules",
    "human-to-code",
    "dist",
    "index.js",
  );
  const exported = await import(pathToFileURL(entry).href);
  assert.equal(typeof exported.loadConfig, "function");
  assert.equal(typeof exported.validateCandidateProject, "function");
  assert.equal(typeof exported.buildCandidateOverlay, "function");
  assert.equal(typeof exported.buildProjectMemory, "function");
  assert.equal(typeof exported.reconcileGeneratedIntegrations, "function");
  assert.equal(typeof exported.compactFileContract, "function");
  assert.equal(typeof exported.discoverHumanInstructionSources, "function");
  assert.equal(typeof exported.generateGuidedCodeChangeRun, "function");
  assert.equal(exported.discover, exported.discoverHumanInstructionSources);
  assert.equal(exported.generateRun, exported.generateGuidedCodeChangeRun);

  const cli = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "human-to-code.cmd" : "human-to-code",
  );
  const help = execFileSync(cli, ["--help"], { encoding: "utf8" });
  assert.match(help, /human-to-code/);

  // Exercise the installed package through the documented npx entry. The default
  // flow is the simple .human -> code converter; without -y it prints an offline
  // plan (no provider contact), keeping this smoke deterministic.
  const guidedRoot = join(installRoot, "guided-project");
  mkdirSync(join(guidedRoot, "src"), { recursive: true });
  writeFileSync(join(guidedRoot, "package.json"), JSON.stringify({
    name: "installed-guided-smoke",
    dependencies: { react: "18.3.1", vite: "6.1.0" },
    scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
  }));
  writeFileSync(join(guidedRoot, "src", "main.tsx"), "export function App() { return null; }\n");
  writeFileSync(join(guidedRoot, "feature.human"), "Add a status component.\n");

  const converted = spawnSync(
    npx,
    ["--no-install", "human-to-code", guidedRoot, "--json"],
    { cwd: installRoot, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
  );
  assert.equal(converted.status, 3, converted.stderr || converted.stdout);
  const plan = JSON.parse(converted.stdout);
  assert.equal(plan.status, "NEEDS_CONFIRMATION");
  assert.equal(plan.provider, "ollama");
  assert.equal(plan.requests, 1);
  assert.deepEqual(plan.units, [{
    kind: "file",
    source: "feature.human",
    output: "feature.ts",
    language: "typescript",
  }]);

  // A packed install must retain per-file language inference; testing only the
  // source CLI would miss a stale or incomplete dist build.
  const mixedRoot = join(installRoot, "mixed-language-project");
  mkdirSync(mixedRoot, { recursive: true });
  writeFileSync(join(mixedRoot, "human-to-code.config.json"), JSON.stringify({
    schemaVersion: 1,
    languages: ["typescript", "html", "css", "javascript"],
    provider: { name: "ollama", model: "fixture-model" },
  }));
  writeFileSync(
    join(mixedRoot, "index.human"),
    "html\nadd head section here\nadd styles\nclose head\nadd body\n",
  );
  writeFileSync(
    join(mixedRoot, "script.human"),
    "javascript\nRead stylesheet colors and update them on clicks. Do not emit TypeScript syntax.\n",
  );
  writeFileSync(join(mixedRoot, "styles.human"), "Build the calculator styles in CSS.\n");
  const mixed = spawnSync(
    npx,
    ["--no-install", "human-to-code", mixedRoot, "--dry-run"],
    { cwd: installRoot, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
  );
  assert.equal(mixed.status, 0, mixed.stderr || mixed.stdout);
  assert.match(mixed.stdout, /Languages: HTML \(\.html\), JavaScript \(\.js\), CSS \(\.css\)/u);
  assert.doesNotMatch(mixed.stdout, /TypeScript \(\.ts\)/u);
  assert.match(mixed.stdout, /index\.human\s+->\s+index\.html/u);
  assert.match(mixed.stdout, /script\.human\s+->\s+script\.js/u);
  assert.match(mixed.stdout, /styles\.human\s+->\s+styles\.css/u);

  const inlineRoot = join(installRoot, "inline-html-project");
  mkdirSync(inlineRoot, { recursive: true });
  writeFileSync(join(inlineRoot, "page.html"), [
    "<!-- @human add a heading -->",
    "<!--",
    "  @human add the main content",
    "-->",
    "",
  ].join("\n"));
  writeFileSync(join(inlineRoot, "styles.css"), "/* @human add page colors */\n");
  const inline = spawnSync(
    npx,
    ["--no-install", "human-to-code", inlineRoot, "--json"],
    { cwd: installRoot, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
  );
  assert.equal(inline.status, 3, inline.stderr || inline.stdout);
  const inlinePlan = JSON.parse(inline.stdout);
  assert.deepEqual(inlinePlan.notices, []);
  assert.deepEqual(inlinePlan.units, [
    { kind: "inline", source: "page.html", output: "page.html", language: "html" },
    { kind: "inline", source: "page.html", output: "page.html", language: "html" },
    { kind: "inline", source: "styles.css", output: "styles.css", language: "css" },
  ]);

  // The reviewed/validated pipeline is still available under `guided`.
  const guided = spawnSync(
    npx,
    ["--no-install", "human-to-code", "guided", guidedRoot, "--json"],
    { cwd: installRoot, encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
  );
  assert.equal(guided.status, 3, guided.stderr || guided.stdout);
  const guidedOutcome = JSON.parse(guided.stdout);
  assert.equal(guidedOutcome.status, "NEEDS_INPUT");
  assert.equal(guidedOutcome.contract, join(guidedRoot, "feature.strict.human.json"));
  assert.equal(existsSync(guidedOutcome.contract), true);
} finally {
  rmSync(installRoot, { recursive: true, force: true });
  try {
    unlinkSync(tarball);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
