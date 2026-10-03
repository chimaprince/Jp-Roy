@echo off
rem Roy Medical Chinese Tutor: double-click to update to the latest version.
rem Your .env (settings, API key) and tutor.db (your progress) are not touched.
cd /d "%~dp0"
echo Updating Roy Medical Chinese Tutor...
git stash push -m "local changes before update" >nul 2>&1
git fetch origin claude/great-mendel-wolegk || goto failed
git checkout -B claude/great-mendel-wolegk origin/claude/great-mendel-wolegk || goto failed
call npm install || goto failed
for /f %%v in ('node -p "require('./package.json').version"') do set VER=%%v
echo.
echo Updated: Roy Medical Chinese Tutor v%VER%.
echo Close any old tutor window, then double-click start-tutor.cmd.
echo The page must show v%VER% at the bottom.
pause
exit /b 0
:failed
echo.
echo The update did not finish. See the message above.
pause
exit /b 1
