import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectReferenceFindings,
  hasBlockingFindings,
  scanCssRules,
  selectorSpecificity,
  type ReferenceFile,
  type ReferenceFindingCode,
} from "../src/tools/validation/reference-validation.ts";

function generated(path: string, content: string): ReferenceFile {
  return { path, content, generated: true };
}

function codes(findings: ReadonlyArray<{ code: ReferenceFindingCode }>): string[] {
  return [...new Set(findings.map((finding) => finding.code))].sort();
}

test("specificity ranks the selector shapes the reveal bug depends on", () => {
  assert.deepEqual(selectorSpecificity(".reveal"), [0, 1, 0]);
  assert.deepEqual(selectorSpecificity(".reveal.is-visible"), [0, 2, 0]);
  assert.deepEqual(selectorSpecificity("html.js-enabled .reveal"), [0, 2, 1]);
  assert.deepEqual(selectorSpecificity("#main .card:hover"), [1, 2, 0]);
  assert.deepEqual(selectorSpecificity("a::before"), [0, 0, 2]);
  assert.deepEqual(selectorSpecificity("input[type=\"text\"]"), [0, 1, 1]);
});

test("rule scanning survives at-rules, comments, and media nesting", () => {
  const rules = scanCssRules(`
    @import "reset.css";
    /* a comment { display:none } */
    .a { color: red; }
    @media (max-width: 600px) { .b { display: none; } }
    .c, .d { opacity: 1 }
  `);
  assert.deepEqual(rules.map((rule) => rule.selectors), [[".a"], [".b"], [".c", ".d"]]);
  assert.equal(rules[0]!.declarations.get("color"), "red");
  assert.equal(rules[2]!.declarations.get("opacity"), "1");
});

test("a reveal class defeated by a higher-specificity hiding rule is blocking", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<section class="hero reveal"><p class="lede">Hi</p></section>'),
    generated("styles.css", [
      ".reveal{opacity:0}",
      "html.js-enabled .reveal{opacity:0}",
      ".reveal.is-visible{opacity:1}",
      ".hero{opacity:1}",
      ".lede{opacity:1}",
    ].join("\n")),
    generated("script.js", "document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));"),
  ]);
  const defeated = findings.filter((finding) => finding.code === "STATE_CLASS_DEFEATED");
  assert.ok(defeated.length > 0, JSON.stringify(findings, null, 2));
  assert.equal(defeated[0]!.severity, "blocking");
  assert.equal(defeated[0]!.path, "styles.css");
  assert.match(defeated[0]!.detail, /html\.js-enabled \.reveal/u);
  assert.match(defeated[0]!.detail, /is-visible/u);
  assert.ok(hasBlockingFindings(findings));
});

test("the corrected progressive-enhancement cascade produces no reveal finding", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<section class="hero reveal"></section>'),
    generated("styles.css", [
      ".reveal{opacity:1}",
      ".js-enabled .reveal{opacity:0}",
      ".js-enabled .reveal.is-visible{opacity:1}",
      ".hero{min-height:40vh}",
    ].join("\n")),
    generated("script.js", "document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));"),
  ]);
  assert.deepEqual(findings.filter((finding) => finding.code === "STATE_CLASS_DEFEATED"), []);
});

test("two rules that both reveal are not reported as a conflict", () => {
  // Regression: `opacity:1 !important` and `opacity:1` differ textually but
  // both reveal. Comparing raw strings reported a working stylesheet as broken.
  const findings = collectReferenceFindings([
    generated("index.html", '<section class="hero reveal"></section>'),
    generated("styles.css", [
      "@media (prefers-reduced-motion:reduce){.reveal{opacity:1 !important;transform:none !important}}",
      ".reveal{opacity:1}",
      ".js-enabled .reveal{opacity:0}",
      ".js-enabled .reveal.is-visible{opacity:1}",
    ].join("\n")),
    generated("script.js", "document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));"),
  ]);
  assert.deepEqual(findings.filter((finding) => finding.code === "STATE_CLASS_DEFEATED"), []);
});

test("an !important hiding rule that outranks the reveal is still caught", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<section class="hero reveal"></section>'),
    generated("styles.css", ".reveal{opacity:0 !important}\n.reveal.is-visible{opacity:1}\n.hero{min-height:40vh}"),
    generated("script.js", "document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));"),
  ]);
  const defeated = findings.filter((finding) => finding.code === "STATE_CLASS_DEFEATED");
  assert.equal(defeated.length, 1, JSON.stringify(findings, null, 2));
});

