@echo off
setlocal

:: Force the command prompt to run from the directory where this batch file is located
cd /d "%~dp0"

echo =========================================
echo  Starting LeGo2 Fan Control Build
echo =========================================
echo.

:: Parameter Checking
set "ACTION_ZIP=0"
set "ACTION_TRANSFER=1"

:: ---> STEAM DECK IP ADDRESS <---
set "DECK_IP=192.168.1.242"

:: ---> RELEASE DIRECTORY <---
set "RELEASE_DIR=G:\My Drive\LeGo2 Fan Control - Releases"

if /I "%~1"=="/zip" (
    set "ACTION_ZIP=1"
    set "ACTION_TRANSFER=0"
    echo Mode: Build and ZIP only.
)
if /I "%~1"=="/all" (
    set "ACTION_ZIP=1"
    set "ACTION_TRANSFER=1"
    echo Mode: Build, ZIP, and Auto-Deploy.
)

set "PLUGIN_NAME=lego2-fan-control"
set "TMP_PATH=/tmp/%PLUGIN_NAME%"
set "FINAL_PATH=/home/deck/homebrew/plugins/%PLUGIN_NAME%"

echo [1/7] Updating version numbers...
(
echo const fs = require('fs'^);
echo const d = new Date(^);
echo const v = '0.' + String(d.getFullYear(^)^).slice(-2^) + String(d.getMonth(^)+1^).padStart(2, '0'^) + String(d.getDate(^)^).padStart(2, '0'^);
echo const p = JSON.parse(fs.readFileSync('plugin.json'^)^);
echo p.version = v; p.api_version = 2;
echo fs.writeFileSync('plugin.json', JSON.stringify(p, null, 2^)^);
echo const pkg = JSON.parse(fs.readFileSync('package.json'^)^);
echo pkg.version = v;
echo fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2^)^);
echo let tsx = fs.readFileSync('src/index.tsx', 'utf8'^);
echo tsx = tsx.replace(/const PLUGIN_VERSION = "[0-9.]+"; \/\/ AUTO-INJECTED/, 'const PLUGIN_VERSION = "' + v + '"; // AUTO-INJECTED'^);
echo fs.writeFileSync('src/index.tsx', tsx^);
echo console.log(v^);
) > bump.cjs

for /f "delims=" %%i in ('node bump.cjs') do set "APP_VERSION=%%i"
del bump.cjs

if "%APP_VERSION%"=="" set "APP_VERSION=0.000000"
set "ZIP_NAME=LeGo2FanControl_Decky.zip"

echo Injected Version: v%APP_VERSION%
echo.

echo [2/7] Installing dependencies...
call npm install --no-fund --no-audit

echo.
echo [3/7] Running npm run build...
call npm run build
if errorlevel 1 goto :error

echo.
echo [4/7] Cleaning up old build folders...
if exist "%PLUGIN_NAME%" rmdir /s /q "%PLUGIN_NAME%"

echo [5/7] Assembling plugin folder...
mkdir "%PLUGIN_NAME%"
mkdir "%PLUGIN_NAME%\dist"

copy /Y package.json "%PLUGIN_NAME%\" >nul
copy /Y main.py "%PLUGIN_NAME%\" >nul
copy /Y plugin.json "%PLUGIN_NAME%\" >nul
xcopy /E /I /Y dist "%PLUGIN_NAME%\dist" >nul
xcopy /E /I /Y assets "%PLUGIN_NAME%\assets" >nul

echo.

if "%ACTION_ZIP%"=="1" (
    echo [6/7] Creating zip for release...
    :: Build locally first to avoid G: drive latency issues
    if exist "temp_release.zip" del "temp_release.zip"
    
    :: Use native Windows tar instead of PowerShell to ensure Unix-style forward-slashes
    tar.exe -a -c -f "temp_release.zip" "%PLUGIN_NAME%"
    
    :: Ensure the release directory exists
    if not exist "%RELEASE_DIR%" mkdir "%RELEASE_DIR%"
    
    :: Clean up the existing zip in the release folder
    if exist "%RELEASE_DIR%\LeGo2FanControl_Decky.zip" del "%RELEASE_DIR%\LeGo2FanControl_Decky.zip"
    
    :: Move to Google Drive with the final name
    move /Y "temp_release.zip" "%RELEASE_DIR%\%ZIP_NAME%" >nul
    echo Zip creation complete: %RELEASE_DIR%\%ZIP_NAME%
)

if "%ACTION_TRANSFER%"=="1" (
    echo [7/7] Deploying to Steam Deck at %DECK_IP%...
    ssh -o StrictHostKeyChecking=no deck@%DECK_IP% "rm -rf %TMP_PATH%"
    scp -o StrictHostKeyChecking=no -r "%PLUGIN_NAME%" deck@%DECK_IP%:%TMP_PATH%
    if errorlevel 1 goto :error

    ssh -o StrictHostKeyChecking=no -t deck@%DECK_IP% "sudo rm -rf %FINAL_PATH% && sudo mv %TMP_PATH% %FINAL_PATH% && sudo systemctl restart plugin_loader.service"
    if errorlevel 1 goto :error
)

echo.
echo Cleaning up temporary folders...
if exist "%PLUGIN_NAME%" rmdir /s /q "%PLUGIN_NAME%"

echo.
echo =========================================
echo  Build and Deployment Successful!
echo =========================================
goto :eof

:error
echo.
echo =========================================
echo  Build Failed! Check the errors above.
echo =========================================
pause
exit /b 1