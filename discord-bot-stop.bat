@echo off
cd /d "C:\Path\To\Your\Project\Directory"

echo Stoping discord-bot using pm2...
pm2 stop discord-bot

:: エラーが発生した場合のメッセージ
if %errorlevel% neq 0 (
    echo There was an error starting the bot.
    pause
)

echo.
echo Press any key to continue...
pause >nul