test("toggling the hidden attribute without a [hidden] rule is blocking", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<article class="project-card"></article>'),
    generated("styles.css", ".project-card{display:flex}"),
    generated("script.js", "cards.forEach(card => { card.hidden = !show; });"),
  ]);
  const hidden = findings.filter((finding) => finding.code === "HIDDEN_ATTRIBUTE_OVERRIDDEN");
  assert.equal(hidden.length, 1, JSON.stringify(findings, null, 2));
  assert.equal(hidden[0]!.severity, "blocking");
  assert.match(hidden[0]!.detail, /still occupy layout/u);
  assert.match(hidden[0]!.detail, /\.project-card/u);
  assert.match(hidden[0]!.detail, /\[hidden\] \{ display: none \}/u);
});

test("a [hidden] rule clears the hidden-attribute finding", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<article class="project-card"></article>'),
    generated("styles.css", ".project-card{display:flex}\n.project-card[hidden]{display:none}"),
    generated("script.js", "cards.forEach(card => { card.hidden = !show; });"),
  ]);
  assert.deepEqual(findings.filter((finding) => finding.code === "HIDDEN_ATTRIBUTE_OVERRIDDEN"), []);
});

test("a script selector with no matching markup is blocking", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<div class="status"></div><div id="year"></div>'),
    generated("styles.css", ".status{color:green}"),
    generated("script.js", [
      "const ok = document.querySelector('.status');",
      "const year = document.getElementById('year');",
      "const gone = document.querySelector('.totals-panel');",
      "const missingId = document.getElementById('theme-toggle');",
    ].join("\n")),
  ]);
  const missing = findings.filter((finding) => finding.code === "JS_SELECTOR_MISSING");
  assert.equal(missing.length, 2, JSON.stringify(missing, null, 2));
  assert.ok(missing.every((finding) => finding.severity === "blocking"));
  assert.ok(missing.some((finding) => /totals-panel/u.test(finding.detail)));
  assert.ok(missing.some((finding) => /theme-toggle/u.test(finding.detail)));
});

test("markup linking an asset the project does not contain is blocking", () => {
  const findings = collectReferenceFindings([
    generated("index.html", [
      '<link rel="stylesheet" href="styles.css">',
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<script src="script.js"></script>',
      '<script src="vendor/missing.js"></script>',
    ].join("\n")),
    generated("styles.css", "body{margin:0}"),
    generated("script.js", "// ok"),
  ]);
  const missing = findings.filter((finding) => finding.code === "HTML_ASSET_MISSING");
  assert.equal(missing.length, 1, JSON.stringify(missing, null, 2));
  assert.match(missing[0]!.detail, /vendor\/missing\.js/u);
});

test("class vocabulary drift between markup and stylesheet is advisory", () => {
  const findings = collectReferenceFindings([
    generated("index.html", '<span class="category-label"></span><ul class="tech-list"></ul>'),
    generated("styles.css", ".category{color:grey}\n.tech-tags{display:flex}"),
  ]);
  const unstyled = findings.filter((finding) => finding.code === "HTML_CLASS_UNSTYLED");
  const unused = findings.filter((finding) => finding.code === "CSS_SELECTOR_UNUSED");
  assert.deepEqual(unstyled.map((finding) => finding.severity), ["advisory", "advisory"]);
  assert.ok(unstyled.some((finding) => /category-label/u.test(finding.detail)));
  assert.ok(unstyled.some((finding) => /tech-list/u.test(finding.detail)));
  assert.ok(unused.some((finding) => /tech-tags/u.test(finding.detail)));
  assert.equal(hasBlockingFindings(findings), false);
});

test("a consistent three-file project produces no findings at all", () => {
  const findings = collectReferenceFindings([
    generated("index.html", [
      '<link rel="stylesheet" href="styles.css">',
      '<main class="page"><button class="toggle" id="theme-toggle">Theme</button></main>',
      '<script src="script.js"></script>',
    ].join("\n")),
    generated("styles.css", ".page{max-width:60rem}\n.toggle{cursor:pointer}\n.toggle.is-active{color:red}"),
    generated("script.js", [
      "const toggle = document.getElementById('theme-toggle');",
      "const page = document.querySelector('.page');",
      "toggle.classList.add('is-active');",
    ].join("\n")),
  ]);
  assert.deepEqual(findings, []);
});

test("pre-existing files are cross-referenced but never reported against", () => {
  const findings = collectReferenceFindings([
    { path: "index.html", content: '<div class="legacy"></div>', generated: false },
    { path: "styles.css", content: ".legacy{color:red}\n.orphan{color:blue}", generated: false },
  ]);
  assert.deepEqual(findings, []);
});

test("a generated stylesheet is checked against untouched existing markup", () => {
  const findings = collectReferenceFindings([
    { path: "index.html", content: '<div class="panel"></div>', generated: false },
    generated("styles.css", ".panel{color:red}\n.ghost{color:blue}"),
  ]);
  const unused = findings.filter((finding) => finding.code === "CSS_SELECTOR_UNUSED");
  assert.equal(unused.length, 1);
  assert.match(unused[0]!.detail, /ghost/u);
});

