/**
 * Deterministic cross-file reference checking for generated web output. It
 * answers one question the per-file syntax gate cannot: do the files that were
 * generated independently actually agree with each other? Source is never
 * executed and no model request is issued — every finding comes from the same
 * static extractors ProjectMemory already uses.
 *
 * This is reference checking, not verification. A clean result means the named
 * references line up, never that the project behaves correctly.
 */
import { dirname, extname, resolve as resolvePath, sep } from "node:path";
import { cssFacts, htmlFacts, javaScriptFacts } from "./project-contracts.ts";

/** Files whose cross-references this module understands. */
export const REFERENCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

/**
 * `blocking` marks a broken reference — a name used that exists nowhere, or a
 * state change that cannot take effect. `advisory` marks drift that is usually
 * a defect but has legitimate uses (utility classes, a11y helpers).
 *
 * The severity is a priority label, not a gate. The CLI reports findings and
 * feeds them to reconciliation; it does not refuse to write on a blocking
 * finding, because a page that renders correctly can still trip one — the
 * hidden-attribute check fires on real but cosmetic defects. Use
 * {@link hasBlockingFindings} if you want a caller-side gate.
 */
export type ReferenceSeverity = "blocking" | "advisory";

export type ReferenceFindingCode =
  | "JS_SELECTOR_MISSING"
  | "HTML_ASSET_MISSING"
  | "STATE_CLASS_DEFEATED"
  | "HIDDEN_ATTRIBUTE_OVERRIDDEN"
  | "HTML_CLASS_UNSTYLED"
  | "CSS_SELECTOR_UNUSED"
  | "CSS_COMPOUND_SELECTOR_UNMATCHED"
  | "EMPTY_VISUAL_ZERO_SIZE";

export interface ReferenceFinding {
  code: ReferenceFindingCode;
  severity: ReferenceSeverity;
  /** Project-relative file the finding is about. */
  path: string;
  /** Bounded, single-line explanation safe to show and to send as a repair hint. */
  detail: string;
  /** Exact generated selector involved, when one can be identified. */
  selector?: string;
}

export interface ReferenceFile {
  /** Project-relative POSIX path. */
  path: string;
  content: string;
  /** True when this file is a candidate from the current run. */
  generated: boolean;
}

const MAX_FINDINGS_PER_CODE = 12;
const MAX_DETAIL_CHARS = 220;
/** Only properties that can make content invisible are worth a blocking claim. */
const VISIBILITY_PROPERTIES = new Set(["opacity", "display", "visibility"]);

/**
 * True when a declaration actually hides content. Comparing raw strings is not
 * enough: `opacity:1 !important` and `opacity:1` differ textually but both
 * reveal, and flagging that pair reports a working stylesheet as broken.
 */
function hidesContent(property: string, value: string): boolean {
  const normalized = value.replace(/!important/u, "").trim().toLowerCase();
  if (property === "opacity") return Number.parseFloat(normalized) === 0;
  if (property === "display") return normalized === "none";
  if (property === "visibility") return normalized === "hidden" || normalized === "collapse";
  return false;
}

function paintsVisualBox(declarations: ReadonlyMap<string, string>): boolean {
  return ["background", "background-image", "box-shadow", "border", "border-image"]
    .some((property) => declarations.has(property));
}

function givesEmptyElementSize(declarations: ReadonlyMap<string, string>): boolean {
  if ([
    "height", "min-height", "block-size", "min-block-size", "aspect-ratio",
    "padding", "padding-block", "padding-top", "padding-bottom", "border", "flex", "flex-grow",
    "grid-area", "grid-row",
  ].some((property) => declarations.has(property))) return true;
  const position = declarations.get("position")?.trim().toLowerCase();
  if (position !== "absolute" && position !== "fixed") return false;
  const inset = declarations.get("inset");
  if (inset !== undefined && !/^auto(?:\s+auto){0,3}$/iu.test(inset.trim())) return true;
  return declarations.has("top") && declarations.has("bottom");
}

interface CssRule {
  selectors: string[];
  declarations: Map<string, string>;
  order: number;
}

function oneLine(value: string, limit = MAX_DETAIL_CHARS): string {
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

function toPosix(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (property.length === 0 || value.length === 0) continue;
    declarations.set(property, value);
  }
  return declarations;
}

