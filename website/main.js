/* ===== CFLS landing page — interactions & animations ===== */
(function () {
  "use strict";

  const hasGsap = typeof window.gsap !== "undefined";
  if (hasGsap && window.ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
  }

  /* -------- scroll reveals -------- */
  function initReveals() {
    const items = Array.from(document.querySelectorAll("[data-reveal]"));
    if (!hasGsap) {
      // Graceful fallback: just show everything.
      document.documentElement.classList.add("no-anim");
      return;
    }
    items.forEach((el) => {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 0.7,
        ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 88%" },
      });
    });
  }

  /* -------- install tabs -------- */
  function initTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".tab-panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.getAttribute("data-tab");
        tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
        panels.forEach((p) =>
          p.classList.toggle("is-active", p.getAttribute("data-panel") === key),
        );
      });
    });
  }

  /* -------- copy-to-clipboard -------- */
  function initCopy() {
    document.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy") || "";
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Fallback for non-secure contexts.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch { /* ignore */ }
          document.body.removeChild(ta);
        }
        const original = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1400);
      });
    });
  }

  /* -------- hero coordination loop -------- */
  function initHero() {
    if (!hasGsap) return;
    const lock = document.querySelector("#hero-lockline .inline-lock");
    const toast = document.querySelector("#hero-toast");
    if (!lock || !toast) return;

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.6, delay: 0.6 });
    tl.to(lock, { opacity: 1, duration: 0.4, ease: "back.out(2)" })
      .to(toast, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, "-=0.1")
      .to({}, { duration: 2.4 })
      .to([toast], { opacity: 0, y: 10, duration: 0.4 })
      .to(lock, { opacity: 0, duration: 0.4 }, "-=0.2");
  }

  /* -------- live demo loop (Alice types → Bob is warned → auto-sync) -------- */
  function initDemo() {
    if (!hasGsap) return;
    const caret = document.querySelector("#alice-caret");
    const packet = document.querySelector("#flow-packet");
    const bobLock = document.querySelector("#bob-lock");
    const toast = document.querySelector("#demo-toast");
    const sync = document.querySelector("#demo-sync");
    const aliceLine = document.querySelector("#alice-typing");
    if (!caret || !packet || !bobLock || !toast || !sync || !aliceLine) return;

    // blink caret continuously
    gsap.to(caret, { opacity: 1, duration: 0.001, repeat: -1, yoyo: true, repeatDelay: 0.45 });

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.4, delay: 0.8 });
    tl
      // Alice "starts editing"
      .set([bobLock, toast, sync], { opacity: 0 })
      .set(packet, { opacity: 0, left: "0%" })
      .to(aliceLine, { backgroundColor: "rgba(96,165,250,.08)", duration: 0.3 })
      // packet flows Alice → host → Bob
      .to(packet, { opacity: 1, duration: 0.15 })
      .to(packet, { left: "100%", duration: 1.0, ease: "power1.inOut" })
      .to(packet, { opacity: 0, duration: 0.15 })
      // Bob sees the lock + warning
      .to(bobLock, { opacity: 1, duration: 0.35, ease: "back.out(2)" })
      .to(toast, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, "-=0.1")
      .to({}, { duration: 2.0 })
      // auto-sync resolves
      .to(toast, { opacity: 0, y: 8, duration: 0.4 })
      .to(sync, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, "-=0.1")
      .to({}, { duration: 2.0 })
      // reset
      .to([sync, bobLock], { opacity: 0, duration: 0.4 })
      .to(aliceLine, { backgroundColor: "rgba(0,0,0,0)", duration: 0.3 }, "-=0.3");
  }

  /* -------- nav shadow on scroll (subtle) -------- */
  function initNav() {
    const nav = document.querySelector("header nav > div");
    if (!nav) return;
    const onScroll = () => {
      if (window.scrollY > 20) nav.classList.add("shadow-2xl");
      else nav.classList.remove("shadow-2xl");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  document.addEventListener("DOMContentLoaded", () => {
    initReveals();
    initTabs();
    initCopy();
    initHero();
    initDemo();
    initNav();
  });
})();
