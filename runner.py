"""Sandboxed execution of participant MATLAB code on GNU Octave.

Layers of protection:
  1. Static scan: any identifier on the deny-list (system calls, file I/O, eval family, network,
     Java/Python bridges...) rejects the program before it runs.
  2. Guard functions: .m files shadowing the same functions sit first on the Octave path, so
     indirect calls such as cellfun('system', ...) or structfun(...) also fail, while Octave's
     own plotting code can still use them.
  3. Process limits: wall-clock timeout, CPU/memory/file-size/process rlimits, and on Linux the
     code runs as an unprivileged user that cannot read the app, the database or the reference
     solutions, and whose network traffic is rejected by iptables.
"""
import base64
import os
import re
import shutil
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time

IS_WINDOWS = os.name == "nt"
SCRIPT_NAME = "debug_me.m"

BLOCKED = {
    # shell / processes
    "system", "unix", "dos", "shell_cmd", "popen", "popen2", "pclose", "fork", "exec", "kill",
    "waitpid", "getpid", "setenv", "putenv", "unsetenv",
    # dynamic evaluation (would bypass the scan)
    "eval", "evalin", "evalc", "assignin", "feval", "builtin", "str2func", "inline",
    "cellfun_eval", "run", "source", "argv", "program_name", "program_invocation_name",
    # filesystem
    "fopen", "fileread", "fwrite", "fputs", "fdisp", "fgetl", "fgets", "fread", "fscanf",
    "textread", "textscan", "dlmread", "dlmwrite", "csvread", "csvwrite", "importdata",
    "readtable", "writetable", "readmatrix", "writematrix", "save", "diary", "cd", "chdir",
    "delete", "unlink", "rmdir", "mkdir", "movefile", "copyfile", "rename", "dir", "ls", "what",
    "which", "type", "edit", "open", "tempdir", "tempname", "path", "addpath", "rmpath",
    "genpath", "restoredefaultpath", "savepath", "urlread", "urlwrite", "webread",
    "webwrite", "websave", "web", "ftp", "sftp", "tcpclient", "udpport", "zip", "unzip",
    "gzip", "gunzip", "tar", "untar",
    # foreign interfaces
    "javaObject", "javaMethod", "javaArray", "java_get", "java_set", "javaaddpath", "py",
    "pyrun", "pyexec", "pycall", "perl", "python", "mex", "mkoctfile", "dlopen",
    # session control / interactive
    "exit", "quit", "keyboard", "input", "dbstop", "pkg", "history",
}

# Friendly reasons for the most common ones.
BLOCK_REASON = {
    "input": "interactive input is not available; assign the value directly",
    "keyboard": "interactive debugging is not available",
    "save": "writing files is disabled during the contest",
}

_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# Octave library routines allowed to reach guarded built-ins on the participant's behalf
# (plot export talks to gnuplot through popen/fopen/system).
_TRUSTED = ("^(__gnuplot|gnuplot_|__print|print$|drawnow$|__go_|__ghostscript|__add_default_menu"
            "|figure$|close$|closereq$|__img|saveas$|graphics_toolkit$|available_graphics_toolkits$)")


def scan(code):
    """Return (name, line) of the first blocked identifier, or None. Strings are scanned too,
    so feval('sys' ...) style tricks need `feval`, which is itself blocked."""
    for ln, line in enumerate(code.splitlines(), 1):
        stripped = line.strip()
        if re.match(r"^pkg\s+load\s+\w+\s*;?\s*(%.*)?$", stripped):
            continue  # harmless habit, packages are preloaded
        body = _strip_comment(line)
        for m in _IDENT.finditer(body):
            name = m.group(0)
            prev = body[m.start() - 1] if m.start() > 0 else ""
            if prev == ".":
                continue  # struct field, e.g. data.type
            if name in BLOCKED or name.startswith("java"):
                return name, ln
    return None


def _strip_comment(line):
    """Drop a trailing % comment, respecting quoted strings and the transpose operator."""
    out, in_str, quote = [], False, ""
    for i, ch in enumerate(line):
        if in_str:
            out.append(ch)
            if ch == quote:
                in_str = False
            continue
        if ch in "%#":
            break
        if ch == '"' or (ch == "'" and not (i > 0 and (line[i - 1].isalnum() or line[i - 1] in "_)]}.'"))):
            in_str, quote = True, ch
        out.append(ch)
    return "".join(out)


