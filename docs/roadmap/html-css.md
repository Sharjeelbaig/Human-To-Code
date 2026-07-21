# HTML & CSS support plan

## Status today
The direct converter already handles whole-file HTML/CSS generation plus inline
single-line and multiline markers in `.html`, `.htm`, and `.css`. HTML comments
use `<!-- @human ... -->`, and the JavaScript/CSS comment forms inside
`<script>` and `<style>` are recognized lexically too. React/Vite workspaces get
their component markup and styling covered by the existing node adapter.

ProjectMemory shows an HTML request its current and planned sibling CSS and
JavaScript files with exact relative references, then carries the accepted HTML
ids, classes, and references forward as compact contracts for the CSS and
JavaScript requests that follow. That's generation *context*  -  not the
link-graph validation planned below.

There's also a safety net in `direct.reconcileIntegrations` (on by default): the
same generic cross-language auditor used for Python, Rust, JS/TS, and the other
supported relationships can audit the structured HTML/CSS/JavaScript edges
ProjectMemory supplies. It's still narrower than the deterministic complete
static-web link graph described below.

Everything from here down is about a grounded, sandbox-validated `static-web`
framework profile, which doesn't exist yet.

## Target profile
- `Ecosystem`: `static-web`.
- Variant: `static-site`  -  plain HTML/CSS/vanilla-JS trees (like this
  repo's `website/`), optionally with a recognized static generator config
  (Eleventy, Astro static) as a later variant.
- Signals: `index.html` at a root, no framework manifest claiming the tree.

## Detection signals (static only)
- `index.html` + sibling `*.css`/`*.js` without `package.json` build
  tooling; `<link rel="stylesheet">`/`<script src>` graphs (textual);
  generator configs (`.eleventy.js`, `astro.config.*`) detected but not
  executed.

## Version evidence
CDN dependencies (script/link URLs) are recorded as evidence with their
pinned versions when the URL encodes one; unpinned CDN URLs are flagged  - 
the skill pack should push toward pinned or vendored assets.

## Validation plan
- `["npx", "html-validate", "<files>"]` and `["npx", "stylelint", "<files>"]`
  style checks with tools preinstalled in the image; link-graph check
  (internal hrefs resolve) implementable in-process without execution.

## Skill pack
Semantic landmarks, heading order, alt text, `prefers-reduced-motion` and
`prefers-color-scheme` support, no inline event handlers, responsive images
 -  accessibility is the correctness bar for markup.

## Risks & gates
Third-party `<script src>` additions are supply-chain-sensitive ->
elevated-risk, must be pinned and contract-authorized. Inline scripts are
ordinary code and reviewed as such.

## Checklist
0. Add `html`/`css` to `LANGUAGE_PROFILES` (`.html`, `.css`) for the direct path.
1. `Ecosystem` union + `analysis/adapters/static-web.ts`.
2. `static-web/static-site` at `preview`.
3. Skill pack centred on accessibility conventions.
4. Tests: framework-owned trees not double-claimed, CDN pin detection, link-graph checks.
5. Docs updates.
