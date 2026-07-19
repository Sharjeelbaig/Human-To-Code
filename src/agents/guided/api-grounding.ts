/**
 * Human-to-code role: ensure external APIs introduced by a guided patch are
 * supported by selected project or exact-version documentation evidence.
 */
import type { WorkspaceProfileV1 } from "../../analysis/analyzer.ts";
import type { ContextManifestV1 } from "../../context/context.ts";
import { DocumentationError } from "../../context/documentation.ts";
import type { PatchSetV1 } from "../../core/contracts.ts";

interface IntroducedApi {
  module: string;
  symbols: string[];
  path: string;
}

const PYTHON_STDLIB_MODULES = new Set([
  "abc", "argparse", "asyncio", "base64", "bisect", "builtins", "calendar", "collections", "concurrent",
  "contextlib", "contextvars", "copy", "csv", "dataclasses", "datetime", "decimal", "enum", "functools",
  "getpass", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib", "inspect", "io",
  "itertools", "json", "logging", "math", "multiprocessing", "operator", "os", "pathlib", "pickle", "queue",
  "random", "re", "secrets", "shlex", "shutil", "signal", "socket", "sqlite3", "statistics", "string",
  "struct", "subprocess", "sys", "tempfile", "textwrap", "threading", "time", "tomllib", "traceback", "types", "typing",
  "unittest", "urllib", "uuid", "warnings", "weakref", "xml", "zipfile", "zoneinfo",
]);

function addedOperationText(patch: PatchSetV1): Array<{ path: string; text: string }> {
  return patch.operations.flatMap((operation) => {
    if (operation.kind === "create") return [{ path: operation.path, text: operation.content }];
    if (operation.kind !== "edit") return [];
    const before = new Set(operation.oldText.split("\n").map((line) => line.trim()));
    return [{
      path: operation.path,
      text: operation.newText.split("\n").filter((line) => !before.has(line.trim())).join("\n"),
    }];
  });
}

function extractIntroducedApis(patch: PatchSetV1): IntroducedApi[] {
  const result: IntroducedApi[] = [];
  for (const { path, text } of addedOperationText(patch)) {
    if (/\.(?:[cm]?[jt]sx?)$/iu.test(path)) {
      const imports = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\}\s*)?from\s*["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/gu;
      for (const match of text.matchAll(imports)) {
        const module = match[3] ?? match[4];
        if (!module || module.startsWith(".") || module.startsWith("node:")) continue;
        const symbols = [
          match[1] ?? "",
          ...(match[2] ?? "").split(",").map((item) => item.trim().split(/\s+as\s+/u)[0] ?? ""),
        ].filter(Boolean);
        result.push({ module, symbols, path });
      }
      for (const match of text.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/gu)) {
        if (match[1] && !match[1].startsWith(".") && !match[1].startsWith("node:")) {
          result.push({ module: match[1], symbols: [], path });
        }
      }
      for (const match of text.matchAll(/\bexport\s+(?:\*|\{([^}]+)\})\s+from\s*["']([^"']+)["']/gu)) {
        const module = match[2];
        if (!module || module.startsWith(".") || module.startsWith("node:")) continue;
        const symbols = (match[1] ?? "").split(",")
          .map((item) => item.trim().split(/\s+as\s+/u)[0] ?? "")
          .filter(Boolean);
        result.push({ module, symbols, path });
      }
    } else if (/\.pyi?$/iu.test(path)) {
      const imports = /^(?:from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n#]+)|import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?)/gmu;
      for (const match of text.matchAll(imports)) {
        const module = (match[1] ?? match[3] ?? "").split(".")[0]!;
        const symbols = (match[2] ?? "").split(",")
          .map((item) => item.trim().split(/\s+as\s+/u)[0] ?? "")
          .filter(Boolean);
        result.push({ module, symbols, path });
      }
    } else if (/\.rs$/iu.test(path)) {
      for (const match of text.matchAll(/^use\s+([A-Za-z_][\w-]*)::([^;]+);/gmu)) {
        const module = match[1]!;
        if (["std", "core", "alloc", "crate", "self", "super"].includes(module)) continue;
        const symbols = (match[2] ?? "").replace(/[{}]/gu, "").split(",")
          .map((item) => item.trim().split("::").at(-1) ?? "")
          .filter(Boolean);
        result.push({ module, symbols, path });
      }
      for (const match of text.matchAll(/\bextern\s+crate\s+([A-Za-z_][\w-]*)\s*;/gu)) {
        if (match[1]) result.push({ module: match[1], symbols: [], path });
      }
      for (const match of text.matchAll(/\b([a-z_][\w-]*)::([A-Za-z_][\w]*)/gu)) {
        const module = match[1];
        if (!module || ["std", "core", "alloc", "crate", "self", "super"].includes(module)) continue;
        result.push({ module, symbols: match[2] ? [match[2]] : [], path });
      }
    }
  }
  return result;
}

