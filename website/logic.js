/* human-to-code landing — no frameworks, just the essentials. */
(() => {
  "use strict";
  document.documentElement.classList.add("js");

  /* ---------------- theme ---------------- */
  const root = document.documentElement;
  const stored = localStorage.getItem("h2c-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = (theme) => {
    root.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0d0d11" : "#ffffff");
  };
  applyTheme(stored ?? (prefersDark.matches ? "dark" : "light"));
  prefersDark.addEventListener("change", (event) => {
    if (!localStorage.getItem("h2c-theme")) applyTheme(event.matches ? "dark" : "light");
  });
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("h2c-theme", next);
    applyTheme(next);
  });

  /* ---------------- copy command ---------------- */
  const copyBtn = document.getElementById("copyBtn");
  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("npx human-to-code .");
      copyBtn.classList.add("copied");
      setTimeout(() => copyBtn.classList.remove("copied"), 1200);
    } catch {
      /* clipboard unavailable (e.g. http) — quietly ignore */
    }
  });

  /* ---------------- language marquees ---------------- */
  // Icons come from the devicon CDN; a bubble whose icon fails to load is removed.
  const DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";
  const icon = (slug, file) => `${DEVICON}/${slug}/${file ?? `${slug}-original.svg`}`;

  const LANGS = [
    { name: "JavaScript", src: icon("javascript") },
    { name: "TypeScript", src: icon("typescript") },
    { name: "Python", src: icon("python") },
    { name: "Go", src: icon("go") },
    { name: "Java", src: icon("java") },
    { name: "C#", src: icon("csharp") },
    { name: "Ruby", src: icon("ruby") },
    { name: "PHP", src: icon("php") },
    { name: "Rust", src: icon("rust") },
    { name: "Swift", src: icon("swift") },
    { name: "Kotlin", src: icon("kotlin") },
    { name: "Dart", src: icon("dart") },
    { name: "Bash", src: icon("bash") },
    { name: "SQL", src: icon("mysql") },
    { name: "YAML", src: icon("yaml") },
    { name: "Node.js", src: icon("nodejs") },
    { name: "React", src: icon("react") },
    { name: "NestJS", src: icon("nestjs") },
    { name: "FastAPI", src: icon("fastapi") },
    { name: "Docker", src: icon("docker") },
    { name: "Terraform", src: icon("terraform") },
    { name: "HTML", src: icon("html5") },
    { name: "CSS", src: icon("css3") },
    { name: "Git", src: icon("git") },
  ];

  // Deterministic pseudo-random (index-seeded) so both marquee halves scatter
  // identically and the loop stays seamless.
  const jitter = (seed) => {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x); // 0..1
  };

  const bubble = ({ name, src }, seed) => {
    const item = document.createElement("span");
    item.className = "bubble";
    item.title = name;
    // loose, "unorganized" look: varied size, vertical offset, depth fade, float
    const r1 = jitter(seed + 1);
    const r2 = jitter(seed + 2);
    const r3 = jitter(seed + 3);
    item.style.setProperty("--size", `${Math.round(96 + r1 * 46)}px`);       // 96–142px
    item.style.setProperty("--dy", `${Math.round((r2 - 0.5) * 44)}px`);      // -22..22px
    item.style.setProperty("--fade", (0.55 + r3 * 0.45).toFixed(2));         // some faint
    item.style.setProperty("--float", `${(4 + r1 * 3).toFixed(1)}s`);
    item.style.setProperty("--delay", `${(-r2 * 4).toFixed(1)}s`);
    const circle = document.createElement("span");
    circle.className = "bubble-icon";
    const img = document.createElement("img");
    img.src = src;
    img.alt = name;
    img.width = 56;
    img.height = 56;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => item.remove());
    circle.appendChild(img);
    item.appendChild(circle);
    return item;
  };

  const host = document.getElementById("marquees");
  if (host) {
    const ROWS = 3;
    const perRow = Math.ceil(LANGS.length / ROWS);
    for (let row = 0; row < ROWS; row++) {
      const slice = LANGS.slice(row * perRow, (row + 1) * perRow);
      if (slice.length === 0) continue;

      const marquee = document.createElement("div");
      marquee.className = "marquee";
      // odd rows (1st, 3rd, …) drift left; even rows drift right
      marquee.dataset.direction = row % 2 === 0 ? "left" : "right";

      const track = document.createElement("div");
      track.className = "marquee-track";
      track.style.setProperty("--speed", `${34 + row * 7}s`);

      // two identical halves -> translateX(-50%) loops seamlessly
      for (let copy = 0; copy < 2; copy++) {
        const half = document.createElement("div");
        half.className = "marquee-track"; // reuse flex+gap, but no animation
        half.style.animation = "none";
        half.setAttribute("aria-hidden", copy === 1 ? "true" : "false");
        slice.forEach((lang, i) => half.appendChild(bubble(lang, row * 100 + i)));
        track.appendChild(half);
      }

      marquee.appendChild(track);
      host.appendChild(marquee);
    }
  }

  /* ---------------- playground ---------------- */
  // A faithful browser port of the module's direct path (`generateCode` and
  // `stripCodeFence` in src/pipeline/simple.ts): one request, code-only
  // system contract, temperature 0, fences stripped. The key lives in this
  // closure only — never persisted, sent only to the selected provider.
  const LANGUAGE_LABELS = {
    typescript: "TypeScript", javascript: "JavaScript", python: "Python",
    rust: "Rust", go: "Go", java: "Java", ruby: "Ruby", csharp: "C#",
    cpp: "C++", c: "C",
  };
  const DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "ollama-cloud": "gpt-oss:120b-cloud",
    "ollama-local": "qwen2.5-coder:7b",
  };

  const stripCodeFence = (output) => {
    const trimmed = output.trim();
    const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
    return fenced ? fenced[1].trim() : trimmed;
  };

  const generateCode = async (prompt, { provider, model, apiKey, language, signal }) => {
    const label = LANGUAGE_LABELS[language] ?? language;
    const system = [
      `You are a precise ${label} code generator.`,
      `Convert the user's instruction into correct, self-contained ${label} code.`,
      "Output ONLY code. No explanations, no comments describing what you did, no markdown fences.",
    ].join(" ");
    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];

    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0 }),
        signal,
      });
      if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
      const data = await response.json();
      return stripCodeFence(data.choices?.[0]?.message?.content ?? "");
    }

    const base = provider === "ollama-cloud" ? "https://ollama.com" : "http://localhost:11434";
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider === "ollama-cloud" ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, stream: false, options: { temperature: 0 }, messages }),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return stripCodeFence(data.message?.content ?? "");
  };

  const pgForm = document.getElementById("pgForm");
  if (pgForm) {
    const providerEl = document.getElementById("pgProvider");
    const modelEl = document.getElementById("pgModel");
    const keyField = document.getElementById("pgKeyField");
    const keyEl = document.getElementById("pgKey");
    const langEl = document.getElementById("pgLanguage");
    const promptEl = document.getElementById("pgPrompt");
    const runBtn = document.getElementById("pgRun");
    const statusEl = document.getElementById("pgStatus");
    const outWrap = document.getElementById("pgOutWrap");
    const outEl = document.getElementById("pgOut");
    const copyBtnPg = document.getElementById("pgCopy");

    const setStatus = (text, isError) => {
      statusEl.textContent = text;
      statusEl.classList.toggle("error", Boolean(isError));
    };

    providerEl.addEventListener("change", () => {
      const provider = providerEl.value;
      keyField.hidden = provider === "ollama-local";
      // only swap the model if the user hasn't customized it
      if (Object.values(DEFAULT_MODELS).includes(modelEl.value.trim()) || modelEl.value.trim() === "") {
        modelEl.value = DEFAULT_MODELS[provider];
      }
      setStatus(provider === "ollama-local"
        ? "Local Ollama needs CORS: start it with OLLAMA_ORIGINS=* (key not required)."
        : "");
    });

    pgForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const provider = providerEl.value;
      const apiKey = keyEl.value.trim();
      if (provider !== "ollama-local" && apiKey === "") {
        setStatus("An API key is required for this provider.", true);
        keyEl.focus();
        return;
      }
      runBtn.disabled = true;
      setStatus("Generating…");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const code = await generateCode(promptEl.value.trim(), {
          provider,
          model: modelEl.value.trim(),
          apiKey,
          language: langEl.value,
          signal: controller.signal,
        });
        if (code.length === 0) {
          setStatus("The model returned empty output.", true);
        } else {
          outEl.textContent = code;
          outWrap.hidden = false;
          setStatus("Done — 1 request.");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setStatus(
          detail.includes("Failed to fetch")
            ? `Request blocked or unreachable (network/CORS). ${provider === "ollama-local" ? "Is Ollama running with OLLAMA_ORIGINS set?" : "Check your network."}`
            : detail.slice(0, 300),
          true,
        );
      } finally {
        clearTimeout(timeout);
        runBtn.disabled = false;
      }
    });

    copyBtnPg?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(outEl.textContent ?? "");
        copyBtnPg.textContent = "Copied!";
        setTimeout(() => { copyBtnPg.textContent = "Copy"; }, 1200);
      } catch { /* ignore */ }
    });
  }

  /* ---------------- scroll reveal ---------------- */
  const revealed = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    revealed.forEach((el) => observer.observe(el));
  } else {
    revealed.forEach((el) => el.classList.add("in"));
  }
})();
