import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function put(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function cli(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, root, "--compiler", "--yes", "--json"], {
      cwd: dirname(CLI),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function response(request: Record<string, unknown>, content: string): string {
  return JSON.stringify({
    model: typeof request.model === "string" ? request.model : "portfolio-fixture",
    done: true,
    message: { content },
  });
}

test("compiler mode creates a complete multi-page portfolio that works in a browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2c-web-portfolio-"));
  const outputs: Record<string, string> = {
    "index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maya Chen — Product Designer</title><link rel="stylesheet" href="styles.css"></head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><a class="brand" href="index.html">Maya Chen</a><nav aria-label="Primary"><a href="#work">Work</a><a href="#about">About</a><a href="#contact">Contact</a><button id="theme-toggle" type="button" aria-pressed="false">Toggle theme</button></nav></header>
<main id="main"><section class="hero" aria-labelledby="hero-title"><p class="eyebrow">Product designer</p><h1 id="hero-title">Thoughtful products for real people.</h1><p>I turn complex workflows into calm, useful experiences.</p><a class="button" href="#work">See selected work</a></section>
<section id="work" aria-labelledby="work-title"><p class="eyebrow">Selected work</p><h2 id="work-title">A few things I have helped make.</h2><div class="project-grid"><article class="project-card"><h3>Northstar</h3><p>A clearer planning tool for busy teams.</p></article><article class="project-card"><h3>Common Ground</h3><p>A welcoming community experience.</p></article></div></section>
<section id="about" aria-labelledby="about-title"><h2 id="about-title">About Maya</h2><p>I partner with teams from first sketch to final detail.</p></section>
<section id="contact" aria-labelledby="contact-title"><h2 id="contact-title">Let’s work together.</h2><form id="contact-form" novalidate><label for="name">Your name</label><input id="name" name="name" required><label for="email">Your email</label><input id="email" name="email" type="email" required><label for="message">Your message</label><textarea id="message" name="message" required></textarea><button class="button" type="submit">Send hello</button><p id="form-status" role="status" aria-live="polite"></p></form></section></main>
<footer><a href="work.html">View all work</a></footer><script src="script.js" defer></script>
</body></html>`,
    "work.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Work — Maya Chen</title><link rel="stylesheet" href="styles.css"></head>
<body><header class="site-header"><a class="brand" href="index.html">Maya Chen</a><nav aria-label="Primary"><a href="index.html#work">Home</a><a href="index.html#contact">Contact</a></nav></header><main id="main"><section aria-labelledby="all-work-title"><p class="eyebrow">Case studies</p><h1 id="all-work-title">Work with care.</h1><div class="project-grid"><article class="project-card"><h2>Northstar</h2><p>Making planning easier to understand.</p></article><article class="project-card"><h2>Common Ground</h2><p>Designing for belonging at every step.</p></article></div></section></main><footer><a href="index.html">Back home</a></footer><script src="script.js" defer></script></body></html>`,
    "styles.css": `:root { color-scheme: light; --paper: #fffaf3; --ink: #1e1c1a; --accent: #d05a3a; }
:root[data-theme="dark"] { color-scheme: dark; --paper: #1e1c1a; --ink: #fffaf3; --accent: #ff9879; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { max-width: 72rem; margin: 0 auto; padding: 1rem 1.5rem; background: var(--paper); color: var(--ink); font: 1rem/1.6 system-ui, sans-serif; }
.site-header { display: flex; justify-content: space-between; gap: 1rem; align-items: center; padding: 1rem 0; }
.site-header nav { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.brand { color: inherit; font-weight: 700; text-decoration: none; }
.hero { padding: 7rem 0 5rem; max-width: 52rem; }
.project-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.project-card { border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent); border-radius: 1rem; padding: 1.5rem; }
.button { display: inline-block; background: var(--accent); color: white; border: 0; border-radius: 999px; padding: .7rem 1rem; cursor: pointer; }
.skip-link { position: absolute; left: -999px; }
.skip-link:focus, :focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
@media (max-width: 640px) { body { padding: .75rem 1rem; } .site-header { align-items: flex-start; flex-direction: column; } .hero { padding: 4rem 0 3rem; } .project-grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }`,
    "script.js": `const root = document.documentElement;
const themeToggle = document.querySelector("#theme-toggle");
const savedTheme = window.localStorage.getItem("portfolio-theme");
if (savedTheme === "dark") { root.dataset.theme = "dark"; themeToggle?.setAttribute("aria-pressed", "true"); }
themeToggle?.addEventListener("click", () => { const dark = root.dataset.theme !== "dark"; if (dark) root.dataset.theme = "dark"; else delete root.dataset.theme; window.localStorage.setItem("portfolio-theme", dark ? "dark" : "light"); themeToggle.setAttribute("aria-pressed", String(dark)); });
const form = document.querySelector("#contact-form");
const email = document.querySelector("#email");
const status = document.querySelector("#form-status");
form?.addEventListener("submit", (event) => { event.preventDefault(); const value = email?.value.trim() ?? ""; if (!value.includes("@")) { if (status) status.textContent = "Please enter a valid email."; return; } if (status) status.textContent = "Thanks — I will be in touch soon."; form.reset?.(); });`,
  };
  const server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => { body += chunk; });
    incoming.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown> & { messages?: Array<{ role?: string; content?: string }> };
      const system = request.messages?.find((message) => message.role === "system")?.content ?? "";
      const target = system.match(/responsible for exactly one target: ([^\n]+)\./u)?.[1];
      const content = target === undefined ? "" : outputs[target] ?? "";
      outgoing.writeHead(content.length > 0 ? 200 : 400, { "content-type": "application/json" });
      outgoing.end(response(request, content));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await put(root, "human-to-code.config.json", JSON.stringify({
      schemaVersion: 1,
      languages: ["html", "css", "javascript"],
      provider: { name: "ollama", model: "portfolio-fixture", baseUrl: `http://127.0.0.1:${address.port}`, trustCustomEndpoint: true },
      direct: { reconcileIntegrations: false, crossFileChecks: false },
      compiler: { enabled: true, lockfile: false, replayFromLock: false },
    }));
    await put(root, "index.html.human", "Create Maya's complete accessible portfolio home page. Include Work, About, and Contact sections. In the header, place a button labelled \"Toggle theme\" that toggles the dark theme. In the Contact section, place a form whose fields are name, email, and message; email is required and must be valid; submit it to browser-only validation with no network request. Place a button labelled \"Send hello\" in the Contact section and show success or invalid-email text. Use #fffaf3 for the light background and #1e1c1a for the light text.");
    await put(root, "work.html.human", "Create Maya's portfolio case-study page. In the header, place a link labelled \"Home\"; when clicked, navigate to index.html. Also place a link labelled \"Contact\"; when clicked, navigate to index.html#contact. Use styles.css and script.js.");
    await put(root, "styles.css.human", "Create polished responsive portfolio styles using #fffaf3 for the light background, #1e1c1a for the light text, #d05a3a for the accent, and matching dark-theme values. Use a breakpoint below 640px; below 640px stack the project cards and the header. Add keyboard focus outlines and reduced-motion support.");
    await put(root, "script.js.human", "For the button labelled \"Toggle theme\" with id theme-toggle, toggle the dark theme, remember it in localStorage, and update aria-pressed. For the form with id contact-form whose fields are name, email, and message, submit it to browser-only validation with no network request; email must be valid; show Please enter a valid email. for invalid input, show Thanks — I will be in touch soon. for valid input, and clear the fields after success. Use #d05a3a for the success accent.");

    const result = await cli(root);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout) as { written: string[]; codingRequests: number };
    assert.deepEqual(receipt.written.sort(), Object.keys(outputs).sort());
    assert.equal(receipt.codingRequests, 4);

    const html = await readFile(join(root, "index.html"), "utf8");
    const work = await readFile(join(root, "work.html"), "utf8");
    const css = await readFile(join(root, "styles.css"), "utf8");
    const script = await readFile(join(root, "script.js"), "utf8");
    assert.match(html, /<main id="main">/u);
    assert.match(html, /href="styles\.css"/u);
    assert.match(html, /src="script\.js"/u);
    assert.match(html, /id="work"[\s\S]*id="about"[\s\S]*id="contact"/u);
    assert.match(html, /for="email"[\s\S]*id="email"/u);
    assert.match(work, /href="index\.html#contact"/u);
    assert.match(css, /@media \(max-width: 640px\)/u);
    assert.match(css, /prefers-reduced-motion/u);
    assert.match(css, /:focus-visible/u);

    type FakeEvent = { preventDefault: () => void };
    type FakeElement = { value: string; textContent: string; attributes: Record<string, string>; listeners: Record<string, (event?: FakeEvent) => void>; setAttribute: (name: string, value: string) => void; addEventListener: (name: string, callback: (event?: FakeEvent) => void) => void; reset?: () => void };
    const elements = new Map<string, FakeElement>();
    const make = (selector: string): FakeElement => { const item: FakeElement = { value: "", textContent: "", attributes: {}, listeners: {}, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, callback) { this.listeners[name] = callback; } }; elements.set(selector, item); return item; };
    const theme = make("#theme-toggle");
    const input = make("#email");
    const status = make("#form-status");
    const form = make("#contact-form");
    form.reset = () => { input.value = ""; };
    const rootElement = { dataset: {} as Record<string, string> };
    const storage = new Map<string, string>();
    const fakeDocument = { documentElement: rootElement, querySelector: (selector: string) => elements.get(selector) ?? null };
    const fakeWindow = { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } } };
    new Function("document", "window", script)(fakeDocument, fakeWindow);
    theme.listeners.click!();
    assert.equal(rootElement.dataset.theme, "dark");
    assert.equal(storage.get("portfolio-theme"), "dark");
    input.value = "not-an-email";
    status.textContent = "";
    form.listeners.submit!({ preventDefault() {} });
    assert.equal(status.textContent, "Please enter a valid email.");
    input.value = "maya@example.com";
    form.listeners.submit!({ preventDefault() {} });
    assert.equal(status.textContent, "Thanks — I will be in touch soon.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
