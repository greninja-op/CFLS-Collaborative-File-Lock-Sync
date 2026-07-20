(() => {
  "use strict";

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  function initReveals() {
    const items = Array.from(document.querySelectorAll("[data-reveal]"));
    if (items.length === 0) return;

    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -7% 0px", threshold: 0.08 },
    );

    items.forEach((item) => {
      item.classList.add("reveal-ready");
      observer.observe(item);
    });
  }

  function initMobileMenu() {
    const toggle = document.querySelector(".menu-toggle");
    const menu = document.querySelector("#mobile-menu");
    if (
      !(toggle instanceof HTMLButtonElement) ||
      !(menu instanceof HTMLElement)
    )
      return;

    const setMenuOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("is-open", open);
      menu.hidden = !open;
    };

    toggle.addEventListener("click", () => {
      setMenuOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    menu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setMenuOpen(false));
    });
  }

  function initInstallTabs() {
    const tabs = Array.from(document.querySelectorAll("[data-install-tab]"));
    const panels = Array.from(
      document.querySelectorAll("[data-install-panel]"),
    );
    if (tabs.length === 0 || panels.length === 0) return;

    const select = (key, focus = false) => {
      tabs.forEach((tab) => {
        const isSelected = tab.getAttribute("data-install-tab") === key;
        tab.classList.toggle("is-active", isSelected);
        tab.setAttribute("aria-selected", String(isSelected));
        if (isSelected && focus) {
          tab.focus();
        }
      });

      panels.forEach((panel) => {
        const isSelected = panel.getAttribute("data-install-panel") === key;
        panel.classList.toggle("is-active", isSelected);
        panel.hidden = !isSelected;
      });
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () =>
        select(tab.getAttribute("data-install-tab")),
      );
      tab.addEventListener("keydown", (event) => {
        if (
          ![
            "ArrowDown",
            "ArrowUp",
            "ArrowRight",
            "ArrowLeft",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        event.preventDefault();

        let nextIndex = index;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (event.key === "ArrowDown" || event.key === "ArrowRight")
          nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowUp" || event.key === "ArrowLeft")
          nextIndex = (index - 1 + tabs.length) % tabs.length;

        const nextTab = tabs[nextIndex];
        select(nextTab.getAttribute("data-install-tab"), true);
      });
    });
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall through to the legacy clipboard route.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    textarea.remove();
    return copied;
  }

  function initCopyButtons() {
    const status = document.querySelector("#copy-status");
    document.querySelectorAll("[data-copy]").forEach((button) => {
      if (!(button instanceof HTMLButtonElement)) return;
      const originalText = button.textContent || "Copy";

      button.addEventListener("click", async () => {
        const copied = await copyText(button.getAttribute("data-copy") || "");
        if (copied) {
          button.textContent = "Copied";
          button.classList.add("is-copied");
          if (status) status.textContent = "Command copied to clipboard.";
        } else {
          button.textContent = "Copy failed";
          if (status)
            status.textContent =
              "Could not copy the command. Select it and copy manually.";
        }

        window.setTimeout(() => {
          button.textContent = originalText;
          button.classList.remove("is-copied");
        }, 1600);
      });
    });
  }

  function initDemo() {
    const canvas = document.querySelector("#demo-canvas");
    const copy = document.querySelector("#demo-copy");
    const play = document.querySelector("#demo-play");
    const steps = Array.from(document.querySelectorAll("[data-demo-step]"));
    const bobStatus = canvas?.querySelector(".demo-bob-status");

    if (
      !(canvas instanceof HTMLElement) ||
      !(copy instanceof HTMLElement) ||
      !(play instanceof HTMLButtonElement) ||
      steps.length === 0
    ) {
      return;
    }

    const messages = [
      "Both teammates are online and looking at the same repository.",
      "Alice starts editing payments.ts. Her local Agent now has a coordination signal to share.",
      "The Host receives the signed activity metadata and updates the shared coordination state.",
      "Bob sees that payments.ts is active before he begins overlapping work.",
      "Bob changes course or coordinates with Alice. Git can stay focused on the code, not a surprise collision.",
    ];

    let step = 0;
    let playbackId = 0;

    const applyStep = (nextStep) => {
      step = Math.max(0, Math.min(nextStep, messages.length - 1));
      canvas.dataset.step = String(step);
      canvas.classList.toggle("is-alice-editing", step >= 1);
      canvas.classList.toggle("is-host-signaled", step >= 2);
      canvas.classList.toggle("is-bob-aware", step >= 3);
      canvas.classList.toggle("is-bob-safe", step >= 4);
      copy.textContent = messages[step];

      if (bobStatus instanceof HTMLElement) {
        bobStatus.textContent =
          step >= 4
            ? "Safe next move"
            : step >= 3
              ? "1 file in play"
              : "No files in play";
      }

      steps.forEach((button) => {
        const isCurrent =
          Number(button.getAttribute("data-demo-step")) === step;
        button.classList.toggle("is-active", isCurrent);
        button.setAttribute("aria-selected", String(isCurrent));
      });
    };

    steps.forEach((button) => {
      button.addEventListener("click", () => {
        playbackId += 1;
        applyStep(Number(button.getAttribute("data-demo-step")));
      });

      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const current = Number(button.getAttribute("data-demo-step"));
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? steps.length - 1
              : event.key === "ArrowLeft"
                ? Math.max(0, current - 1)
                : Math.min(steps.length - 1, current + 1);
        playbackId += 1;
        applyStep(next);
        const focused = steps[next];
        if (focused instanceof HTMLButtonElement) focused.focus();
      });
    });

    play.addEventListener("click", async () => {
      playbackId += 1;
      const thisPlayback = playbackId;
      play.disabled = true;
      play.querySelector("span").textContent = "Playing...";
      applyStep(0);

      if (prefersReducedMotion) {
        applyStep(4);
      } else {
        for (let nextStep = 1; nextStep < messages.length; nextStep += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1250));
          if (thisPlayback !== playbackId) {
            play.disabled = false;
            play.querySelector("span").textContent = "Replay walkthrough";
            return;
          }
          applyStep(nextStep);
        }
      }

      if (thisPlayback === playbackId) {
        play.disabled = false;
        play.querySelector("span").textContent = "Replay walkthrough";
      }
    });

    applyStep(0);
  }

  function init() {
    initReveals();
    initMobileMenu();
    initInstallTabs();
    initCopyButtons();
    initDemo();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