class OctaveRunner:
    def __init__(self, data_dir, files_dir, octave_bin=None, max_concurrent=None,
                 runner_user=None, toolkit=None):
        self.files_dir = files_dir
        self.work_root = os.path.join(data_dir, "runs")
        self.guard_dir = os.path.join(data_dir, "guard")
        self.octave = octave_bin or find_octave()
        # Switching to the sandbox user needs root; on hosts that already run us unprivileged
        # (e.g. Hugging Face Spaces) the deny-list and guards still apply.
        self.runner_user = runner_user if not IS_WINDOWS and os.geteuid() == 0 else None
        self.toolkit = toolkit
        n = max_concurrent or max(2, min(8, os.cpu_count() or 2))
        self.slots = threading.BoundedSemaphore(n)
        self.max_concurrent = n
        os.makedirs(self.work_root, exist_ok=True)
        self._write_guards()
        self.network_blocked = False
        if self.runner_user:
            # the runner must be able to traverse into its own scratch dir
            for d in (data_dir, self.work_root):
                os.chmod(d, 0o711)
            os.chmod(self.guard_dir, 0o755)  # Octave must be able to list it
            for f in os.listdir(self.guard_dir):
                os.chmod(os.path.join(self.guard_dir, f), 0o644)
            self.network_blocked = _block_network(self.runner_user)
            threading.Thread(target=self._reaper, daemon=True).start()

    @property
    def available(self):
        return bool(self.octave)

    # Names the static scan blocks but that must never be shadowed: the driver or Octave's own
    # library code depends on them (feval, delete for closing figures, ...).
    _NO_GUARD = {"eval", "evalin", "evalc", "assignin", "feval", "builtin", "str2func", "run",
                 "source", "pkg", "path", "addpath", "rmpath", "type", "delete", "tempdir", "exist"}

    def _classify(self):
        """exist() code per blocked name: 5 = built-in, 2 = .m file, 3 = .oct, 0 = missing."""
        names = sorted(BLOCKED - self._NO_GUARD)
        if not self.octave:
            return {}
        try:
            out = subprocess.run([self.octave, "--norc", "--quiet", "--no-window-system", "--eval",
                                  "n = strsplit('%s', ' '); for i = 1:numel(n), printf('%%s=%%d\\n', n{i}, exist(n{i})); end"
                                  % " ".join(names)], capture_output=True, text=True, timeout=60,
                                 stdin=subprocess.DEVNULL).stdout
            return {k: int(v) for k, v in (l.split("=") for l in out.splitlines() if "=" in l)}
        except Exception:
            return {}

    def _write_guards(self):
        """Shadow dangerous functions. Built-ins get a caller check: blocked when called from the
        participant's script (directly or through cellfun & co), passed through when Octave's own
        library code calls them (print needs fopen, gnuplot needs popen, ...). Script wrappers
        around the shell (unix, ls, copyfile, python, ...) are blocked outright."""
        os.makedirs(self.guard_dir, exist_ok=True)
        for f in os.listdir(self.guard_dir):
            os.remove(os.path.join(self.guard_dir, f))
        kinds = self._classify()
        for name in sorted(BLOCKED - self._NO_GUARD):
            kind = kinds.get(name, 0)
            if kind == 0:
                continue  # not present in this Octave build
            msg = f"error('Bug Busters: ''{name}'' is disabled in contest mode.');"
            if kind == 5:
                # Walk up the call stack. Reaching participant code (any file outside the Octave
                # installation) before a trusted graphics/print routine means the call originated
                # from the participant, e.g. structfun('system', ...), so it is refused.
                body = (f"  s = dbstack('-completenames');\n"
                        f"  h = strrep(OCTAVE_HOME(), '\\\\', '/');\n"
                        f"  for k = 2:numel(s)\n"
                        f"    if isempty(s(k).file) || ~strncmpi(strrep(s(k).file, '\\\\', '/'), h, numel(h))\n"
                        f"      {msg}\n"
                        f"    end\n"
                        f"    if ~isempty(regexp(s(k).name, '{_TRUSTED}', 'once')), break; end\n"
                        f"  end\n"
                        f"  if nargout > 0\n"
                        f"    [varargout{{1:nargout}}] = builtin('{name}', varargin{{:}});\n"
                        f"  else\n"
                        f"    builtin('{name}', varargin{{:}});\n"
                        f"  end\n")
            else:
                body = f"  {msg}\n"
            with open(os.path.join(self.guard_dir, name + ".m"), "w") as f:
                f.write(f"function varargout = {name}(varargin)\n{body}end\n")

    def _reaper(self):
        """Kill anything the sandbox user left running (e.g. a background process that escaped
        the run's process group)."""
        import pwd
        uid = pwd.getpwnam(self.runner_user).pw_uid
        seen = {}
        while True:
            time.sleep(15)
            alive = set()
            for pid in filter(str.isdigit, os.listdir("/proc")):
                try:
                    with open(f"/proc/{pid}/status") as f:
                        owner = next(int(l.split()[1]) for l in f if l.startswith("Uid:"))
                except Exception:
                    continue
                if owner != uid:
                    continue
                alive.add(pid)
                first = seen.setdefault(pid, time.time())
                if time.time() - first > 90:
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                    except Exception:
                        pass
            seen = {p: t for p, t in seen.items() if p in alive}

    # ---------------------------------------------------------------------------------------
    def run(self, code, files=(), check_vars=(), timeout=10):
        started = time.time()
        hit = scan(code)
        if hit:
            name, line = hit
            why = BLOCK_REASON.get(name, "it is disabled in contest mode")
            return {
                "status": "blocked", "stdout": "", "stderr": "",
                "error": {"line": line, "message": f"'{name}' is not allowed: {why}."},
                "vars": [], "figures": [], "time_ms": 0,
            }
        if not self.octave:
            return {"status": "engine_missing", "stdout": "", "stderr": "",
                    "error": {"line": 0, "message": "GNU Octave was not found on this laptop. "
                              "Install it from octave.org/download (or 'winget install GNU.Octave'), "
                              "then restart the engine. If it's installed somewhere unusual, set "
                              "the BB_OCTAVE environment variable to its octave-cli.exe path."},
                    "vars": [], "figures": [], "time_ms": 0}

        acquired = self.slots.acquire(timeout=60)
        if not acquired:
            return {"status": "busy", "stdout": "", "stderr": "",
                    "error": {"line": 0, "message": "Server is busy, try again in a moment."},
                    "vars": [], "figures": [], "time_ms": 0}
        work = tempfile.mkdtemp(prefix="run_", dir=self.work_root)
        try:
            return self._run_in(work, code, files, check_vars, timeout, started)
        finally:
            self.slots.release()
            shutil.rmtree(work, ignore_errors=True)

    def _run_in(self, work, code, files, check_vars, timeout, started):
        for fn in files:
            src = os.path.join(self.files_dir, fn)
            if os.path.isfile(src):
                shutil.copy(src, os.path.join(work, fn))
        with open(os.path.join(work, SCRIPT_NAME), "w", encoding="utf-8", newline="\n") as f:
            f.write(code if code.endswith("\n") else code + "\n")

        nonce = secrets.token_hex(12)
        driver = build_driver(nonce, self.guard_dir, self.toolkit)
        cmd = [self.octave, "--no-gui", "--norc", "--no-history", "--quiet", "--no-window-system",
               "--eval", driver]
        if os.path.basename(self.octave).lower().startswith("octave-cli"):
            cmd.remove("--no-gui")
        env = {"PATH": os.environ.get("PATH", ""), "HOME": work, "LANG": "C.UTF-8",
               "TERM": "dumb", "GNUTERM": "pngcairo"}
        if IS_WINDOWS:
            env.update({k: os.environ[k] for k in ("SYSTEMROOT", "TEMP", "TMP", "USERPROFILE")
                        if k in os.environ})
        kwargs = dict(cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                      stderr=subprocess.PIPE)
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000
        else:
            kwargs["start_new_session"] = True
            kwargs["preexec_fn"] = _limits(timeout)
            if self.runner_user:
                import pwd
                pw = pwd.getpwnam(self.runner_user)
                os.chown(work, pw.pw_uid, pw.pw_gid)
                for fn in os.listdir(work):
                    os.chown(os.path.join(work, fn), pw.pw_uid, pw.pw_gid)
                kwargs["user"], kwargs["group"] = pw.pw_uid, pw.pw_gid
                kwargs["extra_groups"] = []

        proc = subprocess.Popen(cmd, **kwargs)
        timed_out = False
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc)
            out, err = proc.communicate()
        elapsed = int((time.time() - started) * 1000)
        out = out.decode("utf-8", "replace")
        err = err.decode("utf-8", "replace")
        return parse_output(out, err, nonce, work, timed_out, timeout, elapsed, check_vars)


