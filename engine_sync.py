"""Connects the local Octave engine to Supabase so the inspector's browser can run code on this
laptop without needing a direct http://localhost fetch.

Why: the inspector page is served over https (GitHub Pages); a plain https-page-to-localhost
fetch is gated by Chrome's Local Network Access feature, whose permission prompt is only shown to
sites enrolled in Google's origin-trial programme - ours isn't, so the request is just silently
blocked, with no prompt to accept. Sidestepping the browser/OS local-network boundary entirely: a
"Run" queues a row in the `runs` table; this module signs in as the same inspector and polls for
rows addressed to that email, runs them here, and writes the result back. Everything is an
ordinary https call to Supabase, the same as every other request the page already makes.
"""
import getpass
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
AUTH_FILE = os.path.join(os.environ.get("BB_DATA_DIR", os.path.join(BASE, "data")), "engine_auth.json")
POLL_SECONDS = 1.0
HEARTBEAT_SECONDS = 5.0


class SupaEngine:
    def __init__(self, url, anon_key):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.access_token = None
        self.refresh_token = None
        self.email = None

    # -------------------------------------------------------------------------------- transport
    def _call(self, method, path, body=None, auth=True, prefer=None):
        req = urllib.request.Request(self.url + path, method=method,
                                      data=json.dumps(body).encode() if body is not None else None)
        req.add_header("apikey", self.anon_key)
        req.add_header("Content-Type", "application/json")
        if auth and self.access_token:
            req.add_header("Authorization", "Bearer " + self.access_token)
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                detail = json.loads(raw)
                msg = detail.get("message") or detail.get("msg") or detail.get("error_description") or raw
            except Exception:
                msg = raw
            err = RuntimeError(f"{method} {path} -> {e.code}: {msg}")
            err.status = e.code
            raise err
        except urllib.error.URLError as e:
            raise RuntimeError(f"Can't reach {self.url}: {e.reason}")

    # ------------------------------------------------------------------------------------ auth
    def sign_in(self, email, password):
        r = self._call("POST", "/auth/v1/token?grant_type=password",
                       {"email": email, "password": password}, auth=False)
        self.access_token, self.refresh_token, self.email = r["access_token"], r["refresh_token"], email
        return r

    def refresh(self):
        r = self._call("POST", "/auth/v1/token?grant_type=refresh_token",
                       {"refresh_token": self.refresh_token}, auth=False)
        self.access_token = r["access_token"]
        self.refresh_token = r.get("refresh_token", self.refresh_token)

    def load_or_login(self):
        """Reuse a saved session if we have one; otherwise sign in from BB_ENGINE_EMAIL /
        BB_ENGINE_PASSWORD (for headless Docker, where there's no terminal to prompt on), or
        finally prompt interactively for the inspector's own login (native/Windows console) and
        remember it for next time."""
        if os.path.exists(AUTH_FILE):
            try:
                d = json.load(open(AUTH_FILE))
                self.refresh_token, self.email = d["refresh_token"], d["email"]
                self.refresh()
                print(f"  Signed in as : {self.email} (saved session)")
                return
            except Exception:
                pass  # saved session expired or invalid - fall through below

        env_email, env_pw = os.environ.get("BB_ENGINE_EMAIL"), os.environ.get("BB_ENGINE_PASSWORD")
        if env_email and env_pw:
            self.sign_in(env_email, env_pw)
        elif sys.stdin.isatty():
            print()
            print("  Sign in with your Bug Busters INSPECTOR account (the one you use on the")
            print("  inspector web page). This laptop's Octave engine will be tied to that login.")
            while True:
                email = input("  Inspector email: ").strip()
                password = getpass.getpass("  Password: ")
                try:
                    self.sign_in(email, password)
                    break
                except RuntimeError as e:
                    print(f"  Could not sign in ({e}). Try again.\n")
        else:
            raise RuntimeError("No saved session and no terminal to prompt on. Set BB_ENGINE_EMAIL "
                               "and BB_ENGINE_PASSWORD (e.g. in docker-compose.yml).")

        os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
        with open(AUTH_FILE, "w") as f:
            json.dump({"email": self.email, "refresh_token": self.refresh_token}, f)
        print(f"  Signed in as : {self.email}")

    def forget(self):
        try:
            os.remove(AUTH_FILE)
        except OSError:
            pass

    # ----------------------------------------------------------------------------------- loops
    def poll_runs(self, run_fn, stop_event):
        """run_fn(code) -> a JSON-safe result dict, same shape as the /api/run response."""
        backoff = 1.0
        while not stop_event.is_set():
            try:
                q = f"select=id,code,label&status=eq.pending&assigned_email=eq.{urllib.parse.quote(self.email)}&order=created_at&limit=3"
                rows = self._call("GET", "/rest/v1/runs?" + q) or []
                for row in rows:
                    try:
                        self._call("PATCH", f"/rest/v1/runs?id=eq.{row['id']}", {"status": "running"})
                    except RuntimeError:
                        continue  # someone/something else already claimed it
                    try:
                        result = run_fn(row["code"])
                        self._call("PATCH", f"/rest/v1/runs?id=eq.{row['id']}",
                                  {"status": "done", "result": result, "done_at": _now_iso()})
                    except Exception as e:
                        self._call("PATCH", f"/rest/v1/runs?id=eq.{row['id']}",
                                  {"status": "error", "result": {"error": {"line": 0, "message": str(e)}},
                                   "done_at": _now_iso()})
                backoff = 1.0
            except RuntimeError as e:
                if getattr(e, "status", None) == 401:
                    try:
                        self.refresh()
                    except RuntimeError:
                        pass
                backoff = min(backoff * 1.5, 20)
            time.sleep(POLL_SECONDS if backoff <= 1.0 else backoff)

    def heartbeat_loop(self, octave_path_fn, stop_event):
        while not stop_event.is_set():
            try:
                self._call("POST", "/rest/v1/engine_status?on_conflict=email",
                          {"email": self.email, "updated_at": _now_iso(), "octave_path": octave_path_fn() or ""},
                          prefer="resolution=merge-duplicates")
            except RuntimeError:
                pass
            stop_event.wait(HEARTBEAT_SECONDS)

    def start(self, run_fn, octave_path_fn):
        stop_event = threading.Event()
        threading.Thread(target=self.poll_runs, args=(run_fn, stop_event), daemon=True).start()
        threading.Thread(target=self.heartbeat_loop, args=(octave_path_fn, stop_event), daemon=True).start()
        return stop_event


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
