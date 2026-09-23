/* A deliberately plain MATLAB editor: syntax colouring, line numbers, auto-indent, comment toggle,
   error-line and changed-line markers. No autocomplete, no suggestions, no AI. */
(function () {
  const KEYWORDS = new Set(("if elseif else end for parfor while do until switch case otherwise try catch " +
    "function return break continue global persistent unwind_protect unwind_protect_cleanup end_try_catch " +
    "endif endfor endwhile endfunction endswitch").split(" "));
  const BUILTINS = new Set(("abs acos all any asin atan atan2 bar ceil cos cumsum cumprod diff disp double error exp " +
    "eye fft fftshift figure filter filtfilt find fix floor fprintf freqz grid hold ifft imag isempty length linspace " +
    "load log log10 log2 max mean median min mod movmean norm num2str numel ones plot real rem repmat reshape round " +
    "sign sin size sort sprintf sqrt std subplot sum tan title transpose var xlabel ylabel legend zeros pi Inf NaN " +
    "true false butter conv interp1 isnan floor histogram stem axis xlim ylim mat2str strcat struct fieldnames " +
    "cell cellfun arrayfun rand randn randi warning isfield numel class isa int2str prod cross dot hann hamming " +
    "periodogram pwelch spectrogram findpeaks detrend resample decimate upsample downsample xcorr envelope abs").split(" "));

  const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
  const NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ij]?/y;
  const OPS = "+-*/\\^=<>~&|!:,;.@";

  function highlightLine(line, st) {
    // st.block: inside %{ ... %}
    const trimmed = line.trim();
    if (st.block) {
      if (trimmed === "%}" || trimmed === "#}") st.block = false;
      return `<span class="t-com">${BB.esc(line)}</span>`;
    }
    if (trimmed === "%{" || trimmed === "#{") { st.block = true; return `<span class="t-com">${BB.esc(line)}</span>`; }
    let out = "", i = 0, prevSig = "";
    const n = line.length;
    while (i < n) {
      const ch = line[i];
      if (ch === "%" || (ch === "#" && !/[A-Za-z0-9_]/.test(line[i - 1] || ""))) {
        out += `<span class="t-com">${BB.esc(line.slice(i))}</span>`; break;
      }
      if (ch === "'" && !/[A-Za-z0-9_)\]}.'"]/.test(line[i - 1] || " ")) {
        let j = i + 1;
        while (j < n) { if (line[j] === "'") { if (line[j + 1] === "'") { j += 2; continue; } break; } j++; }
        out += `<span class="t-str">${BB.esc(line.slice(i, j + 1))}</span>`; i = j + 1; prevSig = "'"; continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && line[j] !== '"') { if (line[j] === "\\") j++; j++; }
        out += `<span class="t-str">${BB.esc(line.slice(i, j + 1))}</span>`; i = j + 1; prevSig = '"'; continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] || ""))) {
        NUM.lastIndex = i; const m = NUM.exec(line);
        if (m) { out += `<span class="t-num">${m[0]}</span>`; i += m[0].length; prevSig = "0"; continue; }
      }
      if (/[A-Za-z_]/.test(ch)) {
        WORD.lastIndex = i; const w = WORD.exec(line)[0];
        const isField = line[i - 1] === ".";
        let cls = "";
        if (!isField && KEYWORDS.has(w)) cls = "t-kw";
        else if (!isField && BUILTINS.has(w)) cls = "t-fn";
        out += cls ? `<span class="${cls}">${w}</span>` : w;
        i += w.length; prevSig = "a"; continue;
      }
      if ("()[]{}".includes(ch)) { out += `<span class="t-br">${ch}</span>`; i++; prevSig = ch; continue; }
      if (OPS.includes(ch)) {
        let j = i; while (j < n && OPS.includes(line[j]) && line[j] !== "'") j++;
        out += `<span class="t-op">${BB.esc(line.slice(i, j))}</span>`; i = j; prevSig = "+"; continue;
      }
      if (ch === "'") { out += `<span class="t-op">'</span>`; i++; continue; } // transpose
      out += BB.esc(ch); i++;
    }
    return out;
  }

  function highlight(code) {
    const st = { block: false };
    return code.split("\n").map((l) => highlightLine(l, st)).join("\n") + "\n";
  }

  const OPENERS = /^\s*(if|elseif|else|for|parfor|while|switch|case|otherwise|try|catch|function|do|unwind_protect)\b/;

  class CodeEditor {
    constructor(host, opts = {}) {
      this.opts = opts;
      this.fontSize = opts.fontSize || 14;
      this.original = opts.original ?? "";
      this.errorLine = 0;
      this.changed = new Set();
      host.innerHTML = `
        <div class="ed">
          <div class="ed-gutter"><div class="ed-gutter-inner"></div></div>
          <div class="ed-main">
            <div class="ed-layer ed-marks"></div>
            <pre class="ed-layer ed-hl" aria-hidden="true"></pre>
            <textarea class="ed-input" spellcheck="false" autocomplete="off" autocorrect="off"
              autocapitalize="off" wrap="off" data-gramm="false" data-enable-grammarly="false"
              aria-label="Code editor"></textarea>
          </div>
        </div>`;
      this.root = host.firstElementChild;
      this.ta = this.root.querySelector(".ed-input");
      this.hl = this.root.querySelector(".ed-hl");
      this.marks = this.root.querySelector(".ed-marks");
      this.gut = this.root.querySelector(".ed-gutter-inner");
      this.setFontSize(this.fontSize);
      this.ta.value = opts.value || "";
      this._bind();
      this.render();
    }

    _bind() {
      const ta = this.ta;
      ta.addEventListener("input", () => { this.errorLine = 0; this.render(); this.opts.onChange?.(this.value); });
      ta.addEventListener("scroll", () => this._sync());
      ["keyup", "click", "select", "focus"].forEach((e) => ta.addEventListener(e, () => this._cursor()));
      document.addEventListener("selectionchange", () => { if (document.activeElement === ta) this._cursor(); });
      ta.addEventListener("keydown", (e) => this._key(e));
    }

    get value() { return this.ta.value; }
    setValue(v, original) {
      if (original !== undefined) this.original = original;
      this.ta.value = v;
      this.errorLine = 0;
      this.ta.scrollTop = 0; this.ta.scrollLeft = 0;
      this.ta.setSelectionRange(0, 0);
      this.render();
    }
    setReadOnly(ro) { this.ta.readOnly = ro; this.root.classList.toggle("readonly", ro); }
    focus() { this.ta.focus({ preventScroll: true }); }
    setFontSize(px) {
      this.fontSize = Math.max(11, Math.min(22, px));
      this.root.style.setProperty("--ed-fs", this.fontSize + "px");
      this.root.style.setProperty("--ed-lh", Math.round(this.fontSize * 1.65) + "px");
      this.root.style.setProperty("--ed-pad", "14px");
      this.lh = Math.round(this.fontSize * 1.65);
      this.render && this.hl && this.render();
    }
    setErrorLine(n) { this.errorLine = n || 0; this._marks(); this._gutter(); if (n) this.reveal(n); }
    reveal(line) {
      const top = (line - 1) * this.lh;
      const ta = this.ta;
      if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - this.lh * 3)
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    }
    gotoLine(line) {
      const lines = this.value.split("\n");
      line = Math.max(1, Math.min(lines.length, line));
      let pos = 0; for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
      this.focus(); this.ta.setSelectionRange(pos, pos + lines[line - 1].length);
      this.reveal(line); this._cursor();
    }

    render() {
      const v = this.value;
      this.hl.innerHTML = highlight(v);
      this.lineCount = v.split("\n").length;
      clearTimeout(this._dt);
      this._dt = setTimeout(() => { this.changed = BB.changedLines(this.original, this.value); this._gutter(); this.opts.onDiff?.(this.changed.size); }, 120);
      this._gutter(); this._cursor(); this._sync();
    }

    _gutter() {
      const cur = this.curLine || 1;
      let h = "";
      for (let i = 1; i <= this.lineCount; i++) {
        const c = [i === cur ? "cur" : "", this.changed.has(i) ? "chg" : "", i === this.errorLine ? "err" : ""].join(" ");
        h += `<div class="ed-ln ${c}">${i}</div>`;
      }
      this.gut.innerHTML = h;
    }

    _marks() {
      const bar = (line, cls) => `<div class="ed-bar ${cls}" style="top:calc(var(--ed-pad) + ${(line - 1) * this.lh}px)"></div>`;
      let h = "";
      if (this.curLine && document.activeElement === this.ta) h += bar(this.curLine, "cur");
      if (this.errorLine) h += bar(this.errorLine, "err");
      this.marks.innerHTML = h;
    }

    _cursor() {
      const pos = this.ta.selectionStart;
      const before = this.value.slice(0, pos);
      const line = before.split("\n").length;
      const col = pos - before.lastIndexOf("\n");
      if (line !== this.curLine) { this.curLine = line; this._gutter(); }
      this._marks();
      this.opts.onCursor?.(line, col);
    }

    _sync() {
      const x = this.ta.scrollLeft, y = this.ta.scrollTop;
      this.hl.style.transform = `translate(${-x}px, ${-y}px)`;
      this.marks.style.transform = `translate(0, ${-y}px)`;
      this.gut.style.transform = `translateY(${-y}px)`;
    }

    /* Insert text through execCommand so the browser keeps native undo/redo. */
    _insert(text) {
      if (!document.execCommand("insertText", false, text)) {
        const { selectionStart: s, selectionEnd: e } = this.ta;
        this.ta.setRangeText(text, s, e, "end");
        this.ta.dispatchEvent(new Event("input"));
      }
    }

    _selectLines() {
      const v = this.value;
      let s = this.ta.selectionStart, e = this.ta.selectionEnd;
      if (e > s && v[e - 1] === "\n") e--;
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      let le = v.indexOf("\n", e); if (le === -1) le = v.length;
      return [ls, le];
    }

    _mapLines(fn) {
      const [ls, le] = this._selectLines();
      const block = this.value.slice(ls, le);
      const next = block.split("\n").map(fn).join("\n");
      this.ta.setSelectionRange(ls, le);
      this._insert(next);
      this.ta.setSelectionRange(ls, ls + next.length);
    }

    _key(e) {
      const ta = this.ta;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") { e.preventDefault(); (e.shiftKey ? this.opts.onSubmit : this.opts.onRun)?.(); return; }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); this.opts.onSave?.(); return; }
      if (ta.readOnly) return;
      if (mod && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        const [ls, le] = this._selectLines();
        const lines = this.value.slice(ls, le).split("\n");
        const all = lines.filter((l) => l.trim()).every((l) => /^\s*%/.test(l));
        this._mapLines((l) => all ? l.replace(/^(\s*)% ?/, "$1") : (l.trim() ? l.replace(/^(\s*)/, "$1% ") : l));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const multi = this.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
        if (e.shiftKey) this._mapLines((l) => l.replace(/^( {1,4}|\t)/, ""));
        else if (multi) this._mapLines((l) => "    " + l);
        else this._insert("    ");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
        e.preventDefault();
        const v = this.value, s = ta.selectionStart;
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        const line = v.slice(lineStart, s);
        let indent = line.match(/^\s*/)[0];
        if (OPENERS.test(line) && !/\bend\b\s*;?\s*(%.*)?$/.test(line)) indent += "    ";
        this._insert("\n" + indent);
        return;
      }
    }
  }

  window.CodeEditor = CodeEditor;
  window.highlightMatlab = highlight;
})();
