@echo off
title OpenBlueprint
echo Starting OpenBlueprint...
echo.
echo Backend server: http://localhost:3001
echo Frontend app:  http://localhost:5173
echo.
echo Press Ctrl+C to stop all services
echo.

start "OpenBlueprint Server" cmd /c "npx tsx src/server/index.ts"
timeout /t 3 /nobreak >nul
start http://localhost:5173
npx vite --config vite.config.ts --host

pause
