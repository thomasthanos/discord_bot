@echo off
title Discord Bot - Install Requirements
color 0A

echo ============================================
echo   Discord Bot - Installing Requirements
echo ============================================
echo.

echo [1/9] Installing discord.py...
pip install discord.py
echo.

echo [2/9] Installing flask...
pip install flask
echo.

echo [3/9] Installing flask-socketio...
pip install flask-socketio
echo.

echo [4/9] Installing yt-dlp...
pip install yt-dlp
echo.

echo [5/9] Installing spotipy...
pip install spotipy
echo.

echo [6/9] Installing cryptography...
pip install cryptography
echo.

echo [7/9] Installing colorama...
pip install colorama
echo.

echo [8/9] Installing python-socketio (client)...
pip install "python-socketio[client]"
echo.

echo [9/9] Installing pytz...
pip install pytz
echo.

echo ============================================
echo   All libraries installed successfully!
echo ============================================
echo.
echo NOTE: Make sure you also have FFmpeg installed
echo and added to your PATH for music to work.
echo Download: https://ffmpeg.org/download.html
echo.
pause
