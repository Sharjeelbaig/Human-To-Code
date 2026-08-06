const root = document.documentElement;
const themeToggle = document.querySelector("#theme-toggle");
const savedTheme = window.localStorage.getItem("portfolio-theme");

function setTheme(theme) {
  if (theme === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  themeToggle?.setAttribute("aria-pressed", String(theme === "dark"));
  window.localStorage.setItem("portfolio-theme", theme);
}

if (savedTheme === "dark") setTheme("dark");
themeToggle?.addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark"));

const form = document.querySelector("#contact-form");
const email = document.querySelector("#email");
const status = document.querySelector("#form-status");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = email?.value.trim() ?? "";
  if (!value.includes("@")) {
    if (status) status.textContent = "Please enter a valid email.";
    return;
  }
  if (status) status.textContent = "Thanks — I will be in touch soon.";
  form.reset?.();
});
