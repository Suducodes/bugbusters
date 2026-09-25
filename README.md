# Bug Busters · MATLAB Debugging Contest

An AI-free MATLAB debugging contest platform. Students fix buggy MATLAB scripts in a locked,
fullscreen browser page and submit their fix. Inspectors review each submission, run it for real
on **GNU Octave** (MATLAB-compatible), and give marks — all from a browser too.

**Live links**
- Students: `https://<your-username>.github.io/bugbusters/`
- Inspectors: `https://<your-username>.github.io/bugbusters/inspector.html`

## How it fits together

```
Student's browser  ──submits code (text)──►  Supabase (free database)  ◄──reads submissions── Inspector's browser
     (GitHub Pages, docs/index.html)                    │  ▲                                   (docs/inspector.html)
                                                          │  │ writes result                            │
                                              queues a "run" row  ◄────────────────────── "Run in Octave" inserts a row
                                                          ▼  │
                                                    Octave engine on the inspector's own laptop
                                                    (app.py + engine_sync.py, signed in as that
                                                          same inspector)
```

- **`docs/`** is the whole website, hosted free on **GitHub Pages**. It's static — no server of
  ours runs it.
- **Supabase** (free tier) stores questions, submissions, marks, lock events and the run queue.
  Set up once with `supabase/schema.sql`. Students and inspectors never see a login screen for it
  directly; the pages talk to it under the hood, and its access rules (in that same file) keep
  students from reading each other's code or the reference solutions.
- **`app.py` + `runner.py` + `engine_sync.py`** is a small Octave engine that runs **only on the
  inspector's own laptop** while marking. Clicking **"Run in Octave"** doesn't call the engine
  directly — it drops a row in a `runs` table; the engine, signed in with that inspector's own
  login, picks up rows addressed to its own email, runs them, and writes the result back. (An
  earlier version had the browser fetch `http://localhost:8080` directly, but Chrome's Local
  Network Access permission prompt for an https page reaching localhost is gated behind an
  origin trial ours isn't enrolled in — it just silently blocks the request, no prompt ever
  shows. Routing through Supabase like everything else on the page sidesteps that entirely.)

Because only a few KB of text ever cross the internet (code in, results/marks out), this works
fine even on slow or unreliable college Wi-Fi.

## One-time setup

### 1. Supabase (the database)
1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, click **Run**.
3. **Project Settings → API**: copy the **Project URL** and the **anon public** (or
   **publishable**) key into `docs/js/config.js`.
4. **Authentication → Providers → Email**: turn **off** "Confirm email" (simpler for inspector
   accounts; students never use Supabase auth at all).
5. On the inspector page, click **"First time? Create inspector account"**, then run the one-line
   SQL it shows you (adds that email to `public.inspectors`).

### 2. GitHub Pages (the website)
Push this repo to GitHub, then **Settings → Pages → Build and deployment**: Source =
*Deploy from a branch*, Branch = `main`, folder = **`/docs`** → **Save**.

### 3. Octave engine (each inspector's laptop, on the day)
No Docker needed. Double-click **`start_windows.bat`**. First time, it needs:
- [GNU Octave](https://octave.org/download) installed (`winget install GNU.Octave` also works)
- Python 3 installed

It installs a couple of small Python packages, then asks you to **sign in with your inspector
email and password** (the same one you use on the inspector web page) — this ties the engine to
that account so runs from your browser reach your laptop. It remembers this afterwards (stored in
`data/engine_auth.json`), so you only sign in once. Keep the window open while marking; the
Octave status pill at the top of the inspector page turns green once it's connected. If several
inspectors mark at once, each just runs this on their own laptop with their own login — the
right runs automatically go to the right engine.

Prefer a sandboxed engine instead (blocks network access, runs submissions as an unprivileged
user)? `docker compose up -d --build` does the same job in a container — see `Dockerfile`. Since
`docker compose up -d` is headless (no console to sign in on), set `BB_ENGINE_EMAIL` /
`BB_ENGINE_PASSWORD` in `docker-compose.yml` instead (commented out there by default).

## Running the contest

- **Add questions**: inspector page → **Questions** → paste the buggy code (and, optionally, a
  reference solution), tick **Visible to students**, save. Anything typed there before ticking
  that box stays hidden — prep questions in advance safely.
- **Data files** a question needs (e.g. `signal.mat`): drop them in the `files/` folder next to
  `app.py` on the inspector's laptop; any question's code can `load()` them.
- **Clock**: **Clock & settings** sets when submissions close; students see a live countdown.
  Re-submissions are allowed until then — only the latest one is marked.
- **Marking**: **Marking** tab → pick a question → pick a student → see exactly what they
  changed → **Run in Octave** → type marks → **Save & next**.
- **Results**: totals, rank and a CSV export.
- **Screen lock**: a student's screen locks (red, full-screen) if they leave fullscreen, switch
  tab/window, reload, or paste text from outside the editor. Unlocking needs the **PIN**, set in
  **Clock & settings**.
- **Lock log**: every lock event, per student, so you can spot repeat offenders.

## Files

```
docs/                    the whole website (GitHub Pages serves this folder)
  index.html, js/student.js     student page: question grid, editor, submit, screen lock
  inspector.html, js/inspector.js   marking, questions, results, clock, lock log
  js/sb.js                 tiny Supabase client (no library download needed)
  js/config.js              <- put your Supabase URL/key here
supabase/schema.sql       run once in Supabase SQL Editor: tables + access rules
app.py, runner.py         Octave engine for the inspector's laptop (sandboxed deny-list + guards)
engine_sync.py            signs the engine in and syncs the run queue with Supabase
start_windows.bat         double-click to start the engine, no Docker
files/                    data files problems can load() (signal.mat etc.)
```
