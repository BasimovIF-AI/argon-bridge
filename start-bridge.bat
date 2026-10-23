@echo off
title Argon-Bridge Daemon (:8765)
echo ====================================================
echo  Starting Argon-Bridge Daemon on ws://127.0.0.1:8765
echo ====================================================
"%~dp0bin\argon-bridge.exe" serve
pause
