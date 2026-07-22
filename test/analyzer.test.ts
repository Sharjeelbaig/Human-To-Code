import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeProject } from "../src/tools/analysis/analyzer.ts";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "h2c-analyzer-"));
}

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents);
}

test("analyzeProject profiles a mixed React, NestJS, FastAPI, and Cargo monorepo", async () => {
  const root = await fixture();
  try {
    await put(
      root,
      "package.json",
      JSON.stringify({ name: "mixed", private: true, workspaces: ["apps/*"] }),
    );
    await put(
      root,
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "mixed" },
          "node_modules/react": { version: "18.3.1" },
          "node_modules/react-dom": { version: "18.3.1" },
          "node_modules/vite": { version: "6.1.0" },
          "node_modules/@nestjs/core": { version: "11.0.6" },
          "node_modules/@nestjs/common": { version: "11.0.6" },
          "node_modules/@nestjs/platform-fastify": { version: "11.0.6" },
          "node_modules/@prisma/client": { version: "6.3.0" },
        },
      }),
    );
    await put(
      root,
      "apps/web/package.json",
      JSON.stringify({
        name: "@mixed/web",
        dependencies: { react: "^18.3.0", "react-dom": "^18.3.0", vite: "^6.0.0" },
        devDependencies: { typescript: "5.7.3", vitest: "2.1.8" },
        scripts: { lint: "eslint .", typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" },
      }),
    );
    await put(
      root,
      "apps/web/tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    );
    await put(
      root,
      "apps/web/src/main.tsx",
      "import React from 'react'; export const routes = [{ path: '/dashboard' }];\n",
    );
    await put(
      root,
      "apps/api/package.json",
      JSON.stringify({
        name: "@mixed/api",
        dependencies: {
          "@nestjs/core": "^11.0.0",
          "@nestjs/common": "^11.0.0",
          "@nestjs/platform-fastify": "^11.0.0",
          "@prisma/client": "^6.0.0",
          "class-validator": "^0.14.0",
        },
        scripts: { lint: "eslint .", build: "nest build", test: "jest", "test:e2e": "jest --config test/e2e.json" },
      }),
    );
    await put(
      root,
      "apps/api/src/users.module.ts",
      "@Module({ imports: [AuthModule.forRoot()], controllers: [UsersController], providers: [UsersService], exports: [UsersService] }) export class UsersModule {}\n",
    );
    await put(
      root,
      "apps/api/src/users.controller.ts",
      "@Controller('users') @UseGuards(AuthGuard) export class UsersController { @Get(':id') get() {} }\n",
    );
    await put(root, "apps/api/src/main.ts", "app.useGlobalPipes(new ValidationPipe());\n");

    await put(
      root,
      "services/search/pyproject.toml",
      `[project]\nname = "search"\nversion = "1.0.0"\nrequires-python = ">=3.11"\ndependencies = ["fastapi==0.115.8", "pydantic==2.10.6", "sqlalchemy==2.0.38", "pytest==8.3.4", "ruff==0.9.6"]\n\n[tool.uv]\npackage = true\n`,
    );
    await put(
      root,
      "services/search/uv.lock",
      `version = 1\n\n[[package]]\nname = "fastapi"\nversion = "0.115.8"\n\n[[package]]\nname = "pydantic"\nversion = "2.10.6"\n\n[[package]]\nname = "sqlalchemy"\nversion = "2.0.38"\n`,
    );
    await put(
      root,
      "services/search/app/main.py",
      "from fastapi import Depends, FastAPI\napp = FastAPI()\n@app.get('/health')\nasync def health(user=Depends(current_user)):\n    return {'ok': True}\n",
    );
    await put(root, "services/search/tests/test_health.py", "def test_health():\n    assert True\n");

    await put(
      root,
      "native/Cargo.toml",
      `[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n\n[workspace.package]\nedition = "2021"\nrust-version = "1.82"\n`,
    );
    await put(
      root,
      "native/crates/core/Cargo.toml",
      `[package]\nname = "core-lib"\nversion = "0.1.0"\nedition.workspace = true\nrust-version.workspace = true\n\n[features]\ndefault = []\ntls = []\n\n[dependencies]\ntokio = { version = "1.43.0", features = ["rt"] }\nthiserror = "2.0.11"\n`,
    );
    await put(
      root,
      "native/Cargo.lock",
      `version = 4\n\n[[package]]\nname = "tokio"\nversion = "1.43.0"\n\n[[package]]\nname = "thiserror"\nversion = "2.0.11"\n`,
    );
    await put(
      root,
      "native/rust-toolchain.toml",
      `[toolchain]\nchannel = "1.82.0"\ncomponents = ["rustfmt", "clippy"]\ntargets = ["wasm32-unknown-unknown"]\n`,
    );
    await put(
      root,
      "native/crates/core/src/lib.rs",
      "#![no_std]\npub mod protocol {}\npub unsafe fn read_raw() {}\n",
    );

    const profile = await analyzeProject(root);
    assert.equal(profile.status, "SUPPORTED", JSON.stringify(profile.diagnostics));
    assert.deepEqual(
      profile.workspaces.map((workspace) => workspace.ecosystem).sort(),
      ["fastapi", "nestjs", "react", "rust"],
    );

    const react = profile.workspaces.find((workspace) => workspace.ecosystem === "react");
    assert.equal(react?.variant, "vite-spa");
    assert.equal(react?.framework.resolvedVersion, "18.3.1");
    assert.deepEqual(react?.moduleAliases["@/*"], ["src/*"]);
    assert.ok(react?.routes.includes("/dashboard"));
    assert.ok(react?.validationPlan.every((command) => command.timeoutMs > 0 && command.network === false));

    const nest = profile.workspaces.find((workspace) => workspace.ecosystem === "nestjs");
    assert.equal(nest?.signals.httpAdapter, "fastify");
    assert.deepEqual(nest?.signals.orms, ["prisma"]);
    assert.ok(nest?.routes.includes("/users/:id"));
    assert.ok(Object.keys(nest?.signals.moduleGraph as object).some((path) => path.endsWith("users.module.ts")));

    const fastapi = profile.workspaces.find((workspace) => workspace.ecosystem === "fastapi");
    assert.equal(fastapi?.packageManager?.name, "uv");
    assert.equal(fastapi?.runtime.pydanticGeneration, "2");
    assert.equal(fastapi?.runtime.concurrencyModel, "async");
    assert.ok(fastapi?.routes.includes("/health"));

    const rust = profile.workspaces.find((workspace) => workspace.ecosystem === "rust");
    assert.equal(rust?.variant, "cargo-workspace");
    assert.deepEqual(rust?.runtime.targets, ["wasm32-unknown-unknown"]);
    assert.deepEqual(rust?.signals.asyncRuntimes, ["tokio"]);
    assert.ok((rust?.signals.unsafeFiles as string[]).some((path) => path.endsWith("lib.rs")));
    assert.ok(rust?.validationPlan.every((command) => !command.argv.includes("--all-features")));

    const repeated = await analyzeProject(root);
    assert.equal(repeated.fingerprint, profile.fingerprint);
    assert.deepEqual(
      repeated.workspaces.map((workspace) => workspace.fingerprint),
      profile.workspaces.map((workspace) => workspace.fingerprint),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting package-manager ownership fails closed with NEEDS_INPUT", async () => {
  const root = await fixture();
  try {
    await put(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { react: "18.3.1", vite: "6.1.0" },
        scripts: { build: "vite build", test: "vitest run" },
      }),
    );
    await put(
      root,
      "package-lock.json",
      JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/react": { version: "18.3.1" } } }),
    );
    await put(root, "yarn.lock", 'react@18.3.1:\n  version "18.3.1"\n');
    await put(root, "src/main.tsx", "export default function App() { return null }\n");

    const profile = await analyzeProject(root);
    assert.equal(profile.status, "NEEDS_INPUT");
    const react = profile.workspaces.find((workspace) => workspace.ecosystem === "react");
    assert.ok(react?.diagnostics.some((diagnostic) => diagnostic.code === "CONFLICTING_NODE_LOCKFILES"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static analysis never executes Vite configuration", async () => {
  const root = await fixture();
  const marker = join(root, "config-executed");
  try {
    await put(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "18.3.1", vite: "6.1.0" } }),
    );
    await put(
      root,
      "vite.config.js",
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); export default {};\n`,
    );
    await put(root, "src/main.jsx", "export default function App() { return null }\n");
    const profile = await analyzeProject(root);
    assert.equal(profile.workspaces[0]?.variant, "vite-spa");
    await assert.rejects(() => access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and non-directory roots are PARTIAL_SCAN, never empty success", async () => {
  const root = await fixture();
  try {
    const missing = await analyzeProject(join(root, "missing"));
    assert.equal(missing.status, "PARTIAL_SCAN");
    assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "ROOT_UNREADABLE"));

    await put(root, "file", "not a directory");
    const file = await analyzeProject(join(root, "file"));
    assert.equal(file.status, "PARTIAL_SCAN");
    assert.ok(file.diagnostics.some((diagnostic) => diagnostic.code === "ROOT_NOT_DIRECTORY"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
