@echo off
title OpenBlueprint
echo Starting OpenBlueprint (Production Mode)...
echo.
echo App: http://localhost:3001
echo.
echo Press Ctrl+C to stop
echo.

set NODE_ENV=production
start http://localhost:3001
npx tsx src/server/index.ts
pause
