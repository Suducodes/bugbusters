"""Bug Busters - offline, AI-free MATLAB (GNU Octave) compiler for the debugging contest.

Run:  docker compose up -d --build     (recommended: Octave bundled, sandboxed)
      python app.py                    (needs GNU Octave installed)

Put problem scripts (.m) and data files (.mat, .csv) in the `files` folder: .m files show up in
the "Open" menu, and every file is available to load() in every run.
"""
import os
import re
import secrets
import time

from flask import Flask, jsonify, request, send_from_directory

from runner import OctaveRunner

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("BB_DATA_DIR", os.path.join(BASE, "data"))
FILES_DIR = os.environ.get("BB_FILES_DIR", os.path.join(BASE, "files"))
STATIC = os.path.join(BASE, "static")
# Set these as environment variables / secrets. If missing, random ones are generated and printed
# in the server log, so the public repository never contains a working PIN.
UNLOCK_PIN = os.environ.get("BB_UNLOCK_PIN") or str(secrets.randbelow(9000) + 1000)
ORGANISER_PIN = os.environ.get("BB_ORGANISER_PIN") or secrets.token_hex(3)
TIMEOUT = int(os.environ.get("BB_TIMEOUT", "15"))
LOG = os.path.join(DATA_DIR, "events.log")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FILES_DIR, exist_ok=True)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
runner = OctaveRunner(DATA_DIR, FILES_DIR, runner_user=os.environ.get("BB_RUNNER_USER"),
                      max_concurrent=int(os.environ.get("BB_MAX_CONCURRENT", "0")) or None)


def _files():
    return sorted(f for f in os.listdir(FILES_DIR)
                  if os.path.isfile(os.path.join(FILES_DIR, f)) and not f.startswith("."))


@app.after_request
def _headers(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory(STATIC, p)


@app.get("/api/info")
def info():
    files = _files()
    return jsonify({"engine": runner.available,
                    "scripts": [f for f in files if f.lower().endswith(".m")],
                    "data": [f for f in files if not f.lower().endswith(".m")]})


@app.get("/api/script/<name>")
def script(name):
    name = os.path.basename(name)
    path = os.path.join(FILES_DIR, name)
    if not name.lower().endswith(".m") or not os.path.isfile(path):
        return jsonify({"error": "not found"}), 404
    with open(path, encoding="utf-8", errors="replace") as f:
        return jsonify({"name": name, "code": f.read()})


@app.post("/api/run")
def run():
    code = str((request.get_json(silent=True) or {}).get("code", ""))[:50000]
    res = runner.run(code, files=_files(), timeout=TIMEOUT)
    return jsonify({k: res.get(k) for k in ("status", "stdout", "stderr", "error", "vars",
                                            "figures", "figure_errors", "time_ms", "truncated")})


@app.post("/api/event")
def event():
    """Lock events are printed on the server console and appended to data/events.log."""
    d = request.get_json(silent=True) or {}
    clean = lambda s: re.sub(r"[\r\n\t]", " ", str(s or ""))[:80]
    line = (f"{time.strftime('%H:%M:%S')}  {request.remote_addr:<15}  {clean(d.get('reg')):<14}"
            f"  {clean(d.get('name')):<24}  {clean(d.get('type'))}")
    print("  LOCK  " + line if d.get("type") != "unlocked" else "  ok    " + line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------------------------
# Organiser page: add / remove problem scripts and data files during the event (PIN protected)
# ---------------------------------------------------------------------------------------------
ALLOWED_EXT = (".m", ".mat", ".csv", ".txt", ".dat")


def _org_ok():
    return request.headers.get("X-PIN", "") == ORGANISER_PIN


def _safe_name(name):
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(str(name or "")).strip())[:80]
    if not name or name.startswith(".") or not name.lower().endswith(ALLOWED_EXT):
        return None
    return name


@app.get("/organiser")
def organiser_page():
    return send_from_directory(STATIC, "organiser.html")


@app.get("/api/org/files")
def org_files():
    if not _org_ok():
        time.sleep(0.6)
        return jsonify({"error": "Wrong PIN"}), 403
    return jsonify([{"name": f, "size": os.path.getsize(os.path.join(FILES_DIR, f)),
                     "mtime": os.path.getmtime(os.path.join(FILES_DIR, f))} for f in _files()])


@app.post("/api/org/script")
def org_script():
    if not _org_ok():
        return jsonify({"error": "Wrong PIN"}), 403
    d = request.get_json(silent=True) or {}
    raw = str(d.get("name", "")).strip()
    name = _safe_name(raw if raw.lower().endswith(".m") else raw + ".m")
    if not name:
        return jsonify({"error": "Give the script a name, e.g. problem2.m"}), 400
    with open(os.path.join(FILES_DIR, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(str(d.get("code", "")))
    return jsonify({"ok": True, "name": name})


@app.post("/api/org/upload")
def org_upload():
    if not _org_ok():
        return jsonify({"error": "Wrong PIN"}), 403
    saved, skipped = [], []
    for f in request.files.getlist("files"):
        name = _safe_name(f.filename)
        if not name:
            skipped.append(f.filename)
            continue
        f.save(os.path.join(FILES_DIR, name))
        saved.append(name)
    return jsonify({"saved": saved, "skipped": skipped})


@app.delete("/api/org/files/<name>")
def org_delete(name):
    if not _org_ok():
        return jsonify({"error": "Wrong PIN"}), 403
    path = os.path.join(FILES_DIR, os.path.basename(name))
    if os.path.isfile(path):
        os.remove(path)
    return jsonify({"ok": True})


@app.post("/api/unlock")
def unlock():
    pin = str((request.get_json(silent=True) or {}).get("pin", ""))
    if pin != UNLOCK_PIN:
        time.sleep(0.6)
        return jsonify({"ok": False}), 403
    return jsonify({"ok": True})


if __name__ == "__main__":
    # Hugging Face Spaces (SPACE_ID set) expect port 7860.
    port = int(os.environ.get("BB_PORT") or os.environ.get("PORT") or (7860 if os.environ.get("SPACE_ID") else 8080))
    print("=" * 60)
    print("  Bug Busters compiler")
    print(f"  Octave     : {runner.octave or 'NOT FOUND'}")
    print(f"  Sandbox    : user={runner.runner_user or '-'}  network={'blocked' if runner.network_blocked else 'open'}")
    print(f"  Files dir  : {FILES_DIR}  ({len(_files())} files)")
    print(f"  Unlock PIN : {UNLOCK_PIN}")
    print(f"  Organiser  : http://<this-machine-ip>:{port}/organiser   (PIN: {ORGANISER_PIN})")
    print(f"  Open       : http://<this-machine-ip>:{port}/")
    print("=" * 60, flush=True)
    try:
        from waitress import serve
        serve(app, host="0.0.0.0", port=port, threads=32)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
