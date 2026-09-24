/* Student page: question grid -> fix the buggy code -> submit (text only) to Supabase.
   Works through bad internet: questions are cached, submissions queue and retry. */
(function () {
  const { $, $$, esc, icons, toast } = BB;
  const SEAL = "[Bug Busters] The clipboard is sealed during the contest.";
  const store = {
    get(k, d) { try { const v = localStorage.getItem("bb-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("bb-" + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem("bb-" + k); } catch (e) {} },
  };
  let device = store.get("device", null);
  if (!device) { device = crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16)); store.set("device", device); }

  const S = {
    student: store.get("student", null),
    problems: store.get("problems", []),
    subs: store.get("subs", {}),          // problem_id -> {version, submitted_at}
    outbox: store.get("outbox", {}),      // problem_id -> code waiting to be sent
    state: store.get("state", null),      // {ends_at, is_open, title, pin_hash}
    offset: store.get("offset", 0),
    current: null, armed: false, armedAt: 0, clip: "", online: true,
  };
  const draftKey = (pid) => `draft-${S.student?.reg_no}-${pid}`;
  const now = () => Date.now() / 1000 + S.offset;

  /* ---------- chrome ---------- */
  $("#bugIcon").innerHTML = icons.bug;
  $("#ecgHero").innerHTML = BB.ecgSvg();
  $("#ecgHome").innerHTML = BB.ecgSvg();
  $("#brand").innerHTML = BB.brandHtml();
  $("#submitBtn").innerHTML = `${icons.send} Submit`;
  $$("[data-theme-toggle]").forEach((b) => { b.innerHTML = icons.moon; b.onclick = () => BB.toggleTheme(); });
  if (!SB.configured) {
    $("#formErr").textContent = "This site is not connected to the database yet (docs/js/config.js).";
    $("#formErr").classList.remove("hidden");
  }

  /* ---------- editor ---------- */
  const editor = new CodeEditor($("#edhost"), {
    value: "", fontSize: store.get("fs", 15),
    onChange: (v) => { if (S.current) { store.set(draftKey(S.current.id), v); $("#sbSave").textContent = "draft saved on this laptop"; } },
    onSubmit: () => submit(),
    onRun: () => toast("There is no Run here: fix the code and press Submit.", "", 2500),
    onCursor: (l, c) => { $("#sbPos").textContent = `Ln ${l}, Col ${c}`; },
    onDiff: (n) => { $("#sbChg").textContent = `${n} line${n === 1 ? "" : "s"} changed`; },
  });

  /* ---------- server sync ---------- */
  function setSync() {
    const n = Object.keys(S.outbox).length;
    const el = $("#sync");
    el.className = "sync" + (!S.online ? " off" : n ? " wait" : "");
    el.querySelector("span").textContent = !S.online ? `Offline${n ? ` · ${n} waiting to send` : ""}` : n ? `Sending ${n}…` : "Online";
  }

  async function refresh() {
    try {
      const st = await SB.rpc("bb_state");
      S.state = st; store.set("state", st);
      S.offset = Date.parse(st.now) / 1000 - Date.now() / 1000; store.set("offset", S.offset);
      const probs = await SB.select("problems", "select=id,position,title,statement,buggy_code,max_marks&published=eq.true&order=position,id");
      const known = new Set(S.problems.map((p) => p.id));
      const fresh = probs.filter((p) => !known.has(p.id));
      S.problems = probs; store.set("problems", probs);
      if (S.student) {
        const j = await SB.rpc("bb_join", { p_reg: S.student.reg_no, p_name: S.student.name, p_device: device });
        for (const s of j.submissions) S.subs[s.problem_id] = s;
        store.set("subs", S.subs);
        if (fresh.length && known.size) toast(`📢 New question added: ${fresh.map((p) => p.title).join(", ")}`, "ok", 7000);
      }
      S.online = true;
    } catch (e) {
      if (e.offline) S.online = false;
      else if (e.message && /another laptop|not logged in/i.test(e.message)) toast(e.message, "error", 8000);
    }
    setSync(); renderHome(); closedCheck();
  }

  // One flush at a time, so the retry timer and a Submit click never send the same code twice.
  async function flush() {
    while (S.flushing) await S.flushing;
    S.flushing = doFlush();
    try { await S.flushing; } finally { S.flushing = null; }
  }
  async function doFlush() {
    const ids = Object.keys(S.outbox);
    if (!ids.length || !S.student) { setSync(); return; }
    for (const pid of ids) {
      try {
        const r = await SB.rpc("bb_submit", { p_reg: S.student.reg_no, p_device: device, p_problem: +pid, p_code: S.outbox[pid] });
        S.subs[pid] = r;
        delete S.outbox[pid];
        S.online = true;
      } catch (e) {
        if (e.offline) { S.online = false; break; }
        delete S.outbox[pid];
        toast(`Q${qIndex(+pid)} could not be submitted: ${e.message}`, "error", 8000);
      }
    }
    store.set("outbox", S.outbox); store.set("subs", S.subs);
    setSync(); renderHome();
  }
  window.addEventListener("online", () => { flush(); refresh(); });
  setInterval(flush, 5000);
  setInterval(refresh, 20000);

  /* ---------- time ---------- */
  const isClosed = () => S.state && (!S.state.is_open || (S.state.ends_at && now() >= Date.parse(S.state.ends_at) / 1000));
  function closedCheck() {
    const closed = isClosed();
    $("#closed").classList.toggle("hidden", !closed);
    $("#submitBtn").disabled = !!closed;
    editor.setReadOnly(!!closed);
  }
  function tick() {
    const t = $("#timer");
    if (!S.state?.ends_at) { t.classList.add("hidden"); return; }
    t.classList.remove("hidden");
    const left = Date.parse(S.state.ends_at) / 1000 - now();
    $("#timerT").textContent = BB.fmtDuration(Math.max(0, left));
    t.classList.toggle("warn", left <= 900 && left > 300);
    t.classList.toggle("crit", left <= 300);
    if (left <= 0 && !$("#submitBtn").disabled) closedCheck();
  }
  setInterval(tick, 500);

  /* ---------- home ---------- */
  const qIndex = (pid) => S.problems.findIndex((p) => p.id === pid) + 1;
  function renderHome() {
    if (!S.student) return;
    const grid = $("#qgrid");
    const done = S.problems.filter((p) => S.subs[p.id] || S.outbox[p.id]).length;
    $("#progTxt").textContent = `${done} / ${S.problems.length} submitted`;
    $("#progBar").style.width = S.problems.length ? (done / S.problems.length) * 100 + "%" : "0";
    if (!S.problems.length) { grid.innerHTML = `<div class="empty-q" style="grid-column:1/-1">Waiting for the questions to be released…</div>`; return; }
    const html = S.problems.map((p, i) => {
      const sub = S.subs[p.id], pend = S.outbox[p.id] != null, draft = store.get(draftKey(p.id), null);
      const cls = pend ? "pending" : sub ? "done" : draft != null && draft !== p.buggy_code ? "draft" : "";
      const st = pend ? "Saved · waiting for internet to send"
        : sub ? `✓ Submitted ${new Date(sub.submitted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${sub.version > 1 ? ` · v${sub.version}` : ""}`
        : cls === "draft" ? "In progress · not submitted" : "Not attempted";
      return `<button class="qcard ${cls}" data-id="${p.id}" style="animation-delay:${i * 50}ms">
        <span class="qn">Q${i + 1}</span><h3>${esc(p.title)}</h3><span class="mk">${+p.max_marks} marks</span>
        <span class="st"><i></i>${st}</span>${icons.bug.replace('class="bug"', 'class="bugmark"')}</button>`;
    }).join("");
    if (html === S.lastGrid) return;   // avoid replaying the entrance animation on every refresh
    S.lastGrid = html;
    grid.innerHTML = html;
    $$(".qcard", grid).forEach((b) => b.onclick = () => openQ(+b.dataset.id));
  }

  /* ---------- solve ---------- */
  function openQ(pid) {
    const p = S.problems.find((x) => x.id === pid);
    if (!p) return;
    S.current = p;
    const i = qIndex(pid);
    const sub = S.subs[pid];
    $("#qpanel").innerHTML = `<div class="eyebrow">&gt;&gt; Question ${i} of ${S.problems.length}</div><h2>${esc(p.title)}</h2>
      <div style="display:flex;gap:6px;margin-bottom:14px"><span class="chip">${+p.max_marks} marks</span>${sub ? `<span class="chip green">✓ Submitted${sub.version > 1 ? " v" + sub.version : ""}</span>` : ""}</div>
      <div class="md">${BB.md(p.statement)}</div>
      <div class="stbox">Fix the bugs in the editor, then press <b>Submit</b>. You can come back and re-submit until time runs out. Your latest submission is the one that's marked.</div>`;
    $("#fname").textContent = `Q${i}.m`;
    editor.setValue(store.get(draftKey(pid), p.buggy_code), p.buggy_code);
    $("#sbSave").textContent = "";
    $("#home").classList.add("hidden");
    $("#solve").classList.remove("hidden");
    closedCheck();
    setTimeout(() => editor.focus(), 30);
  }
  function goHome() {
    S.current = null;
    $("#solve").classList.add("hidden");
    $("#home").classList.remove("hidden");
    renderHome();
  }
  $("#backBtn").onclick = goHome;
  $("#resetBtn").onclick = () => {
    if (S.current && confirm("Reset to the original buggy code? Your changes to this question will be lost.")) {
      editor.setValue(S.current.buggy_code, S.current.buggy_code); store.del(draftKey(S.current.id));
    }
  };

  async function submit() {
    const p = S.current;
    if (!p || isClosed()) return;
    const code = editor.value;
    if (code === p.buggy_code && !confirm("You haven't changed anything. Submit the original code anyway?")) return;
    S.outbox[p.id] = code; store.set("outbox", S.outbox);
    $("#submitBtn").disabled = true;
    await flush();
    $("#submitBtn").disabled = false;
    const sent = S.outbox[p.id] == null && S.subs[p.id];
    celebrate(sent ? `Q${qIndex(p.id)} submitted!` : "Saved on this laptop", sent ? "You can re-submit any time before the end." : "No internet right now. It will be sent automatically.");
    goHome();
  }
  $("#submitBtn").onclick = submit;

  function celebrate(title, sub) {
    const el = $("#success");
    el.innerHTML = `<div class="burst"><div class="ok">${icons.send}</div><h2>${esc(title)}</h2><p style="color:var(--text-2);margin:6px 0 0">${esc(sub)}</p></div>`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 1800);
  }

  /* ---------- login ---------- */
  function showApp() {
    $("#welcome").classList.add("hidden");
    $("#app").classList.remove("hidden");
    const st = S.student;
    $("#whoName").textContent = st.name; $("#whoReg").textContent = st.reg_no;
    $("#avatar").textContent = st.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'><text x='20' y='130' transform='rotate(-18 210 110)' font-family='monospace' font-size='15' font-weight='700' fill='%232a4b8d' fill-opacity='0.05'>${esc(st.reg_no + " · " + st.name).replace(/#/g, "%23")}</text></svg>`;
    $("#watermark").style.backgroundImage = `url("data:image/svg+xml;utf8,${svg}")`;
    renderHome(); setSync(); closedCheck(); tick();
  }

  async function goFullscreen() {
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); return true; }
    catch (e) { toast("Fullscreen was blocked. Use Chrome or Edge.", "error"); return false; }
  }

  $("#startForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#startBtn"), err = $("#formErr");
    err.classList.add("hidden");
    const fs = goFullscreen();
    btn.disabled = true; btn.textContent = "Connecting…";
    try {
      const j = await SB.rpc("bb_join", { p_reg: $("#reg").value, p_name: $("#name").value, p_device: device });
      S.student = { reg_no: j.reg_no, name: j.name };
      store.set("student", S.student);
      for (const s of j.submissions) S.subs[s.problem_id] = s;
      store.set("subs", S.subs);
      await fs;
      await refresh();
      showApp(); arm();
    } catch (ex) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      err.textContent = ex.offline ? "No internet connection. Try again in a moment." : ex.message;
      err.classList.remove("hidden");
    } finally { btn.disabled = false; btn.textContent = "Enter fullscreen & start"; }
  };

  /* ---------- screen lock ---------- */
  const REASONS = {
    fullscreen_exit: "Left fullscreen", tab_switch: "Switched tab or minimised", focus_lost: "Switched to another window",
    external_paste: "Pasted text from outside", devtools: "Tried to open developer tools", reload: "Page was reloaded or reopened",
  };
  function arm() { S.armed = true; S.armedAt = Date.now(); }
  function report(type) {
    if (!S.student) return;
    const q = store.get("evq", []); q.push(type); store.set("evq", q);
    (async () => {
      const pending = store.get("evq", []);
      while (pending.length) {
        try { await SB.rpc("bb_event", { p_reg: S.student.reg_no, p_device: device, p_type: pending[0] }); pending.shift(); store.set("evq", pending); }
        catch (e) { break; }
      }
    })();
  }

  function lock(type, detail) {
    if (!S.student || !$("#lock").classList.contains("hidden")) return;
    if (type !== "reload" && (!S.armed || Date.now() - S.armedAt < 1500)) return;
    S.armed = false;
    const count = store.get("locks", 0) + 1;
    store.set("locks", count);
    store.set("locked", { type });
    report(`LOCKED: ${REASONS[type]}${detail ? ` (${detail})` : ""}`);
    showLock(type, count);
  }

  async function pinOk(pin) {
    try { return await SB.rpc("bb_unlock", { p_pin: pin }); }
    catch (e) {
      if (!e.offline || !S.state?.pin_hash || !crypto.subtle) return false;
      const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin + ":bugbusters"));
      return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("") === S.state.pin_hash;
    }
  }

  function showLock(type, count) {
    const L = $("#lock");
    L.innerHTML = `<div class="box"><div class="ic">${icons.lock}</div><h1>Screen locked</h1>
      <p>${esc(REASONS[type] || "Integrity rule broken")}. Raise your hand. An invigilator must unlock this screen.</p>
      <div class="who2">${esc(S.student.reg_no)} · ${esc(S.student.name)} · lock #${count}</div>
      <form class="pinrow" id="pinForm"><input id="pin" type="password" inputmode="numeric" maxlength="16" placeholder="PIN" autocomplete="off"><button class="btn btn-lg" style="background:#ff5a5a;color:#fff;border-color:#ff5a5a">Unlock</button></form>
      <div class="small">Invigilator PIN required</div></div>`;
    L.classList.remove("hidden");
    $("#pin").focus();
    $("#pinForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!(await pinOk($("#pin").value))) { $("#pin").value = ""; $("#pin").placeholder = "Wrong PIN"; return; }
      store.del("locked");
      report("unlocked by invigilator");
      L.innerHTML = `<div class="box"><div class="ic" style="color:#7be3a0;background:rgba(123,227,160,.12);animation:none;box-shadow:0 0 60px rgba(123,227,160,.25)">${icons.send}</div><h1>Unlocked</h1><p>Continue in fullscreen, or end this session to hand the laptop to someone else.</p>
        <div class="acts"><button class="btn btn-green btn-lg" id="resume">Resume in fullscreen</button><button class="btn btn-lg" id="endS" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.3)">End session</button></div></div>`;
      $("#resume").onclick = async () => { await goFullscreen(); L.classList.add("hidden"); arm(); };
      $("#endS").onclick = () => {
        if (Object.keys(S.outbox).length && !confirm("Some submissions have not been sent yet (no internet). End anyway? They will be lost.")) return;
        if (!confirm("End this session? This laptop will be cleared for the next student.")) return;
        Object.keys(localStorage).filter((k) => k.startsWith("bb-") && k !== "bb-device" && k !== "bb-theme").forEach((k) => localStorage.removeItem(k));
        location.reload();
      };
    };
  }

  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) lock("fullscreen_exit"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) lock("tab_switch"); });
  window.addEventListener("blur", () => setTimeout(() => { if (!document.hasFocus() && !document.hidden) lock("focus_lost"); }, 250));

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
    if (!S.student || ["pin", "name", "reg"].includes(document.activeElement?.id)) return;
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
    if (k === "F11" || k === "F5" || (mod && /^[rps]$/i.test(k))) e.preventDefault();
  }, true);
  window.addEventListener("beforeunload", (e) => { if (S.student && $("#lock").classList.contains("hidden")) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- boot ---------- */
  if (S.student) {
    showApp();
    refresh(); flush();
    const was = store.get("locked", null);
    if (was) showLock(was.type, store.get("locks", 1)); else lock("reload");
  } else if (SB.configured) {
    SB.rpc("bb_state").then((st) => { S.state = st; store.set("state", st); }).catch(() => {});
  }
})();
