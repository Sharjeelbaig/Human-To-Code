import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDirectPlanClassificationPrompt,
  classifyUnitsNeedingPlanning,
  parseDirectPlanClassification,
  planClassificationRequestCount,
  plannedRequestCounts,
  renderReceipt,
  MAX_PLAN_CLASSIFICATION_INSTRUCTION_CHARS,
  PLAN_CLASSIFICATION_BATCH_SIZE,
  type ConversionUnit,
  type PlanningDisclosureOptions,
} from "../src/index.ts";

function fileUnit(path: string, prompt: string): ConversionUnit {
  return {
    kind: "file",
    sourcePath: `${path}.human`,
    absoluteSource: `/tmp/${path}.human`,
    prompt,
    outputPath: path,
    describe: `${path}.human → ${path}`,
  };
}

const PLANNING: PlanningDisclosureOptions = {
  enabled: true,
  adaptive: false,
  projectBlueprint: true,
  fileTodo: true,
  markerTodo: false,
  maxCodingPassesPerUnit: 2,
};

test("parseDirectPlanClassification accepts a bounded, in-range index list", () => {
  assert.deepEqual(
    [...parseDirectPlanClassification('{"needPlanning":[1,3]}', 3)],
    [1, 3],
  );
  assert.equal(parseDirectPlanClassification('{"needPlanning":[]}', 3).size, 0);
});

test("parseDirectPlanClassification rejects malformed or out-of-range output", () => {
  assert.throws(() => parseDirectPlanClassification("not json", 3), /valid JSON/u);
  assert.throws(() => parseDirectPlanClassification('{"needPlanning":[0]}', 3), /out-of-range/u);
  assert.throws(() => parseDirectPlanClassification('{"needPlanning":[4]}', 3), /out-of-range/u);
  assert.throws(() => parseDirectPlanClassification('{"needPlanning":[1.5]}', 3), /out-of-range/u);
  assert.throws(() => parseDirectPlanClassification('{"needPlanning":[1],"x":1}', 3), /only needPlanning/u);
  assert.throws(() => parseDirectPlanClassification('{"other":[1]}', 3), /only needPlanning/u);
  assert.throws(() => parseDirectPlanClassification("[1,2]", 3), /was not an object/u);
  assert.throws(() => parseDirectPlanClassification(`{"needPlanning":[${"1,".repeat(6000)}1]}`, 3), /8192/u);
});

test("plan-classification prompt numbers every task and bounds long instructions", () => {
  const long = "x".repeat(MAX_PLAN_CLASSIFICATION_INSTRUCTION_CHARS + 100);
  const prompt = buildDirectPlanClassificationPrompt({
    items: [
      { index: 1, targetPath: "a.ts", instruction: "small tweak", inline: false },
      { index: 2, targetPath: "b.ts", instruction: long, inline: true },
    ],
  });
  assert.match(prompt.user, /TASK 1 — whole file a\.ts/u);
  assert.match(prompt.user, /TASK 2 — inline @human marker in b\.ts/u);
  // The system prompt discloses the valid index range and forbids code.
  assert.match(prompt.system, /1 to 2/u);
  assert.match(prompt.system, /Do not write code/u);
  // The oversized instruction is truncated with an ellipsis, never sent whole.
  assert.ok(prompt.user.includes("…"));
  assert.ok(!prompt.user.includes("x".repeat(MAX_PLAN_CLASSIFICATION_INSTRUCTION_CHARS + 1)));
});

test("planClassificationRequestCount batches by the configured size", () => {
  assert.equal(planClassificationRequestCount(0), 0);
  assert.equal(planClassificationRequestCount(1), 1);
  assert.equal(planClassificationRequestCount(PLAN_CLASSIFICATION_BATCH_SIZE), 1);
  assert.equal(planClassificationRequestCount(PLAN_CLASSIFICATION_BATCH_SIZE + 1), 2);
});

test("classifyUnitsNeedingPlanning maps returned indices back to the right units", async () => {
  const units = [fileUnit("a.ts", "one"), fileUnit("b.ts", "two"), fileUnit("c.ts", "three")];
  const result = await classifyUnitsNeedingPlanning(units, async () => new Set([2]));
  assert.equal(result.classificationRequests, 1);
  assert.deepEqual([...result.needsPlanning], [units[1]]);
  assert.equal(result.fallbacks.length, 0);
});

test("classifyUnitsNeedingPlanning splits into multiple bounded batches", async () => {
  const units = Array.from({ length: PLAN_CLASSIFICATION_BATCH_SIZE + 5 }, (_, i) =>
    fileUnit(`f${i}.ts`, `task ${i}`),
  );
  const batchSizes: number[] = [];
  const result = await classifyUnitsNeedingPlanning(units, async (items) => {
    batchSizes.push(items.length);
    return new Set([1]); // first unit of each batch needs planning
  });
  assert.deepEqual(batchSizes, [PLAN_CLASSIFICATION_BATCH_SIZE, 5]);
  assert.equal(result.classificationRequests, 2);
  assert.deepEqual([...result.needsPlanning], [units[0], units[PLAN_CLASSIFICATION_BATCH_SIZE]]);
});

test("a failed classification batch falls back to planning all of its units", async () => {
  const units = Array.from({ length: PLAN_CLASSIFICATION_BATCH_SIZE + 3 }, (_, i) =>
    fileUnit(`f${i}.ts`, `task ${i}`),
  );
  let call = 0;
  const result = await classifyUnitsNeedingPlanning(units, async () => {
    call += 1;
    if (call === 2) throw new Error("provider exploded");
    return new Set<number>(); // first batch: none need planning
  });
  assert.equal(result.classificationRequests, 2);
  assert.equal(result.fallbacks.length, 1);
  // Only the failed second batch's 3 units are planned; the first batch skips.
  assert.deepEqual(
    [...result.needsPlanning].sort((l, r) => l.sourcePath.localeCompare(r.sourcePath)),
    units.slice(PLAN_CLASSIFICATION_BATCH_SIZE).sort((l, r) => l.sourcePath.localeCompare(r.sourcePath)),
  );
});

test("plannedRequestCounts discloses triage requests and keeps todo as an upper bound", () => {
  const units = [fileUnit("a.ts", "one"), fileUnit("b.ts", "two"), fileUnit("c.ts", "three")];
  const off = plannedRequestCounts(units, PLANNING);
  assert.equal(off.planClassification, 0);
  assert.equal(off.todo, 3);

  const on = plannedRequestCounts(units, { ...PLANNING, adaptive: true });
  assert.equal(on.planClassification, 1);
  assert.equal(on.todo, 3); // upper bound: every eligible unit
  assert.equal(on.coding, 3);
});

test("the receipt marks per-target todo as an upper bound only when adaptive", () => {
  const units = [fileUnit("index.html", "page"), fileUnit("styles.css", "styles")];
  const plain = renderReceipt(units, "ollama", "m", ["html", "css"], {
    reconcileIntegrations: false,
    planning: PLANNING,
  });
  assert.match(plain, /2 per-target todo/u);
  assert.doesNotMatch(plain, /planning triage|up to 2 per-target todo|Adaptive planning:/u);

  const adaptive = renderReceipt(units, "ollama", "m", ["html", "css"], {
    reconcileIntegrations: false,
    planning: { ...PLANNING, adaptive: true },
  });
  assert.match(adaptive, /1 planning triage/u);
  assert.match(adaptive, /up to 2 per-target todo/u);
  assert.match(adaptive, /Adaptive planning: a batched triage/u);
});
