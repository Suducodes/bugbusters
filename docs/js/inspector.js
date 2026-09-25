/* Inspector page: see who submitted each question, review the changes, run the code on the local
   Octave engine, and give marks. Also manages questions, the clock and the unlock PIN. */
(function () {
  const { $, $$, esc, icons, toast } = BB;
  const root = $("#root");
  const cfg = window.BB_CONFIG || {};
  const ls = {
    get(k, d) { try { const v = localStorage.getItem("bb-insp-" + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("bb-insp-" + k, v); } catch (e) {} },
  };
  const D = {
    tab: "marking", problems: [], solutions: {}, subs: [], students: {}, events: [], settings: null,
    selQ: null, selSub: null, filter: "todo", octave: ls.get("octave", cfg.OCTAVE_URL || "http://localhost:8080"),
    octaveOk: null, offset: 0, sig: {},
  };

  const subState = (s) => s.marks == null ? "new" : s.marked_version === s.version ? "marked" : "updated";
  const qNo = (pid) => D.problems.findIndex((p) => p.id === pid) + 1;
  const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const fmtT = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const num = (x) => (Math.round(+x * 100) / 100).toString();

  /* ================================================================ login */
  function gate(msg) {
    root.innerHTML = `<div class="gate"><form class="card" id="lf">
      <div class="brand" style="margin-bottom:16px">${BB.brandHtml()}</div>
      <h2 style="margin:0 0 4px">Inspector</h2><p style="margin:0 0 16px;color:var(--text-2);font-size:13px">Review submissions, run them in Octave and give marks.</p>
      ${!SB.configured ? `<div class="chip red" style="height:auto;padding:8px 10px;margin-bottom:12px;white-space:normal">Set SUPABASE_URL and SUPABASE_ANON_KEY in docs/js/config.js</div>` : ""}
      <div class="field"><label>Email</label><input class="input" type="email" id="em" autocomplete="username" required></div>
      <div class="field"><label>Password</label><input class="input" type="password" id="pw" autocomplete="current-password" required></div>
      ${msg ? `<div class="chip red" style="height:auto;padding:8px 10px;margin-bottom:12px;white-space:normal">${esc(msg)}</div>` : ""}
      <button class="btn btn-primary btn-lg" style="width:100%">Sign in</button>
      <button type="button" class="btn btn-ghost" id="signup" style="width:100%;margin-top:8px">First time? Create inspector account</button>
      <button type="button" class="btn btn-ghost" id="forgot" style="width:100%">Set / reset password</button></form></div>`;
    $("#forgot").onclick = async () => {
      const email = $("#em").value.trim();
      if (!email) return gate("Type your email above, then click “Set / reset password”.");
      try {
        await SB.recover(email, location.origin + location.pathname);
        gate(`Password link sent to ${email}. Open it on this laptop: it brings you back here to choose a new password.`);
      } catch (err) { gate(err.message); }
    };
    $("#signup").onclick = async () => {
      const email = $("#em").value.trim(), pw = $("#pw").value;
      if (!email || pw.length < 6) return gate("Type the email and a password (at least 6 characters) above, then click “Create inspector account”.");
      try {
        const r = await SB.signUp(email, pw);
        const confirmed = r.access_token || r.user?.email_confirmed_at || r.email_confirmed_at;
        gate(confirmed ? `Account created for ${email}. Now add it to the inspector list (see below), then sign in.`
                       : `Account created. Open the confirmation email Supabase sent to ${email} and click the link, then add it to the inspector list and sign in.`);
        showSql(email);
      } catch (err) {
        gate(/duplicate key|already registered|already exists/i.test(err.message)
          ? `An account for ${email} already exists. Click “Set / reset password” to get a link to choose its password.` : err.message);
      }
    };
    $("#lf").onsubmit = async (e) => {
      e.preventDefault();
      try { await SB.signIn($("#em").value.trim(), $("#pw").value); await start(); }
      catch (err) {
        const hint = {
          "Invalid login credentials": "Wrong email or password (Supabase: Invalid login credentials). Check the user exists in Authentication → Users and was created with a password.",
          "Email not confirmed": "This user isn't confirmed yet. In Supabase → Authentication → Users, recreate it with “Auto Confirm User” ticked.",
        }[err.message];
        gate(hint || err.message);
      }
    };
  }

  function showSql(email) {
    const box = document.createElement("div");
    box.className = "pre";
    box.style.cssText = "user-select:text;margin-top:12px";
    box.textContent = `insert into public.inspectors (email) values ('${email.replace(/'/g, "''")}');`;
    const hint = document.createElement("p");
    hint.style.cssText = "font-size:12.5px;color:var(--text-2);margin:12px 0 0";
    hint.textContent = "Run this once in Supabase → SQL Editor (it gives the account inspector access):";
    $("#lf").append(hint, box);
  }

  async function start() {
    let rows;
    try { rows = await SB.select("inspectors", "select=email"); }
    catch (e) { SB.signOut(); return gate(e.message); }
    if (!rows.length) {
      const email = SB.session?.email || $("#em")?.value || "your@email";
      SB.signOut();
      gate("Signed in, but this account isn't on the inspector list yet.");
      return showSql(email);
    }
    shell();
    await load(true);
    setInterval(() => load(false), 5000);
    pingOctave(); setInterval(pingOctave, 15000);
    setInterval(clock, 1000);
  }

  /* ================================================================ data */
  async function load(first) {
    try {
      const [problems, sols, subs, studs, settings, events] = await Promise.all([
        SB.select("problems", "select=*&order=position,id"),
        SB.select("solutions", "select=*"),
        SB.select("submissions", "select=*&order=submitted_at"),
        SB.select("students", "select=*&order=created_at"),
        SB.select("settings", "select=*&id=eq.1"),
        SB.select("events", "select=*&order=created_at.desc&limit=300"),
      ]);
      D.problems = problems;
      D.solutions = Object.fromEntries(sols.map((s) => [s.problem_id, s.code]));
      D.subs = subs;
      D.students = Object.fromEntries(studs.map((s) => [s.reg_no, s]));
      D.settings = settings[0];
      D.events = events;
      if (first) { try { const st = await SB.rpc("bb_state"); D.offset = Date.parse(st.now) / 1000 - Date.now() / 1000; } catch (e) {} }
      if (D.selQ == null && problems.length) D.selQ = problems[0].id;
      $("#netpill")?.classList.remove("bad");
    } catch (e) {
      if (e.status === 401) { SB.signOut(); return gate("Session expired. Sign in again."); }
      $("#netpill")?.classList.add("bad");
      return;
    }
    renderNav();
    if (D.tab === "marking") renderMarking(first);
    else if (D.tab === "results") renderResults();
    else if (D.tab === "log") renderLog();
  }

  async function pingOctave() {
    const wasOk = D.octaveOk;
    try {
      const r = await fetch(D.octave + "/api/info", { cache: "no-store" });
      D.octaveOk = r.ok && (await r.json()).engine;
    } catch (e) { D.octaveOk = false; }
    const p = $("#octpill");
    if (!p) return;
    // This page is served over https; Chrome shows a one-time "Allow this site to access your
    // local network?" popup the first time it reaches http://localhost. Until that's accepted,
    // every request fails silently (no visible error) - point inspectors at the fix instead of
    // just saying "offline".
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(D.octave);
    const needsPermission = !D.octaveOk && isLocal && location.protocol === "https:";
    p.className = "pillx " + (D.octaveOk ? "ok" : needsPermission ? "warn" : "bad");
    p.innerHTML = `<i></i>${D.octaveOk ? "Octave ready" : needsPermission ? "Octave: allow local network?" : "Octave offline"}`;
    p.title = D.octaveOk ? "Local Octave engine (click to re-check)"
      : needsPermission ? "Chrome may be showing a popup asking to allow this site to access your local network - click Allow, then click here to re-check. If there's no popup, start the engine: double-click start_windows.bat on this laptop."
      : "Can't reach the Octave engine. Start it on this laptop (double-click start_windows.bat), then click here to re-check.";
    if (needsPermission && !wasOk && !D.warnedOctave) { D.warnedOctave = true; toast("Chrome may be asking to allow local network access for this site - click Allow, then the Octave pill up top.", "warn", 9000); }
  }

  /* ================================================================ shell */
  function shell() {
    root.innerHTML = `
      <header class="top"><span class="brand">${BB.brandHtml()}</span><span class="eyebrow">// inspector</span><span class="spacer"></span>
        <span class="pillx" id="clockpill"><i></i>…</span>
        <span class="pillx" id="todopill"></span>
        <button class="pillx" id="octpill" title="Local Octave engine (click to re-check)"><i></i>Octave…</button>
        <span class="pillx ok" id="netpill" title="Database connection"><i></i>Live</span>
        <button class="btn btn-sm icon-btn btn-ghost" id="theme">${icons.moon}</button>
        <button class="btn btn-sm btn-ghost" id="out">${icons.logout} Sign out</button></header>
      <nav class="nav" id="nav"></nav>
      <div class="view" id="view"></div>`;
    $("#theme").onclick = () => BB.toggleTheme();
    $("#out").onclick = () => { SB.signOut(); location.reload(); };
    $("#octpill").onclick = pingOctave;
    renderNav();
  }

  function renderNav() {
    const todo = D.subs.filter((s) => subState(s) !== "marked").length;
    const locks = D.events.filter((e) => /^LOCKED/.test(e.type) && Date.now() - Date.parse(e.created_at) < 600000).length;
    const tabs = [["marking", "Marking", todo], ["questions", "Questions"], ["results", "Results"], ["log", "Lock log", locks], ["settings", "Clock & settings"]];
    const html = tabs.map(([k, l, n]) => `<button data-t="${k}" class="${D.tab === k ? "on" : ""}">${l}${n ? ` <span class="n">${n}</span>` : ""}</button>`).join("");
    const nav = $("#nav");
    if (nav && nav.innerHTML !== html) { nav.innerHTML = html; $$("#nav button").forEach((b) => b.onclick = () => go(b.dataset.t)); }
    const tp = $("#todopill");
    if (tp) { tp.className = "pillx " + (todo ? "warn" : "ok"); tp.innerHTML = `<i></i>${todo ? `${todo} to mark` : "All marked"}`; }
  }

  function go(tab) {
    D.tab = tab; D.sig = {};
    renderNav();
    ({ marking: () => renderMarking(true), questions: renderQuestions, results: renderResults, log: renderLog, settings: renderSettings })[tab]();
  }

  function clock() {
    const p = $("#clockpill"); if (!p || !D.settings) return;
    const s = D.settings, t = Date.now() / 1000 + D.offset;
    const end = s.ends_at ? Date.parse(s.ends_at) / 1000 : null;
    if (!s.is_open || (end && t >= end)) { p.className = "pillx bad"; p.innerHTML = "<i></i>Submissions closed"; }
    else if (end) { const left = end - t; p.className = "pillx " + (left < 600 ? "warn" : "ok"); p.innerHTML = `<i></i>Open · ${BB.fmtDuration(left)} left`; }
    else { p.className = "pillx ok"; p.innerHTML = "<i></i>Open · no end time"; }
  }

  /* ================================================================ marking */
  function renderMarking(force) {
    const view = $("#view");
    if (force || !$(".mark", view)) {
      view.innerHTML = `<div class="mark">
        <section class="col"><div class="hd"><h3>Questions</h3></div><div class="scroll" id="qcol"></div></section>
        <section class="col"><div class="hd"><h3 id="ncolTitle">Submitted</h3><span class="spacer"></span>
          <div class="seg" id="seg"><button data-f="todo">To mark</button><button data-f="all">All</button></div></div>
          <div class="scroll"><div class="names" id="ncol"></div></div></section>
        <section class="col review" id="rcol"><div class="empty">Pick a name to review their code.</div></section>
      </div>`;
      $$("#seg button").forEach((b) => b.onclick = () => { D.filter = b.dataset.f; D.sig = {}; renderMarking(false); });
      D.sig = {};
    }
    $$("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.f === D.filter));

    // questions column
    const qhtml = D.problems.map((p, i) => {
      const subs = D.subs.filter((s) => s.problem_id === p.id);
      const todo = subs.filter((s) => subState(s) !== "marked").length;
      return `<button class="qbtn ${D.selQ === p.id ? "on" : ""}" data-q="${p.id}"><span class="qn">Q${i + 1}${p.published ? "" : " · hidden"}</span><b>${esc(p.title)}</b>
        <span class="c"><span class="chip grey">${subs.length} in</span>${todo ? `<span class="chip amber">${todo} to mark</span>` : subs.length ? `<span class="chip green">all marked</span>` : ""}</span></button>`;
    }).join("") || `<div class="empty">No questions yet. Add them in the Questions tab.</div>`;
    if (D.sig.q !== qhtml) { D.sig.q = qhtml; $("#qcol").innerHTML = qhtml; $$("#qcol .qbtn").forEach((b) => b.onclick = () => { D.selQ = +b.dataset.q; D.selSub = null; D.sig = {}; renderMarking(false); }); }

    // names box
    const p = D.problems.find((x) => x.id === D.selQ);
    $("#ncolTitle").textContent = p ? `Q${qNo(p.id)} · submitted` : "Submitted";
    let list = D.subs.filter((s) => s.problem_id === D.selQ);
    if (D.filter === "todo") list = list.filter((s) => subState(s) !== "marked" || s.id === D.selSub);
    const order = { updated: 0, new: 1, marked: 2 };
    list.sort((a, b) => order[subState(a)] - order[subState(b)] || Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
    const nhtml = list.map((s) => {
      const st = subState(s), who = D.students[s.reg_no] || { name: s.reg_no };
      return `<button class="nm ${st} ${D.selSub === s.id ? "on" : ""}" data-s="${s.id}"><span class="av">${st === "marked" ? num(s.marks) : initials(who.name)}</span>
        <span class="tx"><b>${esc(who.name)}</b><span>${esc(s.reg_no)} · ${fmtT(s.submitted_at)}${s.version > 1 ? ` · v${s.version}` : ""}</span></span>
        ${st === "new" ? `<span class="chip">NEW</span>` : st === "updated" ? `<span class="chip amber">UPDATED</span>` : `<span class="chip green">${num(s.marks)}/${num(p?.max_marks ?? 0)}</span>`}</button>`;
    }).join("") || `<div class="empty">${D.filter === "todo" ? "Nothing left to mark here 🎉" : "No submissions yet."}</div>`;
    if (D.sig.n !== nhtml) { D.sig.n = nhtml; $("#ncol").innerHTML = nhtml; $$("#ncol .nm").forEach((b) => b.onclick = () => { D.selSub = +b.dataset.s; D.sig.n = null; renderMarking(false); }); }

    // review pane: only rebuild when the selection or its version changes (keeps typed marks)
    const sub = D.subs.find((s) => s.id === D.selSub);
    const rsig = sub ? `${sub.id}:${sub.version}` : "none";
    if (D.sig.r !== rsig) { D.sig.r = rsig; renderReview(sub); }
  }

  function renderReview(sub) {
    const rc = $("#rcol");
    if (!sub) { rc.innerHTML = `<div class="empty">Pick a name to review their code.</div>`; return; }
    const p = D.problems.find((x) => x.id === sub.problem_id);
    const who = D.students[sub.reg_no] || { name: sub.reg_no };
    const ref = D.solutions[p.id];
    rc.innerHTML = `
      <div class="rv-head"><div><div class="eyebrow">Q${qNo(p.id)} · ${esc(p.title)}</div><h3>${esc(who.name)} <span class="mono" style="font-size:12px;color:var(--text-3);font-weight:600">${esc(sub.reg_no)}</span></h3></div>
        <span class="spacer"></span><span class="chip grey">v${sub.version} · ${fmtT(sub.submitted_at)}</span>
        ${subState(sub) === "updated" ? `<span class="chip amber">Re-submitted after marking (was ${num(sub.marks)})</span>` : ""}</div>
      <div class="rv-tools">
        <div class="seg" id="vseg"><button data-v="diff" class="on">Changes</button><button data-v="code">Full code</button>${ref ? `<button data-v="ref">Reference</button>` : ""}</div>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="copyBtn">📋 Copy for MATLAB</button>
        <button class="btn btn-sm btn-primary" id="runBtn">${icons.play} Run in Octave</button>
        ${ref ? `<button class="btn btn-sm" id="runRef">${icons.play} Run reference</button>` : ""}
      </div>
      <div class="rv-body"><div class="rv-code" id="rvCode"></div><div class="rv-out" id="rvOut"><span class="meta">Press “Run in Octave” (Ctrl+Enter) to execute this submission on your laptop.${ref ? " “Run reference” runs the correct solution for comparison." : ""}</span></div></div>
      <div class="markbar">
        <b>Marks</b><input class="input score" id="score" type="number" min="0" max="${+p.max_marks}" step="0.5" value="${sub.marks ?? ""}" placeholder="–"><span style="color:var(--text-3);font-weight:700">/ ${num(p.max_marks)}</span>
        <button class="btn btn-sm" data-q="0">0</button><button class="btn btn-sm" data-q="${p.max_marks / 2}">½</button><button class="btn btn-sm btn-green" data-q="${p.max_marks}">Full</button>
        <input class="input" id="cmt" placeholder="Comment (optional)" style="flex:1;min-width:160px" value="${esc(sub.comment || "")}">
        <button class="btn btn-primary" id="saveBtn">Save &amp; next ↵</button>
      </div>`;
    const show = (v) => {
      $$("#vseg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      const box = $("#rvCode");
      if (v === "diff") box.innerHTML = sub.code === p.buggy_code ? `<div class="empty">No changes: the student submitted the original buggy code.</div>` : BB.diffHtml(p.buggy_code, sub.code);
      else { box.innerHTML = `<div class="edbox"></div>`; const ed = new CodeEditor($(".edbox", box), { value: v === "ref" ? ref : sub.code, original: p.buggy_code, fontSize: 13, onRun: () => runOctave(sub.code, "submission") }); ed.setReadOnly(true); }
    };
    $$("#vseg button").forEach((b) => b.onclick = () => show(b.dataset.v));
    show("diff");
    $("#copyBtn").onclick = async () => { try { await navigator.clipboard.writeText(sub.code); toast("Code copied. Paste it into MATLAB.", "ok", 2000); } catch (e) { toast("Copy failed", "error"); } };
    $("#runBtn").onclick = () => runOctave(sub.code, `${who.name}'s code`);
    if (ref) $("#runRef").onclick = () => runOctave(ref, "reference solution");
    $$(".markbar [data-q]").forEach((b) => b.onclick = () => { $("#score").value = num(b.dataset.q); $("#score").focus(); });
    const save = () => saveMarks(sub, p);
    $("#saveBtn").onclick = save;
    ["#score", "#cmt"].forEach((s) => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }));
    rc.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runOctave(sub.code, `${who.name}'s code`); } };
    setTimeout(() => $("#score")?.focus(), 30);
  }

  async function runOctave(code, label) {
    const out = $("#rvOut");
    if (!out) return;
    out.innerHTML += `\n<span class="cmd">&gt;&gt; run ${esc(label)}</span>  <span class="meta">${new Date().toLocaleTimeString()}</span>\n<span class="meta">running…</span>`;
    out.scrollTop = out.scrollHeight;
    let r;
    try {
      const res = await fetch(D.octave + "/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      r = await res.json();
    } catch (e) {
      out.innerHTML = out.innerHTML.replace(/<span class="meta">running…<\/span>$/, `<span class="err">Can't reach the Octave engine at ${esc(D.octave)}. Start it on this laptop with: docker compose up -d</span>\n`);
      D.octaveOk = false; pingOctave(); return;
    }
    let h = "";
    if (r.stdout) h += esc(r.stdout.replace(/\s+$/, "")) + "\n";
    if (r.stderr) h += `<span class="warn">${esc(r.stderr)}</span>\n`;
    if (r.error) h += `<span class="err">${r.status === "blocked" ? "Blocked" : r.status === "timeout" ? "Time limit" : "Error"}${r.error.line ? ` at line ${r.error.line}` : ""}: ${esc(r.error.message)}</span>\n`;
    if (!r.stdout && !r.stderr && !r.error) h += `<span class="meta">(no output)</span>\n`;
    (r.figures || []).forEach((f) => { h += `<img src="${f}" alt="figure">`; });
    h += `<span class="meta">${r.status === "ok" ? "✓ finished" : "✗ " + r.status} in ${r.time_ms} ms</span>\n`;
    out.innerHTML = out.innerHTML.replace(/<span class="meta">running…<\/span>$/, h);
    out.scrollTop = out.scrollHeight;
  }

  async function saveMarks(sub, p) {
    const raw = $("#score").value.trim();
    const marks = raw === "" ? null : +raw;
    if (marks != null && (isNaN(marks) || marks < 0 || marks > +p.max_marks)) { toast(`Marks must be between 0 and ${num(p.max_marks)}`, "error"); return; }
    const patch = { marks, comment: $("#cmt").value.trim() || null, marked_version: marks == null ? null : sub.version,
                    marked_at: marks == null ? null : new Date().toISOString(), marked_by: SB.session?.email || null };
    try {
      const [row] = await SB.update("submissions", `id=eq.${sub.id}`, patch);
      Object.assign(sub, row || patch);
      const live = D.subs.find((x) => x.id === sub.id);
      if (live && live !== sub) Object.assign(live, row || patch);
      toast(marks == null ? "Marks cleared" : `Saved ${num(marks)}/${num(p.max_marks)} for ${(D.students[sub.reg_no] || {}).name || sub.reg_no}`, "ok", 1600);
    } catch (e) { toast(e.message, "error"); return; }
    // next: another unmarked in this question, else the first question with work left
    const pending = (pid) => D.subs.filter((s) => s.problem_id === pid && subState(s) !== "marked").sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
    let next = pending(D.selQ)[0];
    if (!next) for (const q of D.problems) { const n = pending(q.id)[0]; if (n) { next = n; D.selQ = q.id; break; } }
    D.selSub = next ? next.id : null;
    D.sig = {};
    renderNav(); renderMarking(false);
  }

  /* ================================================================ questions */
  function renderQuestions(selId) {
    const view = $("#view");
    const sel = D.problems.find((p) => p.id === (selId ?? D.editQ)) || null;
    D.editQ = sel?.id ?? null;
    view.innerHTML = `<div class="page pgrid">
      <section class="card"><div class="hd"><h3>Questions</h3><span class="spacer"></span><button class="btn btn-sm btn-green" id="newQ">+ New</button></div>
        <div class="plist">${D.problems.map((p, i) => `<button data-e="${p.id}" class="${p.id === D.editQ ? "on" : ""}"><span class="mono" style="font-size:12px;color:var(--text-3)">Q${i + 1}</span><b>${esc(p.title)}</b>${p.published ? `<span class="chip green">live</span>` : `<span class="chip grey">hidden</span>`}</button>`).join("") || `<div class="empty">No questions yet.</div>`}</div></section>
      <section class="card" id="qform"></section></div>`;
    $$(".plist [data-e]").forEach((b) => b.onclick = () => renderQuestions(+b.dataset.e));
    $("#newQ").onclick = () => { D.editQ = null; qform(null); };
    qform(sel);
  }

  function qform(p) {
    const f = $("#qform");
    const isNew = !p;
    p = p || { title: "", position: D.problems.length + 1, max_marks: 10, published: false, statement: "", buggy_code: "% Q.m\n" };
    f.innerHTML = `<div class="hd"><h3>${isNew ? "New question" : "Edit question"}</h3><span class="spacer"></span>
        ${isNew ? "" : `<button class="btn btn-sm btn-danger" id="delQ">Delete</button>`}<button class="btn btn-sm btn-primary" id="saveQ">Save</button></div>
      <div class="bd">
        <div class="form-grid">
          <div class="field"><label>Title (shown on the student's box)</label><input class="input" id="qt" value="${esc(p.title)}"></div>
          <div class="field"><label>Max marks</label><input class="input" type="number" id="qm" min="0" step="0.5" value="${p.max_marks}"></div>
          <div class="field"><label>Order</label><input class="input" type="number" id="qp" value="${p.position}"></div>
        </div>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="qpub" ${p.published ? "checked" : ""}> <b>Visible to students</b>&nbsp;(untick to prepare questions in advance)</label>
        <div class="field"><label>Question text (supports **bold**, \`code\`, - lists)</label><textarea class="input" id="qs" rows="5" style="font-family:var(--font);font-size:13.5px">${esc(p.statement)}</textarea></div>
        <div class="two">
          <div class="field"><label>Buggy code (students get this)</label><div class="edbox2" id="edB"></div><button class="btn btn-sm" id="tB" style="margin-top:8px">${icons.play} Test in Octave</button></div>
          <div class="field"><label>Reference solution (optional, only inspectors see it)</label><div class="edbox2" id="edS"></div><button class="btn btn-sm" id="tS" style="margin-top:8px">${icons.play} Test in Octave</button></div>
        </div>
        <div id="qout"></div>
      </div>`;
    const eb = new CodeEditor($("#edB"), { value: p.buggy_code, original: p.buggy_code, fontSize: 13 });
    const es = new CodeEditor($("#edS"), { value: isNew ? "" : (D.solutions[p.id] || ""), original: p.buggy_code, fontSize: 13 });
    const test = async (code, label) => {
      $("#qout").innerHTML = `<div class="pre">Running ${label}…</div>`;
      try {
        const r = await (await fetch(D.octave + "/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) })).json();
        $("#qout").innerHTML = `<div class="pre">${esc(label)}\n${esc(r.stdout || "")}${r.error ? `\n${r.error.line ? "Line " + r.error.line + ": " : ""}${esc(r.error.message)}` : ""}\n[${r.status} · ${r.time_ms} ms${r.figures?.length ? ` · ${r.figures.length} figure(s)` : ""}]</div>`;
      } catch (e) { $("#qout").innerHTML = `<div class="pre">Octave engine not reachable at ${esc(D.octave)}.\nStart it on this laptop (double-click start_windows.bat), or if it's already running, check whether Chrome popped up an "allow local network access" prompt for this site and click Allow.</div>`; }
    };
    $("#tB").onclick = () => test(eb.value, "buggy code");
    $("#tS").onclick = () => test(es.value, "reference solution");
    $("#saveQ").onclick = async () => {
      const row = { title: $("#qt").value.trim(), max_marks: +$("#qm").value || 0, position: +$("#qp").value || 0, published: $("#qpub").checked, statement: $("#qs").value, buggy_code: eb.value };
      if (!row.title) return toast("Give the question a title", "error");
      try {
        let id = p.id;
        if (isNew) { const [r] = await SB.insert("problems", row); id = r.id; }
        else await SB.update("problems", `id=eq.${id}`, row);
        if (es.value.trim()) await SB.insert("solutions", { problem_id: id, code: es.value }, true);
        else if (!isNew) await SB.remove("solutions", `problem_id=eq.${id}`);
        toast(row.published ? "Saved. Students will see it within 20 s." : "Saved (hidden from students)", "ok");
        await load(false); renderQuestions(id);
      } catch (e) { toast(e.message, "error"); }
    };
    if (!isNew) $("#delQ").onclick = async () => {
      if (!confirm(`Delete “${p.title}” and all its submissions and marks?`)) return;
      try { await SB.remove("problems", `id=eq.${p.id}`); D.editQ = null; await load(false); renderQuestions(); } catch (e) { toast(e.message, "error"); }
    };
  }

  /* ================================================================ results */
  function results() {
    const rows = Object.values(D.students).map((st) => {
      let total = 0, todo = 0, done = 0;
      const cells = D.problems.map((p) => {
        const s = D.subs.find((x) => x.reg_no === st.reg_no && x.problem_id === p.id);
        if (!s) return { t: "–" };
        done++;
        if (s.marks == null) { todo++; return { t: "?", c: "amber" }; }
        total += +s.marks;
        if (subState(s) === "updated") todo++;
        return { t: num(s.marks), c: subState(s) === "updated" ? "amber" : "green" };
      });
      return { st, cells, total, todo, done };
    });
    rows.sort((a, b) => b.total - a.total || a.st.name.localeCompare(b.st.name));
    let rank = 0, prev = null;
    rows.forEach((r, i) => { if (r.total !== prev) { rank = i + 1; prev = r.total; } r.rank = rank; });
    return rows;
  }

  function renderResults() {
    const rows = results();
    const max = D.problems.reduce((a, p) => a + +p.max_marks, 0);
    $("#view").innerHTML = `<div class="page"><div style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><h2 style="margin:0">Results</h2><span class="chip grey">${rows.length} students</span><span class="spacer"></span><button class="btn btn-sm" id="csv">⬇ Download CSV</button></div>
      <div class="card tablecard"><table class="table"><thead><tr><th>Rank</th><th>Student</th>${D.problems.map((p, i) => `<th class="num" title="${esc(p.title)}">Q${i + 1}<br><span style="font-weight:600">/${num(p.max_marks)}</span></th>`).join("")}<th class="num">Total /${num(max)}</th><th>Status</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="num"><b>${r.rank}</b></td><td><b>${esc(r.st.name)}</b><div class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(r.st.reg_no)}</div></td>
        ${r.cells.map((c) => `<td class="num">${c.c ? `<span class="chip ${c.c}">${c.t}</span>` : `<span style="color:var(--text-3)">${c.t}</span>`}</td>`).join("")}
        <td class="num"><b style="font-size:16px">${num(r.total)}</b></td><td>${r.todo ? `<span class="chip amber">${r.todo} to mark</span>` : r.done ? `<span class="chip green">complete</span>` : `<span class="chip grey">no submissions</span>`}</td></tr>`).join("") || `<tr><td colspan="99" class="empty">No students yet.</td></tr>`}
      </tbody></table></div>
      <p style="font-size:12.5px;color:var(--text-3)">? = submitted but not marked yet · amber = re-submitted after marking (old marks shown) · – = not submitted</p></div>`;
    $("#csv").onclick = () => {
      const head = ["Rank", "Register No", "Name", ...D.problems.map((p, i) => `Q${i + 1} ${p.title} (/${num(p.max_marks)})`), "Total"];
      const lines = [head, ...rows.map((r) => [r.rank, r.st.reg_no, r.st.name, ...r.cells.map((c) => c.t === "–" ? "" : c.t), num(r.total)])]
        .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }));
      a.download = "bugbusters_results.csv"; a.click();
    };
  }

  /* ================================================================ lock log */
  function renderLog() {
    const counts = {};
    D.events.filter((e) => /^LOCKED/.test(e.type)).forEach((e) => { counts[e.reg_no] = (counts[e.reg_no] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const html = `<div class="page"><div class="setgrid">
      <section class="card"><div class="hd"><h3>Lock events</h3><span class="spacer"></span><span class="label-caps">live</span></div>
        ${D.events.map((e) => `<div class="ev ${/^LOCKED/.test(e.type) ? "lock" : ""}"><span class="t">${fmtT(e.created_at)}</span><div><b>${esc(e.name || e.reg_no)}</b> <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(e.reg_no || "")}</span><div class="what">${esc(e.type)}</div></div></div>`).join("") || `<div class="empty">No lock events yet.</div>`}</section>
      <section class="card"><div class="hd"><h3>Most locks</h3></div>
        ${top.map(([reg, n]) => `<div class="ev"><b style="flex:1">${esc((D.students[reg] || {}).name || reg)} <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(reg)}</span></b><span class="chip ${n >= 3 ? "red" : "amber"}">${n} lock${n > 1 ? "s" : ""}</span></div>`).join("") || `<div class="empty">Nobody has been locked.</div>`}</section>
    </div></div>`;
    if (D.sig.log !== html) { D.sig.log = html; $("#view").innerHTML = html; }
  }

  /* ================================================================ settings */
  function renderSettings() {
    const s = D.settings || {};
    const dt = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${d.getFullYear()}-${BB.pad(d.getMonth() + 1)}-${BB.pad(d.getDate())}T${BB.pad(d.getHours())}:${BB.pad(d.getMinutes())}`; };
    const studs = Object.values(D.students);
    $("#view").innerHTML = `<div class="page setgrid">
      <section class="card"><div class="hd"><h3>Contest clock</h3></div><div class="bd">
        <div class="field"><label>Contest title</label><input class="input" id="st" value="${esc(s.title || "")}"></div>
        <div class="field"><label>Submissions close at</label><input class="input" type="datetime-local" id="se" value="${dt(s.ends_at)}"></div>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="so" ${s.is_open ? "checked" : ""}> Submissions open</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" id="saveS">Save</button><button class="btn" data-add="10">+10 min</button><button class="btn" data-add="30">+30 min</button><button class="btn btn-danger" id="closeNow">Close now</button><button class="btn" id="noEnd">Remove end time</button></div>
        <p style="font-size:12.5px;color:var(--text-3);margin:12px 0 0">Students see a countdown. Submissions made offline in the last ${s.grace_seconds ?? 120} s before closing are still accepted when they reconnect.</p>
      </div></section>
      <section class="card"><div class="hd"><h3>Unlock PIN &amp; Octave</h3></div><div class="bd">
        <div class="field"><label>New invigilator unlock PIN</label><div style="display:flex;gap:8px"><input class="input mono" id="pin" placeholder="at least 4 characters"><button class="btn" id="savePin">Change</button></div></div>
        <div class="field"><label>Octave engine on this laptop</label><div style="display:flex;gap:8px"><input class="input mono" id="oct" value="${esc(D.octave)}"><button class="btn" id="saveOct">Save</button></div></div>
        <p style="font-size:12.5px;color:var(--text-3);margin:0">Start the engine with <code>docker compose up -d</code> in the bugbusters folder. Put data files that questions load (e.g. signal.mat) in its <code>files</code> folder.</p>
      </div></section>
      <section class="card" style="grid-column:1/-1"><div class="hd"><h3>Students (${studs.length})</h3></div>
        <div class="tablecard"><table class="table"><thead><tr><th>Name</th><th>Register No</th><th>Last seen</th><th>Laptop</th><th></th></tr></thead><tbody>
        ${studs.map((st) => `<tr><td><b>${esc(st.name)}</b></td><td class="mono">${esc(st.reg_no)}</td><td>${BB.ago(Date.parse(st.last_seen) / 1000)}</td><td>${st.device_key ? `<span class="chip green">bound</span>` : `<span class="chip grey">released</span>`}</td>
          <td style="text-align:right"><button class="btn btn-sm" data-rel="${esc(st.reg_no)}" title="Let this student log in on a different laptop">Release laptop</button> <button class="btn btn-sm btn-danger" data-delst="${esc(st.reg_no)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty">No students yet.</td></tr>`}
        </tbody></table></div></section></div>`;
    const upd = async (patch, msg) => { try { await SB.update("settings", "id=eq.1", patch); toast(msg || "Saved", "ok"); await load(false); renderSettings(); } catch (e) { toast(e.message, "error"); } };
    $("#saveS").onclick = () => upd({ title: $("#st").value.trim() || "Bug Busters", ends_at: $("#se").value ? new Date($("#se").value).toISOString() : null, is_open: $("#so").checked });
    $$("[data-add]").forEach((b) => b.onclick = () => {
      const base = Math.max(Date.now() + D.offset * 1000, s.ends_at ? Date.parse(s.ends_at) : 0);
      upd({ ends_at: new Date(base + +b.dataset.add * 60000).toISOString(), is_open: true }, `Extended by ${b.dataset.add} min`);
    });
    $("#closeNow").onclick = () => confirm("Close submissions now for everyone?") && upd({ is_open: false }, "Submissions closed");
    $("#noEnd").onclick = () => upd({ ends_at: null }, "End time removed");
    $("#savePin").onclick = async () => { try { await SB.rpc("bb_set_pin", { p_pin: $("#pin").value }); $("#pin").value = ""; toast("Unlock PIN changed", "ok"); } catch (e) { toast(e.message, "error"); } };
    $("#saveOct").onclick = () => { D.octave = $("#oct").value.trim().replace(/\/+$/, ""); ls.set("octave", D.octave); pingOctave(); toast("Saved", "ok"); };
    $$("[data-rel]").forEach((b) => b.onclick = async () => { await SB.update("students", `reg_no=eq.${encodeURIComponent(b.dataset.rel)}`, { device_key: null }); toast("Released. They can log in on another laptop now.", "ok"); await load(false); renderSettings(); });
    $$("[data-delst]").forEach((b) => b.onclick = async () => { if (!confirm(`Delete ${b.dataset.delst} and all their submissions?`)) return; await SB.remove("students", `reg_no=eq.${encodeURIComponent(b.dataset.delst)}`); await load(false); renderSettings(); });
  }

  /* ================================================================ password links */
  // Links from Supabase emails (password reset, invite, sign-up confirmation) come back with the
  // session in the URL fragment: #access_token=...&type=recovery
  function setPasswordPage(token) {
    root.innerHTML = `<div class="gate"><form class="card" id="spf">
      <div class="brand" style="margin-bottom:16px">${BB.brandHtml()}</div>
      <h2 style="margin:0 0 4px">Choose your password</h2><p style="margin:0 0 16px;color:var(--text-2);font-size:13px">For the inspector account. At least 6 characters.</p>
      <div class="field"><label>New password</label><input class="input" type="password" id="np1" autocomplete="new-password" required minlength="6"></div>
      <div class="field"><label>Repeat password</label><input class="input" type="password" id="np2" autocomplete="new-password" required minlength="6"></div>
      <div id="spmsg"></div>
      <button class="btn btn-primary btn-lg" style="width:100%">Save password</button></form></div>`;
    $("#spf").onsubmit = async (e) => {
      e.preventDefault();
      const a = $("#np1").value, b = $("#np2").value;
      const say = (m) => { $("#spmsg").innerHTML = `<div class="chip red" style="height:auto;padding:8px 10px;margin-bottom:12px;white-space:normal">${esc(m)}</div>`; };
      if (a.length < 6) return say("At least 6 characters.");
      if (a !== b) return say("The two passwords don't match.");
      try {
        const u = await SB.setPassword(token, a);
        history.replaceState(null, "", location.pathname);
        gate(`Password saved for ${u.email || "your account"}. Sign in below.`);
        if (u.email) $("#em").value = u.email;
      } catch (err) { say(err.message); }
    };
  }

  /* ================================================================ boot */
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("access_token") && /recovery|invite|signup|magiclink/.test(hash.get("type") || "")) setPasswordPage(hash.get("access_token"));
  else if (hash.get("error_description")) { history.replaceState(null, "", location.pathname); gate(hash.get("error_description").replace(/\+/g, " ") + " Ask for a new link."); }
  else if (SB.session) start().catch(() => gate()); else gate();
})();
