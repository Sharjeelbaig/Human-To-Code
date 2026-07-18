# HTML & CSS support plan

## Status today
The direct converter supports whole-file HTML/CSS generation and inline
single-line or multiline markers in `.html`, `.htm`, and `.css`. HTML comments
use `<!-- @human ... -->`; JavaScript/CSS comments inside `<script>` and
`<style>` are also recognized lexically. The remaining roadmap below is for a
grounded, sandbox-validated `static-web` guided profile. React/Vite workspaces
already cover component markup/styling through the existing node adapter.
Direct ProjectMemory also exposes current and planned sibling CSS/JavaScript
files to an HTML request with exact relative references, then carries accepted
HTML ids/classes/references forward as compact contracts for later CSS and
JavaScript requests. This is generation context, not the link-graph validation
planned below. An optional direct safety net is also available through
`direct.reconcileIntegrations`: the same generic cross-language auditor used for
Python, Rust, JS/TS, and other supported relationships can audit the structured
HTML/CSS/JavaScript edges supplied by ProjectMemory. It defaults off and remains
narrower than the future deterministic complete static-web link graph.

## Target profile
- `Ecosystem`: `static-web`.
- Variant: `static-site` — plain HTML/CSS/vanilla-JS trees (like this
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
pinned versions when the URL encodes one; unpinned CDN URLs are flagged —
the skill pack should push toward pinned or vendored assets.

## Validation plan
- `["npx", "html-validate", "<files>"]` and `["npx", "stylelint", "<files>"]`
  style checks with tools preinstalled in the image; link-graph check
  (internal hrefs resolve) implementable in-process without execution.

## Skill pack
Semantic landmarks, heading order, alt text, `prefers-reduced-motion` and
`prefers-color-scheme` support, no inline event handlers, responsive images
— accessibility is the correctness bar for markup.

## Risks & gates
Third-party `<script src>` additions are supply-chain-sensitive →
elevated-risk, must be pinned and contract-authorized. Inline scripts are
ordinary code and reviewed as such.

## Checklist
0. Add `html`/`css` to `LANGUAGE_PROFILES` (`.html`, `.css`) for the direct path.
1. `Ecosystem` union + `analysis/adapters/static-web.ts`.
2. `static-web/static-site` at `preview`.
3. Skill pack centred on accessibility conventions.
4. Tests: framework-owned trees not double-claimed, CDN pin detection, link-graph checks.
5. Docs updates.
