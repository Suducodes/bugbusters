/* Bug Busters compiler page: welcome -> fullscreen IDE, with an invigilator-PIN screen lock. */
(function () {
  const { $, $$, api, esc, icons, toast } = BB;
  const SEAL = "[Bug Busters] The clipboard is sealed during the contest.";
  const store = {
    get(k, d) { try { const v = localStorage.getItem("bb-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("bb-" + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem("bb-" + k); } catch (e) {} },
  };
  const S = { student: store.get("student", null), armed: false, armedAt: 0, clip: "", busy: false, runs: 0,
              file: store.get("file", { name: "debug_me.m", original: "" }) };

  /* ---------- static chrome ---------- */
  $("#bugIcon").innerHTML = icons.bug;
  $("#ecgHero").innerHTML = BB.ecgSvg();
  $("#brand").innerHTML = BB.brandHtml();
  $("#lockChip").innerHTML = `${icons.shield} Locked-down`;
  $$("[data-theme-toggle]").forEach((b) => { b.innerHTML = icons.moon; b.onclick = () => BB.toggleTheme(); });
  $("#runBtn").innerHTML = `${icons.play} Run <kbd>Ctrl ↵</kbd>`;

  /* ---------- engine / files ---------- */
  let INFO = { engine: false, scripts: [], data: [] };
  async function loadInfo() {
    try { INFO = await api("/api/info"); } catch (e) { INFO.engine = false; }
    for (const id of ["#engine1", "#engine2"]) {
      const el = $(id);
      el.className = "engine " + (INFO.engine ? "ok" : "bad");
      el.querySelector("span").textContent = INFO.engine ? "Octave engine online" : "Engine offline";
    }
    $("#sbData").textContent = INFO.data.length ? "data: " + INFO.data.join(", ") : "";
  }
  loadInfo().then(() => { S.known = new Set(INFO.scripts); });

  // Organisers can publish new problems mid-contest; tell students when one appears.
  setInterval(async () => {
    if (!S.student) return;
    await loadInfo();
    const fresh = INFO.scripts.filter((f) => !S.known.has(f));
    INFO.scripts.forEach((f) => S.known.add(f));
    if (fresh.length) {
      toast(`📢 New problem: ${fresh.join(", ")}. Open it from 📂 Open.`, "ok", 8000);
      $("#openBtn").innerHTML = `📂 Open <span class="chip green" style="height:18px;padding:0 6px">new</span> ▾`;
    }
  }, 15000);

  /* ---------- editor ---------- */
  let fontSize = store.get("fs", 15);
  const editor = new CodeEditor($("#edhost"), {
    value: "", fontSize, original: S.file.original,
    onChange: (v) => store.set("code", v),
    onRun: () => run(),
    onSave: () => toast("Saved in this browser", "ok", 1200),
    onCursor: (l, c) => { $("#sbPos").textContent = `Ln ${l}, Col ${c}`; },
    onDiff: (n) => { $("#sbChg").textContent = S.file.original ? `${n} line${n === 1 ? "" : "s"} changed` : ""; },
  });
  $("#fsVal").textContent = fontSize;
  const setFs = (d) => { fontSize = Math.max(11, Math.min(24, fontSize + d)); editor.setFontSize(fontSize); $("#fsVal").textContent = fontSize; store.set("fs", fontSize); };
  $("#fsMinus").onclick = () => setFs(-1);
  $("#fsPlus").onclick = () => setFs(1);

  function setFile(name, code) {
    S.file = { name, original: code };
    store.set("file", S.file);
    store.set("code", code);
    $("#fname").textContent = name;
    editor.setValue(code, code);
  }

  $("#openBtn").onclick = async (e) => {
    e.stopPropagation();
    $("#openBtn").innerHTML = "📂 Open ▾";
    await loadInfo();
    $$(".menu-list").forEach((m) => m.remove());
    const m = document.createElement("div");
    m.className = "menu-list";
    m.innerHTML = `<div class="hd">PROBLEM FILES</div>` +
      (INFO.scripts.length ? INFO.scripts.map((s) => `<button data-s="${esc(s)}">📄 ${esc(s)}</button>`).join("") : `<div class="emptyp" style="padding:10px">No .m files on the server.</div>`) +
      `<div class="hd">OTHER</div><button data-new>✚ New blank script</button>`;
    $("#openBtn").parentElement.appendChild(m);
    const close = () => { m.remove(); document.removeEventListener("click", close); };
    setTimeout(() => document.addEventListener("click", close), 0);
    $$("[data-s]", m).forEach((b) => b.onclick = async () => {
      close();
      if (editor.value.trim() && editor.value !== S.file.original && !confirm(`Open ${b.dataset.s}? Your current code will be replaced.`)) return;
      try { const r = await api("/api/script/" + encodeURIComponent(b.dataset.s)); setFile(r.name, r.code); toast(`Opened ${r.name}`, "ok", 1500); }
      catch (err) { toast(err.message, "error"); }
    });
    $("[data-new]", m).onclick = () => { close(); if (!editor.value.trim() || confirm("Start a blank script? Your current code will be replaced.")) setFile("debug_me.m", ""); };
  };
  $("#resetBtn").onclick = () => {
    if (confirm(`Reset ${S.file.name} to how it was when opened?`)) { editor.setValue(S.file.original, S.file.original); store.set("code", S.file.original); }
  };

  /* ---------- output ---------- */
  $$(".otab").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  function showTab(t) {
    $$(".otab").forEach((x) => x.classList.toggle("on", x.dataset.tab === t));
    ["console", "figs", "vars"].forEach((k) => $("#p-" + k).classList.toggle("hidden", k !== t));
  }
  const hello = () => `<span class="hello">GNU Octave · MATLAB-compatible · offline\n<b>Ready.</b> Press Run or Ctrl+Enter to execute your script.</span>\n\n`;
  $("#console").innerHTML = hello();
  $("#clearBtn").onclick = () => { $("#console").innerHTML = hello(); editor.setErrorLine(0); };

  async function run() {
    if (S.busy) return;
    S.busy = true;
    const btn = $("#runBtn");
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Running…`;
    $("#scan").classList.add("on");
    const card = $("#outCard"); card.classList.remove("ok", "bad");
    showTab("console");
    const con = $("#console");
    const block = document.createElement("div");
    block.innerHTML = `<span class="cmd">&gt;&gt; run ${esc(S.file.name)}</span> <span class="meta">(#${++S.runs} · ${new Date().toLocaleTimeString()})</span>\n`;
    con.appendChild(block);
    try {
      const res = await api("/api/run", { body: { code: editor.value } });
      block.innerHTML += render(res);
      after(res);
      void card.offsetWidth;
      card.classList.add(res.status === "ok" ? "ok" : "bad");
      setTimeout(() => card.classList.remove("ok", "bad"), 1600);
    } catch (e) {
      block.innerHTML += `<span class="warn">${esc(e.message)}</span>\n\n`;
    } finally {
      S.busy = false; btn.disabled = false; btn.innerHTML = `${icons.play} Run <kbd>Ctrl ↵</kbd>`;
      $("#scan").classList.remove("on");
      con.parentElement.scrollTop = con.parentElement.scrollHeight;
    }
  }

  function render(res) {
    let h = "";
    if (res.stdout) h += esc(res.stdout.replace(/\s+$/, "")) + "\n";
    if (res.stderr) h += `<span class="warn">${esc(res.stderr)}</span>\n`;
    if (res.error) {
      const line = res.error.line;
      const label = res.status === "blocked" ? "Blocked" : res.status === "timeout" ? "Time limit" : "Error";
      h += `<div class="errb"><b>${label}</b>${line ? ` in ${esc(S.file.name)} at <a data-line="${line}">line ${line}</a>` : ""}\n${esc(res.error.message)}</div>`;
    } else if (!res.stdout && !res.stderr) h += `<span class="meta">(no output)</span>\n`;
    if (res.figures?.length) h += `<span class="okb">▸ ${res.figures.length} figure${res.figures.length > 1 ? "s" : ""} created, see Figures</span>\n`;
    h += `<span class="meta">${res.status === "ok" ? "✓ finished" : "✗ " + res.status} in ${res.time_ms} ms</span>\n\n`;
    return h;
  }

  const fmtNum = (x) => (Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-3 && x !== 0)) ? x.toExponential(3) : +x.toFixed(5);
  function after(res) {
    editor.setErrorLine(res.error?.line || 0);
    $$("#console a[data-line]").forEach((a) => a.onclick = () => editor.gotoLine(+a.dataset.line));
    $("#execTime").textContent = `${res.time_ms} ms`; $("#execTime").classList.remove("hidden");
    const figs = res.figures || [];
    $("#nFigs").textContent = figs.length;
    $("#p-figs").innerHTML = figs.length ? `<div class="figs">${figs.map((f) => `<img src="${f}" draggable="false" alt="figure">`).join("")}</div>` : `<div class="emptyp">This run did not create any figures.</div>`;
    const vars = res.vars || [];
    $("#nVars").textContent = vars.length;
    $("#p-vars").innerHTML = vars.length ? `<table class="table vt"><thead><tr><th>Name</th><th>Value</th><th>Size</th><th>Class</th><th>Min</th><th>Max</th></tr></thead><tbody>${vars.map((v) => `<tr><td><b>${esc(v.name)}</b></td><td>${esc(v.preview || `[${v.size} ${v.class}]`)}</td><td>${esc(v.size)}</td><td>${esc(v.class)}</td><td>${v.stats ? fmtNum(v.stats[2]) : ""}</td><td>${v.stats ? fmtNum(v.stats[3]) : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="emptyp">No variables.</div>`;
    if (figs.length && !res.error && !res.stdout) showTab("figs");
  }
  $("#runBtn").onclick = () => run();

  /* ---------- screens ---------- */
  function showIde() {
    $("#welcome").classList.add("hidden");
    $("#ide").classList.remove("hidden");
    const st = S.student;
    $("#whoName").textContent = st.name; $("#whoReg").textContent = st.reg;
    $("#avatar").textContent = st.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const text = `${st.reg} · ${st.name}`;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'><text x='20' y='130' transform='rotate(-18 210 110)' font-family='monospace' font-size='15' font-weight='700' fill='%232a4b8d' fill-opacity='0.05'>${esc(text).replace(/#/g, "%23")}</text></svg>`;
    $("#watermark").style.backgroundImage = `url("data:image/svg+xml;utf8,${svg}")`;
    $("#fname").textContent = S.file.name;
    editor.setValue(store.get("code", S.file.original), S.file.original);
    setTimeout(() => editor.focus(), 50);
  }

  async function goFullscreen() {
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); return true; }
    catch (e) { toast("Fullscreen was blocked by the browser. Use Chrome or Edge.", "error"); return false; }
  }

  $("#startForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#name").value.trim().replace(/\s+/g, " "), reg = $("#reg").value.trim().toUpperCase();
    if (!name || !reg) return;
    await goFullscreen();
    S.student = { name, reg };
    store.set("student", S.student);
    if (!store.get("code", null)) {
      // first start: open the first problem file if the organisers put one in /files
      await loadInfo();
      if (INFO.scripts.length) {
        try { const r = await api("/api/script/" + encodeURIComponent(INFO.scripts[0])); S.file = { name: r.name, original: r.code }; store.set("file", S.file); store.set("code", r.code); } catch (err) {}
      }
    }
    showIde();
    arm();
  };

  /* ---------- lock ---------- */
  const REASONS = {
    fullscreen_exit: "Left fullscreen", tab_switch: "Switched tab or minimised", focus_lost: "Switched to another window",
    external_paste: "Pasted text from outside", devtools: "Tried to open developer tools", reload: "Page was reloaded or reopened",
  };
  function arm() { S.armed = true; S.armedAt = Date.now(); }

  function lock(type, detail) {
    if (!S.student) return;
    if (!$("#lock").classList.contains("hidden")) return;
    if (type !== "reload" && (!S.armed || Date.now() - S.armedAt < 1500)) return;
    S.armed = false;
    const count = (store.get("locks", 0) || 0) + 1;
    store.set("locks", count);
    store.set("locked", { type, at: Date.now() });
    api("/api/event", { body: { reg: S.student.reg, name: S.student.name, type: REASONS[type] + (detail ? ` (${detail})` : "") } }).catch(() => {});
    showLock(type, count);
  }

  function showLock(type, count) {
    const L = $("#lock");
    L.innerHTML = `<div class="box">
      <div class="ic">${icons.lock}</div>
      <h1>Screen locked</h1>
      <p>${esc(REASONS[type] || "Integrity rule broken")}. Raise your hand. An invigilator must unlock this screen.</p>
      <div class="who2">${esc(S.student.reg)} · ${esc(S.student.name)} · lock #${count}</div>
      <form class="pinrow" id="pinForm"><input id="pin" type="password" inputmode="numeric" maxlength="12" placeholder="PIN" autocomplete="off"><button class="btn btn-danger btn-lg" style="background:#ff5a5a;color:#fff;border-color:#ff5a5a">Unlock</button></form>
      <div class="small">Invigilator PIN required</div></div>`;
    L.classList.remove("hidden");
    $("#pin").focus();
    $("#pinForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/unlock", { body: { pin: $("#pin").value } });
        store.del("locked");
        api("/api/event", { body: { reg: S.student.reg, name: S.student.name, type: "unlocked" } }).catch(() => {});
        L.innerHTML = `<div class="box"><div class="ic" style="color:#7be3a0;background:rgba(123,227,160,.12);animation:none;box-shadow:0 0 60px rgba(123,227,160,.25)">${icons.send}</div><h1>Unlocked</h1><p>Continue the contest in fullscreen, or end this session to hand the laptop to someone else.</p>
          <div class="acts"><button class="btn btn-green btn-lg" id="resume">Resume in fullscreen</button><button class="btn btn-lg" id="endS" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.3)">End session</button></div></div>`;
        $("#resume").onclick = async () => { await goFullscreen(); L.classList.add("hidden"); arm(); editor.focus(); };
        $("#endS").onclick = () => { if (confirm("End this session? The code in this browser will be cleared.")) { ["student", "code", "file", "locks", "locked"].forEach(store.del); location.reload(); } };
      } catch (err) {
        $("#pin").value = ""; $("#pin").placeholder = "Wrong PIN"; $("#pin").focus();
      }
    };
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && S.student && $("#lock").classList.contains("hidden")) lock("fullscreen_exit");
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) lock("tab_switch"); });
  window.addEventListener("blur", () => setTimeout(() => { if (!document.hasFocus() && !document.hidden) lock("focus_lost"); }, 250));

  /* sealed clipboard: copy/paste only inside the editor */
  const inEditor = () => document.activeElement === editor.ta;
  document.addEventListener("copy", (e) => {
    if (inEditor()) S.clip = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd);
    e.clipboardData.setData("text/plain", SEAL); e.preventDefault();
  }, true);
  document.addEventListener("cut", (e) => {
    e.preventDefault();
    if (inEditor()) { S.clip = editor.ta.value.slice(editor.ta.selectionStart, editor.ta.selectionEnd); e.clipboardData.setData("text/plain", SEAL); document.execCommand("delete"); }
  }, true);
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!S.student || document.activeElement?.id === "pin" || document.activeElement?.id === "name" || document.activeElement?.id === "reg") return;
    e.preventDefault();
    if (!inEditor()) return;
    if (text === SEAL || text === S.clip) { if (S.clip) document.execCommand("insertText", false, S.clip); return; }
    if (text) lock("external_paste", `${text.length} chars`);
  }, true);
  ["drop", "dragover", "dragstart"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), true));
  document.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  document.addEventListener("keydown", (e) => {
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === "F12" || (mod && e.shiftKey && /^[ijck]$/i.test(k)) || (mod && /^u$/i.test(k))) { e.preventDefault(); lock("devtools", k); return; }
    if (mod && /^[pP]$/.test(k)) e.preventDefault();
    if (k === "F11" || k === "F5" || (mod && /^r$/i.test(k))) e.preventDefault();
    if (mod && /^[sS]$/.test(k) && !inEditor()) e.preventDefault();
  }, true);
  window.addEventListener("beforeunload", (e) => { if (S.student && $("#lock").classList.contains("hidden")) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- boot ---------- */
  if (S.student) {
    showIde();
    // Coming back to the page (reload, reopen) counts as leaving it.
    const was = store.get("locked", null);
    if (was) showLock(was.type, store.get("locks", 1)); else lock("reload");
  }
})();
