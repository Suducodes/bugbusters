/* Shared helpers for all Bug Busters pages. */
(function () {
  const BB = (window.BB = {});

  BB.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  BB.$ = (sel, root = document) => root.querySelector(sel);
  BB.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  BB.api = async function (path, opts = {}) {
    const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, init); }
    catch (e) { const err = new Error("Cannot reach the contest server. Check the network."); err.network = true; throw err; }
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) data = await res.json();
    else data = await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status; err.data = data; throw err;
    }
    return data;
  };

  BB.toast = function (msg, kind = "", ms = 3800) {
    let host = document.getElementById("toasts");
    if (!host) { host = document.createElement("div"); host.id = "toasts"; document.body.appendChild(host); }
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, ms);
  };

  /* Tiny, safe markdown: paragraphs, bullet lists, **bold**, *italic*, `code`. */
  BB.md = function (src) {
    const inline = (t) => BB.esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    const blocks = String(src || "").replace(/\r/g, "").split(/\n{2,}/);
    return blocks.map((b) => {
      const lines = b.split("\n");
      const items = lines.filter((l) => /^\s*[-*]\s+/.test(l));
      if (items.length && items.length >= lines.length - 1) {
        const head = lines.filter((l) => !/^\s*[-*]\s+/.test(l)).map(inline).join(" ");
        return (head ? `<p>${head}</p>` : "") + "<ul>" + items.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("") + "</ul>";
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    }).join("");
  };

  /* Line diff (LCS). Returns [{t:'eq'|'add'|'del', a, b, text}] */
  BB.lineDiff = function (oldText, newText) {
    const a = String(oldText).replace(/\r/g, "").split("\n");
    const b = String(newText).replace(/\r/g, "").split("\n");
    const n = a.length, m = b.length;
    if (n * m > 4_000_000) return b.map((text, i) => ({ t: "eq", a: i + 1, b: i + 1, text }));
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { out.push({ t: "eq", a: i + 1, b: j + 1, text: a[i] }); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ t: "add", b: j + 1, text: b[j] }); j++; }
      else { out.push({ t: "del", a: i + 1, text: a[i] }); i++; }
    }
    return out;
  };

  BB.diffHtml = function (oldText, newText) {
    const rows = BB.lineDiff(oldText, newText);
    return `<div class="diff">${rows.map((r) => `<div class="diff-row ${r.t}"><span class="n">${r.a || ""}</span><span class="n">${r.b || ""}</span><span class="s">${r.t === "add" ? "+" : r.t === "del" ? "−" : ""}</span><span class="c">${BB.esc(r.text) || " "}</span></div>`).join("")}</div>`;
  };

  BB.changedLines = function (oldText, newText) {
    const set = new Set();
    for (const r of BB.lineDiff(oldText, newText)) if (r.t === "add") set.add(r.b);
    return set;
  };

  BB.pad = (n) => String(n).padStart(2, "0");
  BB.fmtDuration = function (sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${BB.pad(h)}:${BB.pad(m)}:${BB.pad(s)}`;
  };
  BB.fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  BB.fmtDate = (ts) => {
    const d = new Date(ts * 1000);
    return `${BB.pad(d.getDate())}.${BB.pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  };
  BB.fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  BB.ago = function (ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 5) return "just now";
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  /* Theme */
  BB.initTheme = function () {
    let t = null;
    try { t = localStorage.getItem("bb-theme"); } catch (e) {}
    if (t) document.documentElement.dataset.theme = t;
  };
  BB.toggleTheme = function () {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem("bb-theme", cur); } catch (e) {}
    return cur;
  };
  BB.initTheme();

  BB.icons = {
    bug: `<svg class="bug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6.5 6.5 4.5M16 6.5l1.5-2"/><path d="M9 7.5a3 3 0 0 1 6 0"/><rect x="7" y="7.5" width="10" height="12" rx="5"/><path d="M12 7.5v12M7 12H3.5M20.5 12H17M7.5 16.5 4.5 19M16.5 16.5l3 2.5M7.5 9.5 4.5 7.5M16.5 9.5l3-2"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5Z"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
    diff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3v12M18 9v12M3 6h6M15 18h6M18 3a3 3 0 1 1 0 6M6 21a3 3 0 1 1 0-6"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
    laptop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`,
    trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`,
    expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
    logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>`,
  };

  BB.ecgSvg = function (cls = "ecg-line") {
    return `<svg class="${cls}" viewBox="0 0 1000 40" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M0 22H340l12-4 10 4h14l10-18 14 34 10-26 8 10h170l10-3 8 3h14l9-14 12 26 9-20 7 8H1000"/></svg>`;
  };

  BB.brandHtml = function (name = "Bug Busters") {
    const parts = String(name).split(" ");
    const first = parts.shift();
    return `${BB.icons.bug.replace('class="bug"', 'class="bug" width="26" height="26"')}<span class="word"><b>${BB.esc(first)}</b> ${BB.esc(parts.join(" "))}<span class="dot">.</span></span>`;
  };
})();