/**
 * Walk style rules with brace awareness so rules nested in `@media`/`@supports`
 * are still seen and statement at-rules such as `@import` do not leak into the
 * next selector.
 */
export function scanCssRules(content: string): CssRule[] {
  const text = content.replace(/\/\*[\s\S]*?\*\//gu, " ");
  const rules: CssRule[] = [];
  let prelude = "";
  let order = 0;
  let index = 0;
  let groupDepth = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") {
      const head = prelude.trim();
      prelude = "";
      index += 1;
      if (head.startsWith("@")) {
        groupDepth += 1;
        continue;
      }
      const end = text.indexOf("}", index);
      const body = end === -1 ? text.slice(index) : text.slice(index, end);
      const selectors = head.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (selectors.length > 0) {
        rules.push({ selectors, declarations: parseDeclarations(body), order });
        order += 1;
      }
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "}") {
      if (groupDepth > 0) groupDepth -= 1;
      prelude = "";
      index += 1;
      continue;
    }
    // A statement at-rule (`@import …;`, `@charset …;`) ends here, not at a brace.
    if (char === ";") {
      prelude = "";
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return rules;
}

/** CSS specificity as (ids, classes+attributes+pseudo-classes, elements+pseudo-elements). */
export function selectorSpecificity(selector: string): readonly [number, number, number] {
  const cleaned = selector.replace(/\s*[>+~]\s*/gu, " ").trim();
  const withoutPseudoElements = cleaned.replace(/::[A-Za-z-]+/gu, " ");
  const ids = (cleaned.match(/#[A-Za-z0-9_-]+/gu) ?? []).length;
  const classes = (cleaned.match(/\.[A-Za-z0-9_-]+/gu) ?? []).length;
  const attributes = (cleaned.match(/\[[^\]]*\]/gu) ?? []).length;
  const pseudoClasses = (withoutPseudoElements.match(/:[A-Za-z-]+/gu) ?? []).length;
  const pseudoElements = (cleaned.match(/::[A-Za-z-]+/gu) ?? []).length;
  const bare = withoutPseudoElements
    .replace(/#[A-Za-z0-9_-]+/gu, " ")
    .replace(/\.[A-Za-z0-9_-]+/gu, " ")
    .replace(/\[[^\]]*\]/gu, " ")
    .replace(/:[A-Za-z-]+(?:\([^)]*\))?/gu, " ")
    .split(/\s+/u)
    .filter((part) => /^[a-zA-Z][a-zA-Z0-9-]*$/u.test(part)).length;
  return [ids, classes + attributes + pseudoClasses, bare + pseudoElements];
}

function comparesAtLeast(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

/** The rightmost compound selector — the element the rule actually styles. */
function subjectCompound(selector: string): string {
  const parts = selector.replace(/\s*[>+~]\s*/gu, " ").trim().split(/\s+/u);
  return parts[parts.length - 1] ?? "";
}

function compoundClasses(compound: string): Set<string> {
  return new Set((compound.match(/\.[A-Za-z0-9_-]+/gu) ?? []).map((entry) => entry.slice(1)));
}

function isSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function selectorClassTokens(selector: string): string[] {
  return (selector.match(/\.[A-Za-z0-9_-]+/gu) ?? []).map((entry) => entry.slice(1));
}

function selectorIdTokens(selector: string): string[] {
  return (selector.match(/#[A-Za-z0-9_-]+/gu) ?? []).map((entry) => entry.slice(1));
}

function expandedNestedSelectors(content: string): string[] {
  const text = content.replace(/\/\*[\s\S]*?\*\//gu, " ");
  const selectors: string[] = [];
  const pattern = /([^{};]+)\{[^{}]*?(&[^{}]+)\{/gu;
  for (const match of text.matchAll(pattern)) {
    const parent = (match[1] ?? "").trim();
    const nested = (match[2] ?? "").trim();
    if (parent.length === 0 || nested.length === 0) continue;
    selectors.push(nested.replace(/&/gu, parent));
  }
  return selectors;
}

function isExternalReference(reference: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/iu.test(reference);
}

/** Resolve an HTML-relative reference to a project-relative POSIX path. */
function resolveReference(fromPath: string, reference: string): string | undefined {
  const withoutQuery = reference.split(/[?#]/u)[0] ?? "";
  if (withoutQuery.length === 0) return undefined;
  if (withoutQuery.startsWith("/")) return withoutQuery.slice(1);
  const base = dirname(`/${fromPath}`);
  const resolved = resolvePath(base, withoutQuery);
  return toPosix(resolved).replace(/^\//u, "");
}

function push(
  findings: ReferenceFinding[],
  counts: Map<ReferenceFindingCode, number>,
  finding: ReferenceFinding,
): void {
  const seen = counts.get(finding.code) ?? 0;
  if (seen >= MAX_FINDINGS_PER_CODE) return;
  counts.set(finding.code, seen + 1);
  findings.push({ ...finding, detail: oneLine(finding.detail) });
}

/**
 * Cross-check the supplied web files against one another. Only files produced
 * by this run are reported against, so a pre-existing inconsistency in the
 * working tree never blocks a run that did not touch it.
 */
export function collectReferenceFindings(files: readonly ReferenceFile[]): ReferenceFinding[] {
  const html = files.filter((file) => [".html", ".htm"].includes(extname(file.path).toLowerCase()));
  const css = files.filter((file) => extname(file.path).toLowerCase() === ".css");
  const scripts = files.filter((file) => [".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extname(file.path).toLowerCase()));
  const findings: ReferenceFinding[] = [];
  const counts = new Map<ReferenceFindingCode, number>();
  if (html.length === 0 && css.length === 0 && scripts.length === 0) return findings;

  const knownPaths = new Set(files.map((file) => file.path));
  const htmlByFile = new Map(html.map((file) => [file.path, htmlFacts(file.content)]));
  const cssByFile = new Map(css.map((file) => [file.path, cssFacts(file.content)]));
  const scriptByFile = new Map(scripts.map((file) => [file.path, javaScriptFacts(file.content)]));

  const htmlClasses = new Set<string>();
  const htmlIds = new Set<string>();
  for (const facts of htmlByFile.values()) {
    for (const value of facts.classes) if (value.length > 0) htmlClasses.add(value);
    for (const value of facts.ids) if (value.length > 0) htmlIds.add(value);
  }
  const cssSelectorClasses = new Set<string>();
  const cssSelectorIds = new Set<string>();
  for (const facts of cssByFile.values()) {
    for (const selector of facts.selectors) {
      for (const token of selectorClassTokens(selector)) cssSelectorClasses.add(token);
      for (const token of selectorIdTokens(selector)) cssSelectorIds.add(token);
    }
  }
  const toggledClasses = new Set<string>();
  const renderedClassSets: Array<Set<string>> = [];
  const emptyRenderedClassSets: Array<Set<string>> = [];
  for (const file of html) {
    const facts = htmlByFile.get(file.path)!;
    for (const values of facts.classSets) renderedClassSets.push(new Set(values));
    if (file.generated) for (const values of facts.emptyClassSets) emptyRenderedClassSets.push(new Set(values));
  }
  for (const file of scripts) {
    const facts = scriptByFile.get(file.path)!;
    for (const value of facts.toggledClasses) if (value.length > 0) toggledClasses.add(value);
    for (const value of facts.renderedClasses) if (value.length > 0) htmlClasses.add(value);
    for (const values of facts.renderedClassSets) renderedClassSets.push(new Set(values));
    if (file.generated) for (const values of facts.emptyRenderedClassSets) emptyRenderedClassSets.push(new Set(values));
  }

  // Blocking: every class exists, but no rendered element owns the complete
  // generated compound selector. The rule cannot match in the candidate UI.
  for (const file of css) {
    if (!file.generated) continue;
    const facts = cssByFile.get(file.path)!;
    for (const selector of [...facts.selectors, ...expandedNestedSelectors(file.content)]) {
      const classes = [...compoundClasses(subjectCompound(selector))];
      if (classes.length < 2 || classes.some((value) => toggledClasses.has(value))) continue;
      if (!classes.every((value) => htmlClasses.has(value))) continue;
      if (renderedClassSets.some((values) => classes.every((value) => values.has(value)))) continue;
      push(findings, counts, {
        code: "CSS_COMPOUND_SELECTOR_UNMATCHED",
        severity: "blocking",
        path: file.path,
        selector,
        detail: `${file.path} defines "${selector}", but no rendered element has the required classes ${classes.map((value) => `"${value}"`).join(" and ")}.`,
      });
    }
  }

  // Blocking: a script queries a class or id that no markup in the project defines.
  if (html.length > 0) {
    for (const file of scripts) {
      if (!file.generated) continue;
      const facts = scriptByFile.get(file.path)!;
      for (const selector of new Set(facts.selectors)) {
        for (const token of selectorIdTokens(selector)) {
          if (!htmlIds.has(token)) {
            push(findings, counts, {
              code: "JS_SELECTOR_MISSING",
              severity: "blocking",
              path: file.path,
              detail: `${file.path} queries "${selector}" but no id "${token}" exists in the generated markup.`,
            });
          }
        }
        for (const token of selectorClassTokens(selector)) {
          if (!htmlClasses.has(token)) {
            push(findings, counts, {
              code: "JS_SELECTOR_MISSING",
              severity: "blocking",
              path: file.path,
              detail: `${file.path} queries "${selector}" but no element with class "${token}" exists in the generated markup.`,
            });
          }
        }
      }
    }
  }

  // Blocking: markup links a stylesheet or script that the project does not contain.
  for (const file of html) {
    if (!file.generated) continue;
    const facts = htmlByFile.get(file.path)!;
    for (const reference of new Set([...facts.stylesheets, ...facts.scripts])) {
      if (isExternalReference(reference)) continue;
      const resolved = resolveReference(file.path, reference);
      if (resolved === undefined || knownPaths.has(resolved)) continue;
      push(findings, counts, {
        code: "HTML_ASSET_MISSING",
        severity: "blocking",
        path: file.path,
        detail: `${file.path} references "${reference}" but ${resolved} is not part of this project.`,
      });
    }
  }

  const rulesByFile = new Map(css.map((file) => [file.path, scanCssRules(file.content)]));

  // Blocking: an empty generated element has visual paint but no intrinsic or
  // declared box size. Its background, shadow, or border cannot be seen.
  for (const classSet of emptyRenderedClassSets) {
    const declarations = new Map<string, string>();
    let paintedBy: { path: string; selector: string } | undefined;
    for (const [path, rules] of rulesByFile) {
      for (const rule of rules) {
        for (const selector of rule.selectors) {
          const classes = [...compoundClasses(subjectCompound(selector))];
          if (classes.length === 0 || !classes.some((value) => classSet.has(value))) continue;
          for (const [property, value] of rule.declarations) declarations.set(property, value);
          if (paintsVisualBox(rule.declarations) && css.find((file) => file.path === path)?.generated) {
            paintedBy = { path, selector };
          }
        }
      }
    }
    if (!paintedBy || givesEmptyElementSize(declarations)) continue;
    push(findings, counts, {
      code: "EMPTY_VISUAL_ZERO_SIZE",
      severity: "blocking",
      path: paintedBy.path,
      selector: paintedBy.selector,
      detail: `${paintedBy.path} paints "${paintedBy.selector}" on an empty generated element, but no matching rule gives that element a height, inset stretch, padding, aspect ratio, or other box size.`,
    });
  }

  // Blocking: a class the script toggles to reveal content is outranked by a
  // rule that hides the same element, so adding the class can never take effect.
  for (const [path, rules] of rulesByFile) {
    const file = css.find((entry) => entry.path === path)!;
    if (!file.generated) continue;
    for (const stateClass of toggledClasses) {
      for (const revealing of rules) {
        for (const revealSelector of revealing.selectors) {
          const revealSubject = subjectCompound(revealSelector);
          const revealClasses = compoundClasses(revealSubject);
          if (!revealClasses.has(stateClass)) continue;
          for (const hiding of rules) {
            for (const hideSelector of hiding.selectors) {
              const hideClasses = compoundClasses(subjectCompound(hideSelector));
              if (hideClasses.has(stateClass) || !isSubset(hideClasses, revealClasses)) continue;
              for (const [property, hideValue] of hiding.declarations) {
                if (!VISIBILITY_PROPERTIES.has(property)) continue;
                const revealValue = revealing.declarations.get(property);
                // Only a genuinely hiding value defeated by a revealing one is
                // a defect; two rules that both reveal are not in conflict.
                if (revealValue === undefined) continue;
                if (!hidesContent(property, hideValue) || hidesContent(property, revealValue)) continue;
                const revealImportant = /!important/u.test(revealValue);
                const hideImportant = /!important/u.test(hideValue);
                if (revealImportant && !hideImportant) continue;
                if (!hideImportant && !revealImportant
                  && !comparesAtLeast(selectorSpecificity(hideSelector), selectorSpecificity(revealSelector))) {
                  continue;
                }
                push(findings, counts, {
                  code: "STATE_CLASS_DEFEATED",
                  severity: "blocking",
                  path,
                  detail: `"${hideSelector}" sets ${property}:${hideValue} and outranks "${revealSelector}"`
                    + ` (${property}:${revealValue}), so adding the "${stateClass}" class never reveals the element.`,
                });
              }
            }
          }
        }
      }
    }
  }

  // Blocking: the script hides elements with the `hidden` attribute while the
  // stylesheet gives them a `display`, which silently defeats hiding.
  const hidesWithAttribute = [...scriptByFile.values()].some((facts) => facts.togglesHiddenAttribute);
  if (hidesWithAttribute) {
    // Name the rule the script actually operates on rather than whichever rule
    // happens to set `display` first, so the hint points at the real fix.
    const queriedClasses = new Set<string>();
    for (const facts of scriptByFile.values()) {
      for (const selector of facts.selectors) {
        for (const token of selectorClassTokens(selector)) queriedClasses.add(token);
      }
    }
    for (const [path, rules] of rulesByFile) {
      const file = css.find((entry) => entry.path === path)!;
      if (!file.generated) continue;
      const handlesHidden = rules.some((rule) => rule.selectors.some((selector) => /\[hidden\]/u.test(selector)));
      if (handlesHidden) continue;
      const laysOut = rules.filter((rule) => {
        const display = rule.declarations.get("display");
        return display !== undefined && !display.startsWith("none");
      });
      // Which element the script hides is a dataflow question this static pass
      // cannot answer, so list the candidates rather than blaming one rule.
      const candidates = laysOut
        .flatMap((rule) => rule.selectors)
        .filter((selector) => selectorClassTokens(subjectCompound(selector)).some((token) => queriedClasses.has(token)));
      const named = (candidates.length > 0 ? candidates : laysOut.flatMap((rule) => rule.selectors)).slice(0, 3);
      if (named.length === 0) continue;
      push(findings, counts, {
        code: "HIDDEN_ATTRIBUTE_OVERRIDDEN",
        severity: "blocking",
        path,
        detail: `A script toggles the hidden attribute, but ${path} has no [hidden] rule while`
          + ` ${named.map((selector) => `"${selector}"`).join(", ")} set an explicit display,`
          + ` so hidden elements still occupy layout. Add a [hidden] { display: none } rule.`,
      });
    }
  }

  // Advisory: markup class that no stylesheet styles.
  if (css.length > 0) {
    for (const file of html) {
      if (!file.generated) continue;
      const facts = htmlByFile.get(file.path)!;
      for (const value of new Set(facts.classes)) {
        if (value.length === 0 || cssSelectorClasses.has(value) || toggledClasses.has(value)) continue;
        push(findings, counts, {
          code: "HTML_CLASS_UNSTYLED",
          severity: "advisory",
          path: file.path,
          detail: `${file.path} uses class "${value}" that no generated stylesheet defines a rule for.`,
        });
      }
    }
  }

  // Advisory: stylesheet rule that no markup or script can ever match.
  if (html.length > 0) {
    for (const file of css) {
      if (!file.generated) continue;
      const facts = cssByFile.get(file.path)!;
      const reported = new Set<string>();
      for (const selector of facts.selectors) {
        for (const token of selectorClassTokens(selector)) {
          if (htmlClasses.has(token) || toggledClasses.has(token) || reported.has(token)) continue;
          reported.add(token);
          push(findings, counts, {
            code: "CSS_SELECTOR_UNUSED",
            severity: "advisory",
            path: file.path,
            detail: `${file.path} styles class "${token}" that no generated markup or script uses.`,
          });
        }
      }
    }
  }

  return findings;
}

/** True when any finding must stop the run before files are written. */
export function hasBlockingFindings(findings: readonly ReferenceFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}

/** Group findings by the file that has to change, for bounded repair. */
export function findingsByPath(
  findings: readonly ReferenceFinding[],
): Map<string, ReferenceFinding[]> {
  const grouped = new Map<string, ReferenceFinding[]>();
  for (const finding of findings) {
    const bucket = grouped.get(finding.path) ?? [];
    bucket.push(finding);
    grouped.set(finding.path, bucket);
  }
  return grouped;
}
