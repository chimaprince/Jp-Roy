@echo off
rem Roy Medical Chinese Tutor: double-click to start (HTTPS, for the iPhone and this laptop).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages (first time only^)...
  call npm install
)
for /f %%v in ('node -p "require('./package.json').version"') do set VER=%%v
echo Starting Roy Medical Chinese Tutor v%VER% (the page shows the same version at the bottom^).
call npm run start:https
pause
