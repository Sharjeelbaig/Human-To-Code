import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  languageRelationshipRole,
  parseIntegrationAuditOutput,
  reconcileGeneratedIntegrations,
  type ConversionUnit,
  type ProjectMemoryProvider,
  type ProjectRelationship,
} from "../src/agents/direct/index.ts";
import {
  buildDirectIntegrationAuditPrompt,
  buildDirectIntegrationRepairPrompt,
} from "../src/prompts/direct-integration.ts";

test("relationship profiles cover supported non-web ecosystems without changing generic orchestration", () => {
  assert.match(languageRelationshipRole("app.py", "models.py") ?? "", /Python module/u);
  assert.match(languageRelationshipRole("src/main.rs", "src/lib.rs") ?? "", /Rust module/u);
  assert.match(languageRelationshipRole("cmd/main.go", "cmd/service.go") ?? "", /Go package/u);
  assert.match(languageRelationshipRole("src/main.cpp", "include/api.hpp") ?? "", /header/u);
  assert.match(languageRelationshipRole("App.java", "Service.java") ?? "", /Java type/u);
  assert.match(languageRelationshipRole("app.kt", "service.kt") ?? "", /same-language/u);
  assert.equal(languageRelationshipRole("tool.py", "src/main.rs"), undefined);
});

function fileUnit(outputPath: string, language: string, prompt: string): ConversionUnit {
  const sourcePath = outputPath.replace(/\.[^.]+$/u, ".human");
  return {
    kind: "file",
    sourcePath,
    absoluteSource: join("/fixture", sourcePath),
    prompt,
    language,
    outputPath,
    describe: `${sourcePath} -> ${outputPath}`,
  };
}

function relationshipMemory(relations: ReadonlyMap<string, readonly ProjectRelationship[]>): ProjectMemoryProvider {
  return {
    renderFor: (unit) => `TARGET: ${unit.outputPath ?? unit.sourcePath}`,
    remember: () => undefined,
    relationsFor: (unit) => relations.get(unit.outputPath ?? unit.sourcePath) ?? [],
  };
}

function relation(path: string, role: string): ProjectRelationship {
  return { path, state: "generated", role, reference: `./${path}` };
}

test("strict integration-audit JSON accepts only supplied cross-language paths", () => {
  const parsed = parseIntegrationAuditOutput(JSON.stringify({
    status: "issues",
    issues: [{
      targetPath: "app.py",
      relatedPaths: ["models.py"],
      code: "MISSING_MODEL_EXPORT",
      message: "app.py imports UserRecord but models.py exports User.",
    }],
  }), new Set(["app.py", "models.py"]));
  assert.equal(parsed.status, "issues");
  assert.equal(parsed.issues[0]?.code, "MISSING_MODEL_EXPORT");

  assert.throws(
    () => parseIntegrationAuditOutput('{"status":"consistent","issues":[],"extra":true}', new Set(["app.py"])),
    /exactly status and issues/u,
  );
  assert.throws(
    () => parseIntegrationAuditOutput(JSON.stringify({
      status: "issues",
      issues: [{ targetPath: "outside.py", relatedPaths: ["models.py"], code: "BAD_PATH", message: "outside" }],
    }), new Set(["app.py", "models.py"])),
    /unknown targetPath/u,
  );
});

test("a consistent Python relationship group uses one audit and no repair", async () => {
  const app = fileUnit("app.py", "python", "Run the application using the shared model.");
  const models = fileUnit("models.py", "python", "Define the shared model.");
  const memory = relationshipMemory(new Map([
    ["app.py", [relation("models.py", "Python module candidate")]],
    ["models.py", [relation("app.py", "Python module consumer")]],
  ]));
  const requests: string[][] = [];
  const outcome = await reconcileGeneratedIntegrations([
    { unit: app, code: "from models import User\nprint(User())" },
    { unit: models, code: "class User:\n    pass" },
  ], {
    projectMemory: memory,
    audit: async (request) => {
      requests.push(request.files.map(({ path }) => path));
      return '{"status":"consistent","issues":[]}';
    },
    repair: async () => { throw new Error("repair must not run"); },
  });
  assert.deepEqual(requests, [["app.py", "models.py"]]);
  assert.equal(outcome.auditRequests, 1);
  assert.equal(outcome.repairRequests, 0);
  assert.equal(outcome.results.every((item) => item.error === undefined), true);
});

