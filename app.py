"""Bug Busters - local Octave engine for the inspector's laptop.

The inspector page (hosted on GitHub Pages) queues a "Run" as a row in Supabase; this engine
signs in with the same inspector login, picks up rows addressed to that email, runs them on
GNU Octave, and writes the result back - all over ordinary https (see engine_sync.py for why
it's built this way instead of the browser calling http://localhost directly).

A plain HTTP API is also exposed on this machine (http://localhost:8080) for direct testing with
curl - nothing on the website calls it, so it's fine to ignore.

Run:  docker compose up -d --build     (recommended: Octave bundled, sandboxed)
      python app.py                    (needs GNU Octave installed)

Data files that problems load (e.g. signal.mat) go in the `files` folder.
"""
import os
import re
import sys
import threading

from flask import Flask, jsonify, request

import engine_sync
from runner import OctaveRunner

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("BB_DATA_DIR", os.path.join(BASE, "data"))
FILES_DIR = os.environ.get("BB_FILES_DIR", os.path.join(BASE, "files"))
TIMEOUT = int(os.environ.get("BB_TIMEOUT", "20"))
# Same project the website (docs/js/config.js) talks to. Override if you forked this for a
# different Supabase project.
SUPABASE_URL = os.environ.get("BB_SUPABASE_URL", "https://nyvququkfeqqjiwladmx.supabase.co")
SUPABASE_ANON_KEY = os.environ.get("BB_SUPABASE_ANON_KEY", "sb_publishable_QoGDg0YjMtgXdQwPqgXn2A_YoAyEZ3D")
# Pages allowed to use the local HTTP API from a browser (curl/testing only - the live site uses
# the Supabase queue instead, see engine_sync.py).
ALLOWED_ORIGINS = re.compile(os.environ.get(
    "BB_CORS", r"^(https://[a-z0-9-]+\.github\.io|http://(localhost|127\.0\.0\.1)(:\d+)?|null)$"))

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FILES_DIR, exist_ok=True)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
runner = OctaveRunner(DATA_DIR, FILES_DIR, runner_user=os.environ.get("BB_RUNNER_USER"),
                      max_concurrent=int(os.environ.get("BB_MAX_CONCURRENT", "0")) or None)


def _files():
    return sorted(f for f in os.listdir(FILES_DIR)
                  if os.path.isfile(os.path.join(FILES_DIR, f)) and not f.startswith("."))


def _run_result(code):
    res = runner.run(code, files=_files(), timeout=TIMEOUT)
    return {k: res.get(k) for k in ("status", "stdout", "stderr", "error", "vars",
                                    "figures", "figure_errors", "time_ms", "truncated")}


@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin", "")
    if origin and ALLOWED_ORIGINS.match(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Vary"] = "Origin"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/<path:_>", methods=["OPTIONS"])
def _preflight(_):
    return ("", 204)


@app.get("/")
def home():
    ok = "online" if runner.available else "NOT FOUND"
    who = f"signed in as <b>{engine.email}</b>" if engine.email else "not signed in yet"
    return (f"<body style='font-family:system-ui;padding:40px'><h2>Bug Busters · Octave engine</h2>"
            f"<p>Octave: <b>{ok}</b></p><p>Supabase sync: {who}</p>"
            f"<p>Data files: {', '.join(_files()) or 'none'}</p>"
            f"<p>Keep this window running while marking.</p></body>")


@app.get("/api/info")
def info():
    return jsonify({"engine": runner.available, "data": _files()})


@app.post("/api/run")
def run():
    code = str((request.get_json(silent=True) or {}).get("code", ""))[:50000]
    return jsonify(_run_result(code))


engine = engine_sync.SupaEngine(SUPABASE_URL, SUPABASE_ANON_KEY)

if __name__ == "__main__":
    port = int(os.environ.get("BB_PORT") or 8080)
    print("=" * 60)
    print("  Bug Busters · Octave engine (inspector laptop)")
    print(f"  Octave     : {runner.octave or 'NOT FOUND'}")
    print(f"  Data files : {', '.join(_files()) or 'none'}")

    if os.environ.get("BB_ENGINE_OFF"):
        print("  Supabase sync: disabled (BB_ENGINE_OFF set)")
    else:
        try:
            engine.load_or_login()
            engine.start(_run_result, lambda: runner.octave)
            print("  Supabase sync: on - the inspector page will show \"Octave ready\"")
        except Exception as e:
            print(f"  Supabase sync: FAILED to start ({e})")
            print("  The 'Run in Octave' button on the inspector page will not work until this")
            print("  is fixed. Local http://localhost testing below still works.")

    print(f"  Local API  : http://localhost:{port}  (for curl/testing only)")
    print("=" * 60, flush=True)
    try:
        from waitress import serve
        serve(app, host="127.0.0.1" if os.environ.get("BB_LOCAL_ONLY") else "0.0.0.0", port=port, threads=16)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
