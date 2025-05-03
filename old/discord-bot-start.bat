@echo off
echo Starting discord-bot using pm2...
pm2 start index.js --name discord-bot

:: エラーが発生した場合のメッセージ
if %errorlevel% neq 0 (
    echo There was an error starting the bot.
    pause
)

echo.
echo Press any key to continue...
pause >nul
cmd /k
