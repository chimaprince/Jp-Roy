@echo off
rem Roy Medical Chinese Tutor: double-click to start (HTTPS, for the iPhone and this laptop).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages (first time only^)...
  call npm install
)
call npm run start:https
pause