def _limits(timeout):
    def apply():
        import resource
        cpu = int(timeout) + 5
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        resource.setrlimit(resource.RLIMIT_AS, (3 * 1024 ** 3, 3 * 1024 ** 3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 ** 2, 20 * 1024 ** 2))
        resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))  # per sandbox user: no fork bombs
    return apply


def _block_network(user):
    """Reject all outbound traffic from the sandbox user (needs iptables + CAP_NET_ADMIN).
    Participant code then cannot reach the internet or the LAN, even if it escaped the guards."""
    if not shutil.which("iptables"):
        return False
    ok = True
    for tool in ("iptables", "ip6tables"):
        if not shutil.which(tool):
            continue
        rule = ["OUTPUT", "-m", "owner", "--uid-owner", user, "-j", "REJECT"]
        try:
            exists = subprocess.run([tool, "-C"] + rule, capture_output=True).returncode == 0
            if not exists:
                r = subprocess.run([tool, "-A"] + rule, capture_output=True)
                ok = ok and r.returncode == 0
        except Exception:
            ok = False
    return ok


def _kill_tree(proc):
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        proc.kill()


def build_driver(nonce, guard_dir, toolkit):
    guard = guard_dir.replace("\\", "/").replace("'", "''")
    tk = (toolkit or "").replace("'", "")
    return f"""
__bb_ws = warning();
warning('off', 'all');
try, pkg load signal; catch, end
__bb_tk = available_graphics_toolkits();
if ~isempty('{tk}') && any(strcmp(__bb_tk, '{tk}')), graphics_toolkit('{tk}');
elseif any(strcmp(__bb_tk, 'gnuplot')), graphics_toolkit('gnuplot'); end
set(0, 'defaultfigurevisible', 'off');
set(0, 'defaultfigurepaperunits', 'inches');
set(0, 'defaultfigurepaperposition', [0 0 8 4.2]);
addpath('{guard}', '-begin');
warning(__bb_ws);
warning('off', 'Octave:shadowed-function');
warning('off', 'Octave:graphics-toolkit-default');
more off;
clear __bb_tk __bb_ws ans;
__bb_ok = true;
try
  source('{SCRIPT_NAME}');
catch __bb_e
  __bb_ok = false;
end
__bb_r = fflush(stdout); __bb_r = fflush(stderr);
printf('\\n@@BB_{nonce}@@\\n');
if ~__bb_ok
  __bb_line = 0;
  for __bb_k = 1:builtin('numel', __bb_e.stack)
    if ~builtin('isempty', strfind(__bb_e.stack(__bb_k).file, '{SCRIPT_NAME}')) || strcmp(__bb_e.stack(__bb_k).name, 'debug_me')
      __bb_line = __bb_e.stack(__bb_k).line; break;
    end
  end
  __bb_tok = regexp(__bb_e.message, 'near line (\\d+)', 'tokens', 'once');
  if __bb_line == 0 && ~builtin('isempty', __bb_tok), __bb_line = str2double(__bb_tok{{1}}); end
  printf('ERR\\t%d\\t%s\\n', __bb_line, strrep(strrep(__bb_e.message, char(13), ''), char(10), '\\n'));
end
__bb_v = builtin('who');
for __bb_i = 1:builtin('numel', __bb_v)
  __bb_n = __bb_v{{__bb_i}};
  if strncmp(__bb_n, '__bb', 4), continue; end
  __bb_x = eval(__bb_n);
  % builtin(...) everywhere below: a student's own variable can be named sum/min/max/size/class/
  % etc, which would otherwise shadow the real function for the rest of this workspace and break
  % our own introspection (seen for real: `sum = a + b;` breaking the sum() call here).
  __bb_sz = sprintf('%dx', builtin('size', __bb_x)); __bb_sz = __bb_sz(1:end-1);
  __bb_p = '';
  if (builtin('isnumeric', __bb_x) || builtin('islogical', __bb_x))
    __bb_d = builtin('double', __bb_x(:));
    if ~builtin('isreal', __bb_d), __bb_d = builtin('abs', __bb_d); end
    if builtin('isempty', __bb_d), __bb_st = [0 0 0 0];
    else, __bb_st = [builtin('sum', __bb_d), builtin('sum', builtin('abs', __bb_d)), builtin('min', __bb_d), builtin('max', __bb_d)]; end
    if builtin('numel', __bb_x) == 1, __bb_p = builtin('num2str', __bb_x, 8);
    elseif builtin('numel', __bb_x) <= 8 && builtin('ndims', __bb_x) == 2, __bb_p = builtin('mat2str', __bb_x, 6); end
    printf('VAR\\t%s\\t%s\\t%s\\t%d\\t%.12g\\t%.12g\\t%.12g\\t%.12g\\t%s\\n', __bb_n, builtin('class', __bb_x), __bb_sz, builtin('numel', __bb_x), __bb_st, __bb_p);
  else
    if builtin('ischar', __bb_x), __bb_p = __bb_x(1:min(end, 80));
    elseif builtin('isstruct', __bb_x), __bb_p = builtin('strjoin', builtin('fieldnames', __bb_x)', ', ');
    elseif builtin('isa', __bb_x, 'function_handle'), __bb_p = builtin('func2str', __bb_x); end
    __bb_p = builtin('strrep', builtin('strrep', __bb_p, char(10), ' '), char(9), ' ');
    printf('VAR\\t%s\\t%s\\t%s\\t%d\\t\\t\\t\\t\\t%s\\n', __bb_n, builtin('class', __bb_x), __bb_sz, builtin('numel', __bb_x), __bb_p);
  end
end
__bb_f = builtin('sort', get(0, 'children'));
__bb_dev = '-dpng'; if strcmp(graphics_toolkit(), 'gnuplot'), __bb_dev = '-dpngcairo'; end
for __bb_i = 1:builtin('min', builtin('numel', __bb_f), 4)
  try
    print(__bb_f(__bb_i), sprintf('__bbfig_%d.png', __bb_i), __bb_dev, '-r100');
    printf('FIG\\t__bbfig_%d.png\\n', __bb_i);
  catch __bb_pe
    printf('FIGERR\\t%s\\n', __bb_pe.message);
  end
end
printf('END\\n');
"""


