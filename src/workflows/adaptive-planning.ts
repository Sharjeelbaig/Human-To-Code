/**
 * Adaptive planning: one batched triage that decides which units earn a
 * per-unit todo pass, instead of paying for a todo request on every unit. The
 * provider call is injected so this orchestration stays deterministic and
 * unit-testable, and so a failed batch degrades to the original "plan it"
 * behavior rather than silently skipping planning.
 */
import type { DirectPlanClassificationItem } from "../prompts/direct-plan-classification.ts";
import { type ConversionUnit, unitOwnsCompleteFile } from "./types.ts";

/**
 * Units per classification request. Large enough that a handful of calls covers
 * thousands of units, small enough that one request stays bounded and the model
 * keeps track of every index. Each unit contributes a length-capped excerpt.
 */
export const PLAN_CLASSIFICATION_BATCH_SIZE = 40;

/** Exact number of classification requests a batch of this size will issue. */
export function planClassificationRequestCount(eligibleUnitCount: number): number {
  if (eligibleUnitCount <= 0) return 0;
  return Math.ceil(eligibleUnitCount / PLAN_CLASSIFICATION_BATCH_SIZE);
}

/** The path a unit's classification item is anchored to. */
function unitTargetPath(unit: ConversionUnit): string {
  return unit.kind === "file" ? unit.outputPath ?? unit.sourcePath : unit.sourcePath;
}

function toItems(batch: readonly ConversionUnit[]): DirectPlanClassificationItem[] {
  return batch.map((unit, offset) => ({
    index: offset + 1,
    targetPath: unitTargetPath(unit),
    instruction: unit.prompt,
    // A whole-file inline marker is written like a file, so treat it as one.
    inline: !unitOwnsCompleteFile(unit),
  }));
}

export interface AdaptivePlanningResult {
  /** Units the classifier (or a failed-batch fallback) says should be planned. */
  needsPlanning: Set<ConversionUnit>;
  /** Classification requests actually attempted; one per batch. */
  classificationRequests: number;
  /** Human-readable reasons a batch fell back to planning everything in it. */
  fallbacks: string[];
}

/**
 * Batch `units` and ask `classifyBatch` which of each batch's 1-based indices
 * need planning. Indices the classifier returns become planned units; a batch
 * whose classifier throws is planned in full so quality never silently drops.
 * `units` should already be the todo-eligible set — callers gate on kind first.
 */
export async function classifyUnitsNeedingPlanning(
  units: readonly ConversionUnit[],
  classifyBatch: (items: readonly DirectPlanClassificationItem[]) => Promise<Set<number>>,
): Promise<AdaptivePlanningResult> {
  const needsPlanning = new Set<ConversionUnit>();
  const fallbacks: string[] = [];
  let classificationRequests = 0;

  for (let start = 0; start < units.length; start += PLAN_CLASSIFICATION_BATCH_SIZE) {
    const batch = units.slice(start, start + PLAN_CLASSIFICATION_BATCH_SIZE);
    classificationRequests += 1;
    let selected: Set<number>;
    try {
      selected = await classifyBatch(toItems(batch));
    } catch (error) {
      // Fail safe: an unclassifiable batch keeps the pre-adaptive behavior of
      // planning every unit in it. Cheaper savings are forfeited, not quality.
      for (const unit of batch) needsPlanning.add(unit);
      fallbacks.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const index of selected) {
      const unit = batch[index - 1];
      if (unit !== undefined) needsPlanning.add(unit);
    }
  }

  return { needsPlanning, classificationRequests, fallbacks };
}
