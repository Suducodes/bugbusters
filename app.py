"""Bug Busters - local Octave engine for the inspector's laptop.

The inspector page (hosted on GitHub Pages) sends a student's submitted code to this server at
http://localhost:8080/api/run and shows the output, errors and figures. Nothing here is exposed to
students; it only needs to run on the inspector's laptop.

Run:  docker compose up -d --build     (recommended: Octave bundled, sandboxed)
      python app.py                    (needs GNU Octave installed)

Data files that problems load (e.g. signal.mat) go in the `files` folder.
"""
import os
import re

from flask import Flask, jsonify, request

from runner import OctaveRunner

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("BB_DATA_DIR", os.path.join(BASE, "data"))
FILES_DIR = os.environ.get("BB_FILES_DIR", os.path.join(BASE, "files"))
TIMEOUT = int(os.environ.get("BB_TIMEOUT", "20"))
# Pages allowed to use this engine from the browser.
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


@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin", "")
    if origin and ALLOWED_ORIGINS.match(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        # Chrome's Private Network Access: an https page may call localhost only if we opt in.
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Vary"] = "Origin"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/<path:_>", methods=["OPTIONS"])
def _preflight(_):
    return ("", 204)


@app.get("/")
def home():
    ok = "online" if runner.available else "NOT FOUND"
    return (f"<body style='font-family:system-ui;padding:40px'><h2>Bug Busters · Octave engine</h2>"
            f"<p>Octave: <b>{ok}</b></p><p>Data files: {', '.join(_files()) or 'none'}</p>"
            f"<p>Keep this running and use the inspector page.</p></body>")


@app.get("/api/info")
def info():
    return jsonify({"engine": runner.available, "data": _files()})


@app.post("/api/run")
def run():
    code = str((request.get_json(silent=True) or {}).get("code", ""))[:50000]
    res = runner.run(code, files=_files(), timeout=TIMEOUT)
    return jsonify({k: res.get(k) for k in ("status", "stdout", "stderr", "error", "vars",
                                            "figures", "figure_errors", "time_ms", "truncated")})


if __name__ == "__main__":
    port = int(os.environ.get("BB_PORT") or 8080)
    print("=" * 60)
    print("  Bug Busters · Octave engine (inspector laptop)")
    print(f"  Octave     : {runner.octave or 'NOT FOUND'}")
    print(f"  Data files : {', '.join(_files()) or 'none'}")
    print(f"  Listening  : http://localhost:{port}")
    print("=" * 60, flush=True)
    try:
        from waitress import serve
        serve(app, host="127.0.0.1" if os.environ.get("BB_LOCAL_ONLY") else "0.0.0.0", port=port, threads=16)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