MAX_OUT = 60_000
_STDERR_NOISE = ("iconv failed", "execution_exception", "gnuplot graphics toolkit", "Ghostscript",
                 "ft_manager", "ft_text_renderer")


def parse_output(out, err, nonce, work, timed_out, timeout, elapsed, check_vars):
    marker = f"\n@@BB_{nonce}@@\n"
    user_out, meta = out, ""
    if marker in out:
        user_out, meta = out.split(marker, 1)
    work_fwd = work.replace("\\", "/")
    def clean(s):
        return s.replace(work + os.sep, "").replace(work_fwd + "/", "").replace(work, ".").replace(work_fwd, ".")
    user_out = clean(user_out)
    truncated = len(user_out) > MAX_OUT
    if truncated:
        user_out = user_out[:MAX_OUT] + "\n... output truncated ..."

    error, variables, figures, fig_errors = None, [], [], []
    for line in meta.splitlines():
        parts = line.split("\t")
        tag = parts[0]
        if tag == "ERR" and len(parts) >= 3:
            msg = clean("\t".join(parts[2:]).replace("\\n", "\n")).strip()
            error = {"line": int(parts[1] or 0), "message": msg}
        elif tag == "VAR" and len(parts) >= 10:
            name, cls, size, numel = parts[1], parts[2], parts[3], parts[4]
            stats = None
            if parts[5] != "":
                try:
                    stats = [float(p) for p in parts[5:9]]
                except ValueError:
                    stats = None
            variables.append({"name": name, "class": cls, "size": size,
                              "numel": int(numel or 0), "stats": stats,
                              "preview": "\t".join(parts[9:])})
        elif tag == "FIG" and len(parts) >= 2:
            p = os.path.join(work, parts[1])
            if os.path.isfile(p) and os.path.getsize(p) < 3_000_000:
                with open(p, "rb") as f:
                    figures.append("data:image/png;base64," + base64.b64encode(f.read()).decode())
        elif tag == "FIGERR":
            fig_errors.append(parts[1] if len(parts) > 1 else "plot export failed")

    finished = "\nEND" in "\n" + meta
    stderr = "\n".join(l for l in clean(err).splitlines()
                       if not any(n in l for n in _STDERR_NOISE)).strip()
    if timed_out:
        status = "timeout"
        error = {"line": 0, "message": f"Time limit exceeded ({timeout:g} s). Check for infinite loops."}
    elif error:
        status = "error"
    elif not finished:
        status = "crash"
        error = {"line": 0, "message": "Octave terminated unexpectedly." + (f"\n{stderr[-800:]}" if stderr else "")}
    else:
        status = "ok"
    return {"status": status, "stdout": user_out, "stderr": stderr[-4000:], "error": error,
            "vars": variables, "figures": figures, "figure_errors": fig_errors,
            "time_ms": elapsed, "truncated": truncated}


