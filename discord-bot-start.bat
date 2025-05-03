@echo off
pm2 start index.js --name discord-bot

echo.
echo Press any key to continue...
pause >nul
cmd /k