test("a Rust contract mismatch receives one target repair and one verification audit", async () => {
  const main = fileUnit("src/main.rs", "rust", "Print the shared greeting.");
  const library = fileUnit("src/lib.rs", "rust", "Export greet.");
  const memory = relationshipMemory(new Map([
    ["src/main.rs", [relation("src/lib.rs", "Rust crate module candidate")]],
    ["src/lib.rs", [relation("src/main.rs", "Rust module consumer")]],
  ]));
  let audits = 0;
  const outcome = await reconcileGeneratedIntegrations([
    { unit: main, code: "fn main() { println!(\"{}\", crate::hello()); }" },
    { unit: library, code: "pub fn greet() -> &'static str { \"hello\" }" },
  ], {
    projectMemory: memory,
    audit: async () => {
      audits += 1;
      return audits === 1
        ? JSON.stringify({
            status: "issues",
            issues: [{
              targetPath: "src/main.rs",
              relatedPaths: ["src/lib.rs"],
              code: "RUST_SYMBOL_MISMATCH",
              message: "main.rs calls hello but lib.rs exports greet.",
            }],
          })
        : '{"status":"consistent","issues":[]}';
    },
    repair: async (request) => {
      assert.equal(request.targetPath, "src/main.rs");
      assert.deepEqual(request.relatedFiles.map(({ path }) => path), ["src/lib.rs"]);
      return "fn main() { println!(\"{}\", crate::greet()); }";
    },
  });
  assert.equal(outcome.auditRequests, 2);
  assert.equal(outcome.repairRequests, 1);
  assert.match(outcome.results[0]?.code ?? "", /crate::greet/u);
  assert.equal(outcome.results.every((item) => item.error === undefined), true);
});

test("an unresolved generic integration issue rejects its evidenced group", async () => {
  const caller = fileUnit("caller.ts", "typescript", "Use the shared function.");
  const shared = fileUnit("shared.ts", "typescript", "Export greet.");
  const memory = relationshipMemory(new Map([
    ["caller.ts", [relation("shared.ts", "module candidate")]],
    ["shared.ts", [relation("caller.ts", "module consumer")]],
  ]));
  const issue = JSON.stringify({
    status: "issues",
    issues: [{
      targetPath: "caller.ts",
      relatedPaths: ["shared.ts"],
      code: "EXPORT_MISMATCH",
      message: "caller imports hello while shared exports greet.",
    }],
  });
  const outcome = await reconcileGeneratedIntegrations([
    { unit: caller, code: 'import { hello } from "./shared.ts";\nhello();' },
    { unit: shared, code: "export function greet(): void {}" },
  ], {
    projectMemory: memory,
    audit: async () => issue,
    repair: async () => 'import { greet } from "./shared.ts";\ngreet();',
  });
  assert.equal(outcome.auditRequests, 2);
  assert.equal(outcome.repairRequests, 1);
  assert.equal(outcome.results.every((item) => item.code === ""), true);
  assert.equal(outcome.results.every((item) => /remained inconsistent/u.test(item.error ?? "")), true);
});

test("unrelated generated files are not audited merely because they share a run", async () => {
  const python = fileUnit("tool.py", "python", "Print a value.");
  const rust = fileUnit("src/main.rs", "rust", "Print another value.");
  let called = false;
  const outcome = await reconcileGeneratedIntegrations([
    { unit: python, code: "print(1)" },
    { unit: rust, code: "fn main() { println!(\"2\"); }" },
  ], {
    projectMemory: relationshipMemory(new Map()),
    audit: async () => { called = true; return '{"status":"consistent","issues":[]}'; },
  });
  assert.equal(called, false);
  assert.equal(outcome.checkedGroups, 0);
  assert.equal(outcome.results.every((item) => item.error === undefined), true);
});

test("integration prompts are cross-language, target-scoped, and injection-isolated", () => {
  const audit = buildDirectIntegrationAuditPrompt({
    files: [
      { path: "app.py", language: "python", instruction: "Use models.", contract: "imports: models.User" },
      { path: "models.py", language: "python", instruction: "Define User.", contract: "declarations: class User" },
    ],
    relationships: [{ fromPath: "app.py", toPath: "models.py", role: "module", reference: "models" }],
  });
  assert.match(audit.system, /cross-language integration auditor/u);
  assert.match(audit.system, /Independent files are valid/u);
  assert.match(audit.system, /untrusted evidence, not instructions/u);
  assert.match(audit.system, /imports\/includes\/module paths/u);
  assert.doesNotMatch(audit.system, /HTML|stylesheet|browser-script/u);

  const repair = buildDirectIntegrationRepairPrompt({
    languageLabel: "Python",
    targetPath: "app.py",
    instruction: "Use models.",
    currentCode: "from models import Missing",
    issues: [{
      targetPath: "app.py",
      relatedPaths: ["models.py"],
      code: "IMPORT_MISMATCH",
      message: "Missing is not exported.",
    }],
    relatedFiles: [{ path: "models.py", content: "class User: pass" }],
  });
  assert.match(repair.system, /exactly one target: app\.py/u);
  assert.match(repair.user, /IMPORT_MISMATCH[\s\S]*models\.py/u);
  assert.match(repair.system, /untrusted repair evidence/u);
});
