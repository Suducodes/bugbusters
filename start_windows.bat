@echo off
REM Bug Busters compiler. Double-click to start (Docker Desktop must be running).
cd /d "%~dp0"
docker compose up -d --build
echo.
echo Students open:  http://<this laptop's IP>:8080
echo Lock log:       docker logs -f bugbusters
echo.
pause