def find_octave():
    env = os.environ.get("BB_OCTAVE")
    if env and os.path.exists(env):
        return env
    for name in ("octave-cli", "octave"):
        p = shutil.which(name)
        if p:
            return p
    if IS_WINDOWS:
        import glob
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), r"C:\Octave",
                 os.path.expandvars(r"%LOCALAPPDATA%\Programs")]
        for root in roots:
            hits = sorted(glob.glob(os.path.join(root, "GNU Octave", "Octave-*", "mingw64", "bin", "octave-cli.exe"))
                          + glob.glob(os.path.join(root, "Octave-*", "mingw64", "bin", "octave-cli.exe")))
            if hits:
                return hits[-1]
    return None


# ---------------------------------------------------------------------------------------------
# Judging: compare a participant run against the reference run.
# ---------------------------------------------------------------------------------------------
_NUM = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$")


def _close(a, b, rel=1e-4, abs_=1e-6):
    if a != a and b != b:  # both NaN
        return True
    if a in (float("inf"), float("-inf")) or b in (float("inf"), float("-inf")):
        return a == b
    return abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


def _norm_lines(text):
    return [re.sub(r"\s+", " ", l).strip() for l in text.replace("\r", "").split("\n") if l.strip()]


def compare_output(got, expected):
    """Token-wise comparison with numeric tolerance. Returns (ok, first_mismatch_line_index)."""
    g, e = _norm_lines(got), _norm_lines(expected)
    for i in range(max(len(g), len(e))):
        if i >= len(g) or i >= len(e):
            return False, i
        gt, et = g[i].split(" "), e[i].split(" ")
        if len(gt) != len(et):
            return False, i
        for a, b in zip(gt, et):
            if a == b:
                continue
            if _NUM.match(a) and _NUM.match(b):
                if _close(float(a.rstrip("%")), float(b.rstrip("%"))):
                    continue
            return False, i
    return True, -1


def compare_vars(got_vars, exp_vars, names):
    got = {v["name"]: v for v in got_vars}
    exp = {v["name"]: v for v in exp_vars}
    for n in names:
        if n not in exp:
            continue
        if n not in got:
            return False, f"variable `{n}` is missing"
        a, b = got[n], exp[n]
        if a["size"] != b["size"]:
            return False, f"variable `{n}` has size {a['size']}, expected {b['size']}"
        if (a["stats"] is None) != (b["stats"] is None):
            return False, f"variable `{n}` has the wrong type ({a['class']})"
        if a["stats"] is not None:
            if not all(_close(x, y, 1e-6, 1e-9) for x, y in zip(a["stats"], b["stats"])):
                return False, f"variable `{n}` has the right size but wrong values"
        elif a["preview"] != b["preview"]:
            return False, f"variable `{n}` does not match"
    return True, ""


if __name__ == "__main__":
    # quick manual test: python runner.py file.m
    r = OctaveRunner(os.path.join(os.path.dirname(__file__), "data"),
                     os.path.join(os.path.dirname(__file__), "problems", "data"))
    print(r.octave)
    print(r.run(open(sys.argv[1]).read(), files=["signal.mat"]))
