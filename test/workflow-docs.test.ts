import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const WORKFLOWS_PATH = fileURLToPath(new URL("../docs/WORKFLOWS.md", import.meta.url));

test("the workflow guide covers every CLI command and primary lifecycle entry point", async () => {
  const [cliSource, workflowGuide] = await Promise.all([
    readFile(CLI_PATH, "utf8"),
    readFile(WORKFLOWS_PATH, "utf8"),
  ]);
  const commandDeclaration = cliSource.match(/const COMMANDS = new Set\(\[(.+)\]\);/u);
  assert.ok(commandDeclaration, "CLI command registry was not found.");
  const commands = [...commandDeclaration[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  const missingCommands = commands.filter((command) =>
    !workflowGuide.includes(`human-to-code ${command}`));
  assert.deepEqual(missingCommands, [], `Missing command workflows: ${missingCommands.join(", ")}`);

  const requiredPaths = [
    "npx human-to-code .",
    "human-to-code --init",
    "human-to-code --help",
    "runHumanToCodeCli",
    "generateGuidedCodeChangeRun",
    "validateGuidedCodeChangeRun",
    "applyVerifiedCodeChangeRun",
    "rollbackAppliedCodeChangeRun",
  ];
  const missingPaths = requiredPaths.filter((name) => !workflowGuide.includes(name));
  assert.deepEqual(missingPaths, [], `Missing primary workflow paths: ${missingPaths.join(", ")}`);
});
