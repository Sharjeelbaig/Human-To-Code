/**
 * Deterministic output-language inference for `.human` files.
 *
 * When an operator configures more than one target language, a bare
 * `styles.human` must not silently inherit the primary language — that is what
 * turns a website request into four TypeScript files. Inference is signal
 * based and never a model call, so the receipt shown before confirmation is
 * reproducible: an explicit language named in the request wins, then filename
 * convention, then request vocabulary. No signal keeps the primary language.
 */

/** An unambiguous language name in the request text, e.g. "in html". */
const EXPLICIT_MENTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["typescript", /\btypescript\b|\bts\b/u],
  ["javascript", /\bjavascript\b|\bvanilla\s+js\b|\bes6\b|\bjs\b/u],
  ["html", /\bhtml5?\b|\bmarkup\b/u],
  ["css", /\bcss3?\b|\bstylesheet\b/u],
  ["python", /\bpython\b/u],
  ["rust", /\brust\b/u],
];

/**
 * Filename stems that conventionally belong to one language. `index` is
 * deliberately absent: `index.html` and `index.ts` are equally idiomatic, so
 * that name is decided by the request text instead.
 */
const STEM_CONVENTIONS: Readonly<Record<string, RegExp>> = {
  html: /^(?:home|homepage|page|landing|about|contact|layout|header|footer|nav|navbar|sidebar|template|markup)$/u,
  css: /^(?:style|styles|styling|stylesheet|stylesheets|theme|themes|reset|typography|palette)$/u,
  javascript: /^(?:script|scripts|app|client|bundle|main)$/u,
  typescript: /^(?:script|scripts|app|client|bundle|main)$/u,
  python: /^(?:main|app|script|scripts)$/u,
  rust: /^(?:main|lib)$/u,
};

/** Request vocabulary that leans toward one language without naming it. */
const VOCABULARY: Readonly<Record<string, RegExp>> = {
  html: /\b(?:page|webpage|web\s+page|homepage|landing|section|hero|navbar|nav\s+bar|heading|headings|form|button|buttons|input|document|structure|semantic|div|body|head|meta\s+tags?|anchor|links?|lists?|tables?|accessib\w*|aria|seo|boilerplate|skeleton|layout)\b/gu,
  css: /\b(?:styles?|styling|colou?rs?|fonts?|typography|spacing|padding|margins?|background|gradients?|shadows?|borders?|radius|responsive|media\s+quer\w+|breakpoints?|flexbox|flex|grid|animations?|transitions?|hover|dark\s+(?:mode|theme)|light\s+(?:mode|theme)|palette|themes?|centered|align\w*)\b/gu,
  javascript: /\b(?:functions?|classes|class|handlers?|event\s+listeners?|listeners?|clicks?|fetch|api|async|await|promises?|variables?|const|let|return|algorithm|calculate|calculation|logic|sort|arrays?|objects?|modules?|export|import|states?|validate|validation|parse|loop|loops)\b/gu,
  typescript: /\b(?:functions?|classes|class|interfaces?|types?|generics?|handlers?|event\s+listeners?|listeners?|clicks?|fetch|api|async|await|promises?|variables?|const|let|return|algorithm|calculate|calculation|logic|sort|arrays?|objects?|modules?|export|import|states?|validate|validation|parse|loop|loops)\b/gu,
  python: /\b(?:functions?|classes|class|def|dict|dicts|lists?|tuples?|scripts?|api|async|await|algorithm|calculate|calculation|logic|sort|parse|loop|loops)\b/gu,
  rust: /\b(?:functions?|structs?|traits?|enums?|impl|modules?|crates?|ownership|borrow\w*|algorithm|calculate|calculation|logic|sort|parse|loop|loops)\b/gu,
};

const EXPLICIT_WEIGHT = 6;
const STEM_WEIGHT = 3;
const MAX_VOCABULARY_SCORE = 4;

function countMatches(pattern: RegExp, text: string): number {
  // Each language's vocabulary pattern is global; reset lastIndex so repeated
  // inference calls cannot inherit a previous match position.
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

function scoreLanguage(language: string, stem: string, request: string): number {
  let score = 0;
  const explicit = EXPLICIT_MENTIONS.find(([name]) => name === language)?.[1];
  if (explicit?.test(request)) score += EXPLICIT_WEIGHT;
  if (STEM_CONVENTIONS[language]?.test(stem)) score += STEM_WEIGHT;
  const vocabulary = VOCABULARY[language];
  if (vocabulary) score += Math.min(countMatches(vocabulary, request), MAX_VOCABULARY_SCORE);
  return score;
}

/**
 * Choose the output language for one `.human` request. `configured` is the
 * operator's list with the primary first; ties resolve toward the earlier
 * entry, so the primary language always wins an inconclusive comparison.
 */
export function inferUnitLanguage(
  fileStem: string,
  request: string,
  configured: readonly string[],
): string {
  const primary = configured[0] ?? "typescript";
  if (configured.length < 2) return primary;

  const stem = fileStem.trim().toLowerCase();
  const text = request.toLowerCase();
  let best = primary;
  let bestScore = 0;
  for (const language of configured) {
    const score = scoreLanguage(language, stem, text);
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : primary;
}
