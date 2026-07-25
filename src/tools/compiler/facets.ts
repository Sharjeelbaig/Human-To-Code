/**
 * Pure, bounded predicates used by compiler-mode requirement rules.
 *
 * They are intentionally generous: rejecting a sufficiently specific request
 * is more disruptive than allowing one uncommon ambiguous phrasing through.
 */

export interface FacetContext {
  /** Lower-cased project terms declared in `compiler.vocabulary`. */
  vocabulary: ReadonlySet<string>;
}

export type FacetDetector = (
  instruction: string,
  context: FacetContext,
) => boolean;

const MAX_INSTRUCTION_CHARS = 32_000;
const NUMBER_WORD =
  String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b`;
const CSS_COLOR_NAMES = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
  "bisque", "black", "blue", "brown", "coral", "crimson", "cyan",
  "fuchsia", "gold", "gray", "green", "grey", "indigo", "ivory", "khaki",
  "lavender", "lime", "magenta", "maroon", "navy", "olive", "orange",
  "orchid", "pink", "plum", "purple", "red", "salmon", "silver", "tan",
  "teal", "tomato", "transparent", "turquoise", "violet", "white", "yellow",
] as const;
const COLOR_TOKEN = new RegExp(
  [
    String.raw`#[0-9a-f]{3,8}\b`,
    String.raw`\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\s*\(`,
    String.raw`\bvar\s*\(\s*--[a-z0-9_-]+`,
    String.raw`(?<![a-z0-9_-])(?:${CSS_COLOR_NAMES.join("|")})(?![a-z0-9_-])`,
  ].join("|"),
  "giu",
);

function bounded(instruction: string): string {
  return instruction.slice(0, MAX_INSTRUCTION_CHARS);
}

function containsVocabulary(
  instruction: string,
  context: FacetContext,
): boolean {
  const normalized = bounded(instruction).toLocaleLowerCase();
  for (const term of context.vocabulary) {
    if (term.length > 0 && normalized.includes(term)) return true;
  }
  return false;
}

function colorMatches(
  instruction: string,
  context: FacetContext,
): string[] {
  const matches: string[] = [
    ...(bounded(instruction).match(COLOR_TOKEN) ?? []),
  ];
  for (const term of context.vocabulary) {
    if (
      term.length > 0
      && bounded(instruction).toLocaleLowerCase().includes(term)
    ) {
      matches.push(term);
    }
  }
  return matches;
}

export const hasColor: FacetDetector = (instruction, context) =>
  colorMatches(instruction, context).length > 0;

export const hasColorList: FacetDetector = (instruction, context) =>
  new Set(colorMatches(instruction, context).map((item) => item.toLowerCase()))
    .size >= 2;

export const hasDirectionOrAngle: FacetDetector = (instruction) =>
  /\b(?:-?(?:\d+(?:\.\d+)?)deg|to\s+(?:top|bottom|left|right)(?:\s+(?:top|bottom|left|right))?|left\s+to\s+right|right\s+to\s+left|top\s+to\s+bottom|bottom\s+to\s+top|horizontal(?:ly)?|vertical(?:ly)?|clockwise|counter-?clockwise)\b/iu
    .test(bounded(instruction));

export const hasCount: FacetDetector = (instruction) =>
  new RegExp(String.raw`\b\d+\b|${NUMBER_WORD}`, "iu")
    .test(bounded(instruction));

export const hasUnitValue: FacetDetector = (instruction) =>
  /\b\d+(?:\.\d+)?\s*(?:px|rem|em|ch|vw|vh|vmin|vmax|%|ms|s|minutes?|seconds?|milliseconds?|bytes?|kb|mb|gb|requests?)\b/iu
    .test(bounded(instruction));

export const hasEnumeratedList: FacetDetector = (instruction) =>
  /(?:^|\n)\s*[-*]\s+\S/u.test(bounded(instruction))
  || /\b[\w.-]+\s*,\s*[\w.-]+(?:\s*,\s*|\s*,?\s+and\s+)[\w.-]+\b/iu
    .test(bounded(instruction));