test("static TSX className values count as generated markup for CSS references", () => {
  const findings = collectReferenceFindings([
    { path: "index.html", content: '<div id="root"></div>', generated: false },
    { path: "Hero.tsx", content: 'export function Hero() { return <div className="hero hero-gradient" />; }', generated: true },
    { path: "hero.css", content: ".hero { position: relative; } .hero-gradient { background: linear-gradient(red, blue); }", generated: true },
  ]);
  assert.equal(findings.some((finding) => finding.code === "CSS_SELECTOR_UNUSED"), false);
});

test("a generated compound selector must match one rendered element", () => {
  const findings = collectReferenceFindings([
    { path: "index.html", content: '<div id="root"></div>', generated: false },
    { path: "Hero.tsx", content: 'export function Hero() { return <div className="hero-container"><div className="hero-gradient" /></div>; }', generated: true },
    { path: "hero.css", content: ".hero-container.hero-gradient { background: linear-gradient(red, blue); }", generated: true },
  ]);
  assert.ok(findings.some((finding) =>
    finding.code === "CSS_COMPOUND_SELECTOR_UNMATCHED" && finding.severity === "blocking"));
});

test("nested ampersand compound selectors are checked against rendered elements", () => {
  const findings = collectReferenceFindings([
    { path: "index.html", content: '<div id="root"></div>', generated: false },
    { path: "Hero.tsx", content: 'export function Hero() { return <div className="hero-container"><div className="hero-gradient" /></div>; }', generated: true },
    { path: "hero.css", content: ".hero-container { &.hero-gradient { background: linear-gradient(red, blue); } }", generated: true },
  ]);
  assert.ok(findings.some((finding) => finding.code === "CSS_COMPOUND_SELECTOR_UNMATCHED"));
});

test("an empty generated visual element needs a real box size", () => {
  const broken = collectReferenceFindings([
    { path: "index.html", content: '<div id="root"></div>', generated: false },
    { path: "Hero.tsx", content: 'export function Hero() { return <div className="hero-gradient" />; }', generated: true },
    { path: "hero.css", content: ".hero-gradient { background: linear-gradient(red, blue); }", generated: true },
  ]);
  assert.ok(broken.some((finding) => finding.code === "EMPTY_VISUAL_ZERO_SIZE" && finding.severity === "blocking"));

  const visible = collectReferenceFindings([
    { path: "index.html", content: '<div id="root"></div>', generated: false },
    { path: "Hero.tsx", content: 'export function Hero() { return <div className="hero-gradient" />; }', generated: true },
    { path: "hero.css", content: ".hero-gradient { position: absolute; inset: 0; background: linear-gradient(red, blue); }", generated: true },
  ]);
  assert.equal(visible.some((finding) => finding.code === "EMPTY_VISUAL_ZERO_SIZE"), false);
});

test("findings are bounded and single-line", () => {
  const classes = Array.from({ length: 40 }, (_, index) => `<div class="drift-${index}"></div>`).join("");
  const findings = collectReferenceFindings([
    generated("index.html", classes),
    generated("styles.css", ".unrelated{color:red}"),
  ]);
  const unstyled = findings.filter((finding) => finding.code === "HTML_CLASS_UNSTYLED");
  assert.equal(unstyled.length, 12);
  assert.ok(findings.every((finding) => !finding.detail.includes("\n")));
  assert.ok(findings.every((finding) => finding.detail.length <= 220));
});

test("codes present on the real fixture shape are exactly the expected set", () => {
  const findings = collectReferenceFindings([
    generated("index.html", [
      '<link rel="stylesheet" href="styles.css">',
      '<section class="hero reveal"></section>',
      '<article class="project-card reveal"><span class="category-label"></span></article>',
      '<script src="script.js"></script>',
    ].join("\n")),
    generated("styles.css", [
      ".reveal{opacity:0}",
      "html.js-enabled .reveal{opacity:0}",
      ".reveal.is-visible{opacity:1}",
      ".hero{min-height:80vh}",
      ".project-card{display:flex}",
      ".tech-tags{display:flex}",
    ].join("\n")),
    generated("script.js", [
      "document.documentElement.classList.add('js-enabled');",
      "document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));",
      "cards.forEach(card => { card.hidden = !show; });",
    ].join("\n")),
  ]);
  assert.deepEqual(codes(findings), [
    "CSS_SELECTOR_UNUSED",
    "HIDDEN_ATTRIBUTE_OVERRIDDEN",
    "HTML_CLASS_UNSTYLED",
    "STATE_CLASS_DEFEATED",
  ]);
});
