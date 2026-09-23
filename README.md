---
title: Bug Busters
emoji: 🐞
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
pinned: false
---

# Bug Busters · offline MATLAB compiler

A locked-down, AI-free MATLAB compiler page for the Bug Busters debugging contest. Code runs on
**GNU Octave** (MATLAB-compatible) on one server laptop. Students only need a browser on the
same network. Everything works **without internet**.

## Start

Docker Desktop must be running. Then double-click `start_windows.bat`, or run:

```
docker compose up -d --build
```

Students open `http://<server-laptop-IP>:8080`. Find the IP with `ipconfig`, and allow port
8080 in Windows Firewall.

## Problems and data files

Put the problem scripts (`.m`) and data files (`.mat`, `.csv`) in the **`files`** folder. No
restart is needed.

- `.m` files appear in the editor's **Open** menu. The first one opens automatically when a student starts.
- Every file in the folder can be used with `load(...)` from any script.

`files/debug_me.m` and `files/signal.mat` are the poster's example. Replace or delete them.

**During the event, from any laptop:** open `http://<server-IP>:8080/organiser` and enter the
organiser PIN (`BB_ORGANISER_PIN`). There you
can paste a new problem, **Test run** it, and **Publish to students**. You can also drag in
.m/.mat/.csv files, or edit and delete existing ones. Students get a "New problem" notification
within about 15 seconds, and the file appears in their 📂 Open menu.

## Screen lock

The screen **locks** when a student leaves fullscreen, switches tab or window, reloads the page,
pastes text from outside the editor, or presses developer-tool keys. The invigilator types the
**PIN** to unlock it. Set `BB_UNLOCK_PIN` and `BB_ORGANISER_PIN` in a `.env` file (locally) or as
Space secrets (Hugging Face). If they're missing, random PINs are printed in the server log.
After unlocking, **End session** clears the laptop for the next student.

Copy and paste only work inside the editor. There is no autocomplete. Student code has no
network access and can't run shell commands.

Live lock log for invigilators: `docker logs -f bugbusters`