export const hasNamedTarget: FacetDetector = (instruction) =>
  /(?:^|[\s(])(?:\.[a-z_][\w-]*|#(?![0-9a-f]{3,8}(?![0-9a-z_-]))[a-z_][\w-]*|["'`][^"'`\n]{1,80}["'`])(?:\b|$)/iu
    .test(bounded(instruction))
  || /\b(?:on|in|inside|within|for|under|above|below|after|before|next to|applies? to|target(?:ing)?)\s+(?:the\s+)?[a-z][\w-]*(?:\s+(?:section|element|component|page|screen|panel|card|header|footer|hero|nav|navbar|sidebar|container|field|button|link))?\b/iu
    .test(bounded(instruction))
  || /\bthe\s+(?:header|footer|hero|navbar|nav|sidebar|page|screen|panel|card|container|component|section|button|link|field)\b/iu
    .test(bounded(instruction));

export const hasHttpMethod: FacetDetector = (instruction) =>
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu
    .test(bounded(instruction));

export const hasPath: FacetDetector = (instruction) =>
  /(?:^|[\s"'`])\/(?:api\/)?[a-z0-9_:{}/.-]+(?:\b|$)/iu
    .test(bounded(instruction))
  || /\bapi\/[a-z0-9_:{}/.-]+\b/iu.test(bounded(instruction));

export const hasIdentifierList: FacetDetector = (instruction) =>
  hasEnumeratedList(instruction, { vocabulary: new Set() })
  || /\b(?:columns?|fields?|properties?|keys?|labels?|series|axes)\s*(?::|are|include|named|called)\s+[a-z_][\w.-]*(?:\s*(?:,|and)\s*[a-z_][\w.-]*)+/iu
    .test(bounded(instruction));

export const hasDataSource: FacetDetector = (instruction) =>
  /\b(?:from|using|loaded from|fetched from|read from|backed by|based on)\s+(?:the\s+)?(?:[a-z_][\w.-]*\s+)?(?:api|endpoint|database|table|query|array|list|file|state|store|props?|response|dataset|csv|json)\b/iu
    .test(bounded(instruction))
  || /\bhttps?:\/\/\S+/iu.test(bounded(instruction));

export const hasLabelText: FacetDetector = (instruction) =>
  /\b(?:label(?:led)?|text|says?|caption|titled?)\s+(?:is|as|with|to)?\s*["'`][^"'`\n]{1,100}["'`]/iu
    .test(bounded(instruction))
  || /\b(?:button|link)\s+["'`][^"'`\n]{1,100}["'`]/iu
    .test(bounded(instruction));

export const hasAction: FacetDetector = (instruction) =>
  /\b(?:on|when)\s+(?:it\s+is\s+)?(?:click|clicked|submit|submitted|press|pressed|tap|tapped|change|changed|hover|focus)\b/iu
    .test(bounded(instruction))
  || /\b(?:navigate|redirect|open|close|toggle|submit|save|delete|download|upload|call|invoke|run|copy)\b/iu
    .test(bounded(instruction));

export const hasChartType: FacetDetector = (instruction) =>
  /\b(?:bar|line|area|pie|donut|doughnut|scatter|bubble|radar|histogram|candlestick|heatmap|treemap|waterfall|funnel|gauge)\s+(?:chart|graph)\b/iu
    .test(bounded(instruction));

export const hasDuration: FacetDetector = (instruction) =>
  /\b\d+(?:\.\d+)?\s*(?:ms|s|milliseconds?|seconds?|minutes?)\b/iu
    .test(bounded(instruction));

export const hasEasing: FacetDetector = (instruction) =>
  /\b(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\s*\([^)]{1,100}\)|steps\s*\([^)]{1,100}\))\b/iu
    .test(bounded(instruction));

export const hasTrigger: FacetDetector = (instruction) =>
  /\b(?:on|when|after|before|while)\s+(?:load|mount|click|hover|focus|scroll|submit|change|enter|leave|visible|opening|closing|pressed|tapped)\b/iu
    .test(bounded(instruction));

export const hasProperty: FacetDetector = (instruction) =>
  /\b(?:opacity|color|background|transform|translate|scale|rotate|height|width|position|margin|padding|border|shadow|filter|element|card|button|panel|modal|menu|image|text)\b/iu
    .test(bounded(instruction));

export const hasValidation: FacetDetector = (instruction) =>
  /\b(?:required|optional|validate|validation|valid|invalid|min(?:imum)?|max(?:imum)?|pattern|format|email|url|phone|length)\b/iu
    .test(bounded(instruction));

export const hasSubmitTarget: FacetDetector = (instruction) =>
  /\b(?:submit|send|post|save)\s+(?:it|the\s+(?:form|data|values?))?\s*(?:to|via|using)\s+\S+/iu
    .test(bounded(instruction));

export const hasRequestShape: FacetDetector = (instruction) =>
  /\b(?:request\s+body|request|body|payload|query|params?|parameters?|headers?)\s*(?:is|are|with|contains?|containing|includes?|including|:)\s+\S+/iu
    .test(bounded(instruction))
  || /\bno\s+(?:request\s+)?body\b/iu.test(bounded(instruction));

export const hasResponseShape: FacetDetector = (instruction) =>
  /\b(?:responds?|returns?|response)\s+(?:(?:with|is|are|contains?|includes?|:)\s+)?\S+/iu
    .test(bounded(instruction));

export const hasErrors: FacetDetector = (instruction) =>
  /\b(?:error|errors|failure|failures|status\s+(?:4\d\d|5\d\d)|not found|unauthorized|forbidden|invalid)\b/iu
    .test(bounded(instruction))
  || /\bno\s+(?:special\s+)?errors?\b/iu.test(bounded(instruction));

export const hasItemContent: FacetDetector = (instruction) =>
  /\b(?:each|every)\s+(?:item|card|row|entry)\s+(?:shows?|contains?|includes?|has|renders?)\b/iu
    .test(bounded(instruction))
  || hasIdentifierList(instruction, { vocabulary: new Set() });

export const hasSortKey: FacetDetector = (instruction) =>
  /\b(?:sort|order(?:ed)?)\s+(?:the\s+\w+\s+)?(?:by|on|using)\s+[a-z_][\w.-]*\b/iu
    .test(bounded(instruction))
  || /\bsort(?:ed|ing)?\s+(?:the\s+)?(?:arrays?|lists?|vectors?|values?|numbers?|items?|elements?)(?:\s+[a-z_][\w.-]*)?\b/iu
    .test(bounded(instruction));

export const hasSortDirection: FacetDetector = (instruction) =>
  /\b(?:ascending|descending|asc|desc|lowest\s+to\s+highest|highest\s+to\s+lowest|a\s+to\s+z|z\s+to\s+a|newest\s+first|oldest\s+first)\b/iu
    .test(bounded(instruction));

export const hasBreakpoint: FacetDetector = (instruction) =>
  /\b(?:min-width|max-width)\s*:\s*\d+(?:\.\d+)?(?:px|rem|em)\b/iu
    .test(bounded(instruction))
  || /\b(?:at|below|above|under|over|from)\s+\d+(?:\.\d+)?\s*(?:px|rem|em)\b/iu
    .test(bounded(instruction));

export const hasResponsiveChange: FacetDetector = (instruction) =>
  /\b(?:at|below|above|under|over|from)\s+\d+(?:\.\d+)?\s*(?:px|rem|em)\b[\s\S]{0,180}\b(?:hid(?:e|den)|show(?:n|ing)?|stack(?:ed|ing)?|wrapp?(?:ed|ing)?|collaps(?:e|ed|ing)|expand(?:ed|ing)?|resiz(?:e|ed|ing)|switch(?:ed|ing)?|chang(?:e|ed|ing)|become|columns?|rows?)\b/iu
    .test(bounded(instruction))
  || /\b(?:hide|show|stack|wrap|collapse|expand|resize|switch|change)\b[\s\S]{0,180}\b(?:mobile|tablet|desktop|breakpoint)\b/iu
    .test(bounded(instruction));

export const hasFontFamily: FacetDetector = (instruction, context) =>
  /\b(?:font-family|typeface|font)\s*(?::|is|to|using|use)?\s*["'`]?[a-z][a-z0-9 -]{1,60}["'`]?(?:\s*,|\s+font|\s+typeface|$)/iu
    .test(bounded(instruction))
  || containsVocabulary(instruction, context);

export const hasFontSize: FacetDetector = (instruction) =>
  /\b\d+(?:\.\d+)?\s*(?:px|rem|em|pt)\b/iu.test(bounded(instruction));

export const hasFontWeight: FacetDetector = (instruction) =>
  /\b(?:thin|extra-light|light|normal|regular|medium|semi-?bold|bold|extra-?bold|black|[1-9]00)\b/iu
    .test(bounded(instruction));

export const hasNamedValue: FacetDetector = (instruction, context) =>
  containsVocabulary(instruction, context)
  || /["'`][^"'`\n]{1,100}["'`]/u.test(bounded(instruction))
  || hasUnitValue(instruction, context);
