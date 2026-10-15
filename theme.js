/* Shared Gatebrook sun/moon theme toggle. No account or backend changes. */
(() => {
  "use strict";
  const KEY = "gatebrook-theme-v1";
  const root = document.documentElement;
  const normalize = value => value === "light" ? "light" : "dark";
  let theme = "dark";

  try {
    theme = normalize(localStorage.getItem(KEY));
  } catch (_) {
    // Browsers that block storage can still toggle during this visit.
  }

  const apply = value => {
    theme = normalize(value);
    root.setAttribute("data-gb-theme", theme);
    root.style.colorScheme = theme;
    const button = document.getElementById("gbThemeToggle");
    if (button) {
      const next = theme === "dark" ? "light" : "dark";
      button.setAttribute("aria-label", "Switch to " + next + " mode");
      button.setAttribute("title", "Switch to " + next + " mode");
      button.setAttribute("aria-pressed", String(theme === "light"));
      const label = button.querySelector(".gb-theme-label");
      if (label) label.textContent = next === "light" ? "Light mode" : "Dark mode";
    }
  };

  // Run before the DOM is rendered to avoid a bright/dark flash on navigation.
  apply(theme);

  const mount = () => {
    if (!document.body || document.getElementById("gbThemeToggle")) return;
    const button = document.createElement("button");
    button.id = "gbThemeToggle";
    button.type = "button";
    button.className = "gb-theme-toggle";
    button.innerHTML =
      '<svg class="gb-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>' +
      '<svg class="gb-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 14.7A8.7 8.7 0 0 1 9.3 3.6 8.7 8.7 0 1 0 20.4 14.7Z"/></svg>' +
      '<span class="gb-theme-label"></span>';
    button.addEventListener("click", () => {
      const next = theme === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(KEY, next);
      } catch (_) {}
    });
    document.body.appendChild(button);
    apply(theme);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  window.addEventListener("storage", event => {
    if (event.key === KEY) apply(event.newValue);
  });
})();
