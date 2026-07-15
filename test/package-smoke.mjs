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

  const entry = join(
    installRoot,
    "node_modules",
    "human-to-code",
    "dist",
    "index.js",
  );
  const exported = await import(pathToFileURL(entry).href);
  assert.equal(typeof exported.loadConfig, "function");

  const cli = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "human-to-code.cmd" : "human-to-code",
  );
  const help = execFileSync(cli, ["--help"], { encoding: "utf8" });
  assert.match(help, /human-to-code/);

  // Exercise the actual installed package through the documented npx entry.
  // The review gate exits before provider or sandbox access, keeping this smoke
  // test deterministic, offline, and representative of `npx human-to-code .`.
  const guidedRoot = join(installRoot, "guided-project");
  mkdirSync(join(guidedRoot, "src"), { recursive: true });
  writeFileSync(join(guidedRoot, "package.json"), JSON.stringify({
    name: "installed-guided-smoke",
    dependencies: { react: "18.3.1", vite: "6.1.0" },
    scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
  }));
  writeFileSync(join(guidedRoot, "src", "main.tsx"), "export function App() { return null; }\n");
  writeFileSync(join(guidedRoot, "feature.human"), "Add a status component.\n");
  const guided = spawnSync(
    npx,
    ["--no-install", "human-to-code", guidedRoot, "--json"],
    {
      cwd: installRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_offline: "true" },
    },
  );
  assert.equal(guided.status, 3, guided.stderr || guided.stdout);
  const guidedOutcome = JSON.parse(guided.stdout);
  assert.equal(guidedOutcome.status, "NEEDS_INPUT");
  assert.equal(
    guidedOutcome.contract,
    join(guidedRoot, "feature.strict.human.json"),
  );
  assert.equal(existsSync(guidedOutcome.contract), true);
} finally {
  rmSync(installRoot, { recursive: true, force: true });
  try {
    unlinkSync(tarball);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
