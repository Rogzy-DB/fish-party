/*
 * tanknav.js — the ONE shared top navigation for the aquarium's phone pages.
 *
 * Single source of truth: draw.html / upload.html / settings.html each drop an
 * empty `<nav id="tanknav"></nav>` (or any `.tanknav-mount`) and load this file.
 * The script injects the tab markup + a token-based <style> (once), and marks
 * the current page's tab with aria-current. Change a label/order/destination
 * HERE and all three pages update — no hand-copied, drifting copies.
 *
 * NOT loaded on index.html (the projected tank): that stays a chrome-free art
 * surface with only the tiny 🔊 + ⚙ corner icons.
 *
 * Styling uses static/ui.css tokens with hard fallbacks, so it also renders
 * correctly on upload.html (which predates the design system and defines none).
 */
(() => {
  "use strict";
  const TABS = [
    { key: "draw",     href: "draw",     label: "✏️ Draw" },
    { key: "upload",   href: "upload",   label: "📷 Photo" },
    { key: "settings", href: "settings", label: "⚙️ Settings", owner: true },
  ].filter((t) => !t.owner || (window.TANK_MODE || "home") === "home");
  // active tab = last path segment (works behind a proxy prefix-strip such as
  // /tank/; the pages are siblings at /tank/<key>, no trailing slash).
  const seg = location.pathname.replace(/\/+$/, "").split("/").pop();
  const active = TABS.some((t) => t.key === seg) ? seg : "";

  if (!document.getElementById("tanknav-style")) {
    const st = document.createElement("style");
    st.id = "tanknav-style";
    st.textContent =
      ".tanknav{display:flex;gap:var(--sp-2,8px);overflow-x:auto;" +
      "-webkit-overflow-scrolling:touch;padding:var(--sp-1,6px) 0;" +
      "margin-bottom:var(--sp-4,18px)}" +
      ".tanknav a{flex:1 1 auto;display:flex;align-items:center;justify-content:center;" +
      "min-height:44px;padding:0 var(--sp-3,12px);white-space:nowrap;" +
      "border:1px solid var(--line,#1d3a5c);border-radius:var(--radius-pill,999px);" +
      "background:var(--card,#0a2038);color:var(--faint,#8fb0cc);" +
      "text-decoration:none;font-family:inherit;font-size:.9rem}" +
      ".tanknav a[aria-current=page]{background:var(--accent,#2a8fe0);" +
      "border-color:var(--accent,#2a8fe0);color:#041020;font-weight:700}";
    document.head.appendChild(st);
  }

  for (const mount of document.querySelectorAll("#tanknav, .tanknav-mount")) {
    mount.classList.add("tanknav");
    mount.setAttribute("aria-label", "Tank navigation");
    mount.textContent = "";
    for (const t of TABS) {
      const a = document.createElement("a");
      a.href = t.href;
      a.textContent = t.label;              // textContent -> no injection
      if (t.key === active) a.setAttribute("aria-current", "page");
      mount.appendChild(a);
    }
  }
})();
