@echo off
rem Runs the Pest Control book-and-cancel test once and appends the result to logs\pest-book-cancel.log.
rem Scheduled every 5 minutes by scripts\schedule-pest-book-cancel.ps1 (Windows Task Scheduler).

cd /d "%~dp0.."
if not exist logs mkdir logs

rem Never auto-open the HTML report: in an unattended run that would block until killed.
set PLAYWRIGHT_HTML_OPEN=never

echo ===== %date% %time% ===== >> logs\pest-book-cancel.log
call npx playwright test tests/pest-control-book-and-cancel.spec.ts --project=chromium --reporter=line,html >> logs\pest-book-cancel.log 2>&1
set RESULT=%ERRORLEVEL%
if %RESULT%==0 (echo RESULT: PASSED >> logs\pest-book-cancel.log) else (echo RESULT: FAILED exit code %RESULT% >> logs\pest-book-cancel.log)
exit /b %RESULT%
