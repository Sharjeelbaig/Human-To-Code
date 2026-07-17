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

  /* ---------------- live GitHub stars ---------------- */
  const githubPill = document.getElementById("githubPill");
  const githubMetric = document.getElementById("githubMetric");
  if (githubPill && githubMetric) {
    fetch("https://api.github.com/repos/sharjeelbaig/human-to-code", {
      headers: { accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error("GitHub stars unavailable");
        return response.json();
      })
      .then((repository) => {
        const stars = repository?.stargazers_count;
        if (!Number.isSafeInteger(stars) || stars < 0) return;
        githubMetric.textContent = new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(stars).toLowerCase();
        githubPill.dataset.starsLoaded = "true";
        githubPill.setAttribute("aria-label", `View human-to-code on GitHub — ${stars.toLocaleString("en")} stars`);
      })
      .catch(() => {
        /* Keep the GitHub + star fallback when the public API is unavailable. */
      });
  }

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

  /* ---------------- hero editor language tabs ---------------- */
  const demoTabs = [...document.querySelectorAll("[data-demo-tab]")];
  const demoPanels = [...document.querySelectorAll("[data-demo-panel]")];
  const activateDemo = (language) => {
    demoTabs.forEach((tab) => {
      const active = tab.dataset.demoTab === language;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    demoPanels.forEach((panel) => {
      const active = panel.dataset.demoPanel === language;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    });
  };

  demoTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateDemo(tab.dataset.demoTab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = demoTabs[(index + direction + demoTabs.length) % demoTabs.length];
      activateDemo(next.dataset.demoTab);
      next.focus();
    });
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

  /* ---------------- quick start ---------------- */
  const qs = document.getElementById("quickstart");
  if (qs) {
    const providerTrigger = document.getElementById("qsProvider");
    const providerOptions = document.getElementById("qsProviderOptions");
    const providerChoices = [...qs.querySelectorAll("[data-provider-option]")];
    const providerLogos = {
      ollama: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/ollama.svg",
      openai: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
    };
    const providerLabels = {
      ollama: "Ollama — local and free (recommended)",
      openai: "OpenAI — remote",
    };

    const applyProvider = (provider) => {
      qs.querySelectorAll("[data-provider]").forEach((el) => {
        el.hidden = el.dataset.provider !== provider;
      });
      // renumber the shared "Generate" step (5 for ollama, 6 for openai)
      qs.querySelectorAll("[data-step-ollama]").forEach((el) => {
        el.textContent = provider === "openai" ? el.dataset.stepOpenai : el.dataset.stepOllama;
      });
      providerChoices.forEach((choice) => {
        choice.setAttribute("aria-selected", String(choice.dataset.providerOption === provider));
      });
      providerTrigger?.setAttribute("aria-label", providerLabels[provider]);
      providerTrigger?.querySelector(".qs-provider-logo")?.setAttribute("src", providerLogos[provider]);
    };

    const closeProviderMenu = () => {
      if (!providerOptions) return;
      providerOptions.hidden = true;
      providerTrigger?.setAttribute("aria-expanded", "false");
    };
    const openProviderMenu = () => {
      if (!providerOptions) return;
      providerOptions.hidden = false;
      providerTrigger?.setAttribute("aria-expanded", "true");
    };
    providerTrigger?.addEventListener("click", () => {
      if (providerOptions?.hidden) openProviderMenu(); else closeProviderMenu();
    });
    providerChoices.forEach((choice) => {
      choice.addEventListener("click", () => {
        applyProvider(choice.dataset.providerOption);
        closeProviderMenu();
        providerTrigger?.focus();
      });
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("[data-provider-dropdown]")) closeProviderMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && providerOptions && !providerOptions.hidden) {
        closeProviderMenu();
        providerTrigger?.focus();
      }
    });

    // Keep Ollama as the recommended provider.
    applyProvider("ollama");
  }

  /* ---------------- examples tabs ---------------- */
  const exTabs = document.querySelectorAll(".ex-tab");
  const exPanels = document.querySelectorAll(".ex-panel");
  exTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      exTabs.forEach((t) => t.classList.remove("active"));
      exPanels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`ex-${target}`)?.classList.add("active");
    });
  });

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