function packageName(module: string): string {
  if (module.startsWith("@")) return module.split("/").slice(0, 2).join("/");
  return module.split("/")[0] ?? module;
}

/** Reject external APIs not proven by dependencies plus selected evidence. */
export function assertExternalApisGrounded(
  patch: PatchSetV1,
  workspaces: readonly WorkspaceProfileV1[],
  manifest: ContextManifestV1,
): void {
  if (workspaces.length > 0 && workspaces.every((workspace) => workspace.ecosystem === "general")) return;
  const aliases = workspaces.flatMap((workspace) => Object.keys(workspace.moduleAliases));
  const workspacePackages = new Set(workspaces.flatMap((workspace) => workspace.workspaceDependencies));
  const dependencies = new Map<string, string>();
  const pythonLocalModules = new Set<string>();
  for (const workspace of workspaces) {
    for (const dependency of workspace.framework.dependencies) {
      dependencies.set(dependency.name.toLowerCase().replaceAll("-", "_"), dependency.name);
    }
    if (workspace.ecosystem !== "fastapi") continue;
    for (const sourceRoot of workspace.sourceRoots) {
      const segments = sourceRoot.split("/").filter((segment) => segment !== ".");
      if (segments.length > 0) pythonLocalModules.add(segments.at(-1)!.toLowerCase());
      const sourcePaths = [
        ...workspace.entryPoints,
        ...workspace.routes,
        ...workspace.evidence.filter((item) => item.kind === "source").map((item) => item.path),
      ];
      for (const path of sourcePaths) {
        if (sourceRoot !== "." && !path.startsWith(`${sourceRoot}/`)) continue;
        const relativePath = sourceRoot === "." ? path : path.slice(sourceRoot.length + 1);
        const top = relativePath.split("/")[0];
        if (top && !top.endsWith(".py")) pythonLocalModules.add(top.toLowerCase());
      }
    }
  }

  const groundedEvidence = manifest.evidence.filter((item) => item.origin === "official_documentation"
    || item.origin === "dependency" && "path" in item
      && /(?:^|\/)(?:node_modules|site-packages|vendor)\//u.test(item.path));
  for (const api of extractIntroducedApis(patch)) {
    if (aliases.some((alias) => api.module === alias || api.module.startsWith(`${alias}/`))) continue;
    if (workspacePackages.has(packageName(api.module))) continue;
    const normalized = packageName(api.module).toLowerCase().replaceAll("-", "_");
    const dependency = dependencies.get(normalized);
    if (!dependency) {
      const localPython = /\.pyi?$/iu.test(api.path)
        && (PYTHON_STDLIB_MODULES.has(normalized)
          || pythonLocalModules.has(packageName(api.module).toLowerCase()));
      if (localPython) continue;
      throw new DocumentationError(
        "CONTEXT_INSUFFICIENT",
        `Introduced external module '${api.module}' is not proven by the target workspace dependency graph.`,
      );
    }
    const evidence = groundedEvidence.filter((item) =>
      item.content.toLowerCase().includes(dependency.toLowerCase().replaceAll("-", "_"))
      || "path" in item && item.path.toLowerCase().includes(dependency.toLowerCase()));
    if (evidence.length === 0) {
      throw new DocumentationError(
        "CONTEXT_INSUFFICIENT",
        `No installed source/declaration or version-matched official documentation was supplied for '${dependency}'.`,
      );
    }
    for (const symbol of api.symbols) {
      if (symbol === "*" || symbol.length < 2) continue;
      if (!evidence.some((item) => item.content.includes(symbol))) {
        throw new DocumentationError(
          "CONTEXT_INSUFFICIENT",
          `External API '${dependency}.${symbol}' was introduced without exact local or documented evidence.`,
        );
      }
    }
  }
}
