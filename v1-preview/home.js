/* Gatebrook: cinematic reveal and product-story motion, no scroll-jacking. */
(() => {
  "use strict";

  function start() {
    const site = document.querySelector(".gb-home");
    if (!site) return;

    const reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const steps = [...document.querySelectorAll("[data-gb-step]")];
    const demoStatus = document.getElementById("gbDemoStatus");
    const demoTitle = document.getElementById("gbDemoTitle");
    const demoDetails = document.getElementById("gbDemoDetail");
    const demoNote = document.getElementById("gbDemoNote");
    const demoShell = document.getElementById("gbDemoShell");
    const demoMetrics = document.getElementById("gbDemoMetrics");

    const phases = [
      { status: "New inquiry", name: "A new customer request", detail: "Service requested · moments ago", note: "01 / Capture", progress: "33%", values: ["02", "01", "04"] },
      { status: "Contacted", name: "A conversation in progress", detail: "Follow-up recorded · ready to quote", note: "02 / Organize", progress: "66%", values: ["02", "03", "04"] },
      { status: "Booked", name: "A request moved to booked", detail: "Opportunity advanced · booked", note: "03 / Convert", progress: "100%", values: ["02", "04", "04"] }
    ];

    let active = -1;
    function setPhase(index) {
      if (!Number.isInteger(index) || index < 0 || index >= phases.length || index === active) return;
      active = index;
      const phase = phases[index];
      steps.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
      if (demoStatus) demoStatus.textContent = phase.status;
      if (demoTitle) demoTitle.textContent = phase.name;
      if (demoDetails) demoDetails.textContent = phase.detail;
      if (demoNote) demoNote.textContent = phase.note;
      if (demoShell) demoShell.style.setProperty("--gb-demo-completion", phase.progress);
      if (demoMetrics) {
        [...demoMetrics.querySelectorAll("[data-gb-metric]")].forEach((el, i) => {
          if (phase.values[i]) el.textContent = phase.values[i];
        });
      }
    }

    steps.forEach((button, index) => {
      button.addEventListener("click", () => setPhase(index));
    });
    setPhase(0);

    // The interface remains readable in browsers without observer support.
    if ("IntersectionObserver" in window && !reduceMotion) {
      site.classList.add("gb-motion");
      const revealed = document.querySelectorAll(".gb-reveal");
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      }, { threshold: .08, rootMargin: "0px 0px -5% 0px" });
      revealed.forEach(el => observer.observe(el));

      // The walkthrough responds to scrolling, but its steps remain clickable.
      const storyObserver = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting);
        if (!visible.length) return;
        visible.sort((a,b) => b.intersectionRatio - a.intersectionRatio);
        setPhase(Number(visible[0].target.dataset.gbStep));
      }, { rootMargin: "-12% 0px -42% 0px", threshold: [0,.15,.35,.7] });
      steps.forEach(el => storyObserver.observe(el));
    }

    const scrollProgress = document.getElementById("gbScrollProgress");
    const sculpture = document.querySelector(".gb-hero-sculpture");
    const hero = document.querySelector(".gb-hero");
    let queued = false;

    function updateScroll() {
      queued = false;
      const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const progress = Math.max(0, Math.min(1, window.scrollY / maximum));
      if (scrollProgress) scrollProgress.style.transform = "scaleX(" + progress.toFixed(4) + ")";
      if (sculpture && hero && !reduceMotion) {
        const ratio = Math.max(0, Math.min(1.5, window.scrollY / Math.max(1,hero.offsetHeight)));
        sculpture.style.setProperty("--gb-parallax", (ratio * 94).toFixed(1) + "px");
      }
    }
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(updateScroll);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    updateScroll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();