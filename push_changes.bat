@echo off
setlocal enabledelayedexpansion

:: Close any open log files
taskkill /F /IM electron.exe 2>nul

:: Fetch the latest changes
git fetch origin

:: Add all changes, including new and modified files
git add -A

:: Check if there are any changes to commit
git diff-index --quiet HEAD
if errorlevel 1 (
    :: Commit all changes with a timestamp
    for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
    set "formatted_datetime=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2% %datetime:~8,2%:%datetime:~10,2%:%datetime:~12,2%"
    
    git commit -m "Full project update: %formatted_datetime%"
    
    :: Push changes
    git push
) else (
    echo No changes to commit.
)

echo Project update complete.
pause
