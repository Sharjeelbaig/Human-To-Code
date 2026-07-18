import type { PatchSetV1 } from "../../core/contracts.ts";

/** Render structured patch operations as a stable, review-oriented diff. */
export function renderPatchDiff(patch: PatchSetV1): string {
  const blocks: string[] = [];
  for (const operation of patch.operations) {
    if (operation.kind === "rename") {
      blocks.push(`rename from ${operation.from}\nrename to ${operation.path}`);
      continue;
    }
    const before = operation.kind === "create"
      ? ""
      : operation.kind === "edit"
        ? operation.oldText
        : "[content bound by base hash; omitted from model artifact]";
    const after = operation.kind === "delete"
      ? ""
      : operation.kind === "edit"
        ? operation.newText
        : operation.content;
    const oldPath = operation.kind === "create" ? "/dev/null" : `a/${operation.path}`;
    const newPath = operation.kind === "delete" ? "/dev/null" : `b/${operation.path}`;
    blocks.push([
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      "@@ human-to-code structured operation @@",
      ...before.split("\n").map((line) => `-${line}`),
      ...after.split("\n").map((line) => `+${line}`),
    ].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}
