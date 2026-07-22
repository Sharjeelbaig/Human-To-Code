/**
 * Declared capability matrix: the exhaustive list of ecosystem/variant/version
 * profiles this release recognizes and their support tier. Anything outside
 * this matrix is UNSUPPORTED by definition — support is declared here, never
 * inferred from analysis confidence.
 */
import type { Ecosystem, SupportDecision, SupportTier } from "./analyzer-types.ts";

export interface SupportMatrixEntry {
  key: string;
  ecosystem: Ecosystem;
  variant: string;
  versions: string;
  tier: SupportTier;
  capabilities: readonly string[];
  limitations: readonly string[];
}

/**
 * Versioned support declarations for the first analyzer release.
 *
 * Generation remains preview until the model/provider benchmark gate described
 * by the reliability contract has actually run. Keeping that fact in data (and
 * not in marketing copy) prevents a newly recognized project from being
 * accidentally presented as certified.
 */
export const SUPPORT_MATRIX_VERSION = "1.0.0" as const;

const SUPPORT_MATRIX_VALUE: readonly SupportMatrixEntry[] = [
  {
    key: "react.vite-spa",
    ecosystem: "react",
    variant: "vite-spa",
    versions: "React 18-19; Vite 5-7",
    tier: "preview",
    capabilities: ["routes", "aliases", "client-boundaries", "package-scripts"],
    limitations: ["generation certification benchmark pending"],
  },
  {
    key: "react.vite-ssr",
    ecosystem: "react",
    variant: "vite-ssr",
    versions: "React 18-19; Vite 5-7",
    tier: "preview",
    capabilities: ["routes", "aliases", "ssr-boundaries", "package-scripts"],
    limitations: ["generation certification benchmark pending"],
  },
  {
    key: "react.next-app",
    ecosystem: "react",
    variant: "next-app-router",
    versions: "React 18-19; Next 14-16",
    tier: "preview",
    capabilities: ["file-routes", "server-client-boundaries", "package-scripts"],
    limitations: ["generation certification benchmark pending"],
  },
  {
    key: "react.next-pages",
    ecosystem: "react",
    variant: "next-pages-router",
    versions: "React 18-19; Next 14-16",
    tier: "preview",
    capabilities: ["file-routes", "server-client-boundaries", "package-scripts"],
    limitations: ["generation certification benchmark pending"],
  },
  {
    key: "react.next-hybrid",
    ecosystem: "react",
    variant: "next-hybrid",
    versions: "React 18-19; Next 14-16",
    tier: "preview",
    capabilities: ["file-routes", "server-client-boundaries", "package-scripts"],
    limitations: ["router ownership must be explicit for cross-router changes"],
  },
  {
    key: "react.cra",
    ecosystem: "react",
    variant: "cra",
    versions: "react-scripts 5",
    tier: "legacy",
    capabilities: ["aliases", "package-scripts"],
    limitations: ["CRA is legacy", "generation certification benchmark pending"],
  },
  {
    key: "react.library",
    ecosystem: "react",
    variant: "react-library",
    versions: "React 18-19",
    tier: "preview",
    capabilities: ["public-exports", "aliases", "package-scripts"],
    limitations: ["generation certification benchmark pending"],
  },
  {
    key: "react.nx",
    ecosystem: "react",
    variant: "nx-react",
    versions: "React 18-19; Nx project configuration",
    tier: "preview",
    capabilities: ["workspace-ownership", "targets", "routes", "aliases"],
    limitations: ["dynamic Nx plugins are not executed"],
  },
  {
    key: "nestjs.standard",
    ecosystem: "nestjs",
    variant: "standard",
    versions: "NestJS 10-11",
    tier: "preview",
    capabilities: ["module-di-graph", "http-adapter", "orm-signals", "package-scripts"],
    limitations: ["dynamic module internals remain opaque"],
  },
  {
    key: "nestjs.monorepo",
    ecosystem: "nestjs",
    variant: "nest-monorepo",
    versions: "NestJS 10-11; Nest CLI workspace",
    tier: "preview",
    capabilities: ["workspace-ownership", "module-di-graph", "http-adapter"],
    limitations: ["dynamic Nest CLI configuration is not executed"],
  },
  {
    key: "nestjs.nx",
    ecosystem: "nestjs",
    variant: "nx-nest",
    versions: "NestJS 10-11; Nx project configuration",
    tier: "preview",
    capabilities: ["workspace-ownership", "module-di-graph", "targets"],
    limitations: ["dynamic Nx plugins are not executed"],
  },
  {
    key: "fastapi.application",
    ecosystem: "fastapi",
    variant: "fastapi-application",
    versions: "FastAPI >=0.110,<1; Pydantic 1-2 detected explicitly",
    tier: "preview",
    capabilities: ["routers", "dependencies", "environment-manager", "sync-async-model"],
    limitations: ["dynamic Python metadata and imports are not executed"],
  },
  {
    key: "rust.crate",
    ecosystem: "rust",
    variant: "cargo-crate",
    versions: "Rust editions 2015, 2018, 2021, 2024",
    tier: "preview",
    capabilities: ["features", "targets", "toolchain", "elevated-risk-signals"],
    limitations: ["cargo metadata is deferred to sandboxed validation"],
  },
  {
    key: "rust.workspace",
    ecosystem: "rust",
    variant: "cargo-workspace",
    versions: "Cargo resolver 1-3; Rust editions 2015, 2018, 2021, 2024",
    tier: "preview",
    capabilities: ["workspace-members", "features", "targets", "toolchain"],
    limitations: ["cargo metadata is deferred to sandboxed validation"],
  },
  {
    key: "general.code",
    ecosystem: "general",
    variant: "general-code",
    versions: "Language-directed general generation (operator-declared language)",
    tier: "preview",
    capabilities: ["language-directed-generation"],
    limitations: [
      "ungrounded: no dependency/API evidence is proven",
      "unvalidated: no toolchain is assumed, so runs stay INCONCLUSIVE and are never auto-applied",
    ],
  },
] as const;

