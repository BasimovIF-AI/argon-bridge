@echo off
title Gemini-Bridge Daemon (:8765)
echo ====================================================
echo  Starting Gemini-Bridge Daemon on ws://127.0.0.1:8765
echo ====================================================
"%~dp0bin\gemini-bridge.exe" serve
pause
