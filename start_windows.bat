@echo off
REM Bug Busters - Octave engine for the inspector's laptop. No Docker needed.
REM Double-click this file to start it. Keep the window open while marking.
cd /d "%~dp0"

python --version >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install it from https://python.org/downloads then run this again.
  pause
  exit /b 1
)

echo Installing/checking Python packages...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt

echo.
echo If the banner below says "Octave: NOT FOUND", install it from
echo https://octave.org/download (or run: winget install GNU.Octave)
echo and start this file again.
echo.
python app.py
pause