/** Runtime-immutable: consumers cannot promote preview entries by mutation. */
export const SUPPORT_MATRIX: readonly SupportMatrixEntry[] = Object.freeze(
  SUPPORT_MATRIX_VALUE.map((entry) => Object.freeze({
    ...entry,
    capabilities: Object.freeze([...entry.capabilities]),
    limitations: Object.freeze([...entry.limitations]),
  })),
);

export function supportFor(
  ecosystem: Ecosystem,
  variant: string,
  matchedVersion?: string,
): SupportDecision {
  const entry = SUPPORT_MATRIX.find(
    (candidate) => candidate.ecosystem === ecosystem && candidate.variant === variant,
  );
  if (!entry) {
    return {
      tier: "unsupported",
      matrixKey: `${ecosystem}.unknown`,
      reason: `No support-matrix entry exists for ${ecosystem}/${variant}.`,
      ...(matchedVersion === undefined ? {} : { matchedVersion }),
    };
  }
  const numeric = matchedVersion?.match(/^(\d+)(?:\.(\d+))?/);
  if (numeric) {
    const major = Number(numeric[1]);
    const minor = Number(numeric[2] ?? 0);
    const supported = (() => {
      if (entry.key.startsWith("react.next-")) return major >= 14 && major <= 16;
      if (entry.key === "react.cra") return major === 5;
      if (entry.key.startsWith("react.")) return major === 18 || major === 19;
      if (entry.key.startsWith("nestjs.")) return major === 10 || major === 11;
      if (entry.key === "fastapi.application") return major === 0 ? minor >= 110 : false;
      return true;
    })();
    if (!supported) {
      return {
        tier: "unsupported",
        matrixKey: entry.key,
        reason: `${matchedVersion} is outside the declared support range (${entry.versions}).`,
        matchedVersion,
      };
    }
  }
  return {
    tier: entry.tier,
    matrixKey: entry.key,
    reason: `${entry.versions}; ${entry.limitations.join("; ")}.`,
    ...(matchedVersion === undefined ? {} : { matchedVersion }),
  };
}
