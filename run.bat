@echo off
title Discord Bot
cd /d "%~dp0"
cls

echo.
echo  ======================================
echo   Discord Bot Launcher
echo  ======================================
echo.

:: ── Check Python ──────────────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found!
    echo  Install Python 3.11+ from https://python.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo  [OK] %PYVER%

:: ── Check .env ────────────────────────────────────────────────────────────────
if not exist ".env" (
    echo  [ERROR] .env file not found!
    echo  Run install_deps.bat first, then fill in your tokens.
    echo.
    pause
    exit /b 1
)
echo  [OK] .env found

:: ── Check token is not empty ──────────────────────────────────────────────────
python -c "from dotenv import load_dotenv; import os; load_dotenv(); t=os.getenv('DISCORD_BOT_TOKEN',''); exit(0 if t else 1)" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] DISCORD_BOT_TOKEN is empty in .env!
    echo  Edit .env and add your bot token before running.
    echo.
    pause
    exit /b 1
)
echo  [OK] Token found

:: ── Check packages (including eventlet) ──────────────────────────────────────
python -c "import discord, nacl, flask, flask_socketio, eventlet, yt_dlp, spotipy, cryptography, dotenv, nacl.secret" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Missing packages detected - running install_deps.bat...
    echo.
    call install_deps.bat
    cls
    echo.
    echo  ======================================
    echo   Discord Bot Launcher
    echo  ======================================
    echo.
    echo  [OK] %PYVER%
    echo  [OK] .env found
    echo  [OK] Token found
)
echo  [OK] All packages OK
echo.

:: ── Start ─────────────────────────────────────────────────────────────────────
echo  Starting bot...
echo  Web panel ^-^> http://127.0.0.1:5000
echo  Press Ctrl+C to stop.
echo.
echo  ----------------------------------------
echo.

python main.py

echo.
echo  ----------------------------------------
echo  Bot stopped.
echo.
pause
