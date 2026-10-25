@echo off
title CipherClip — Private Encrypted Video Catalog
cd /d "%~dp0"
echo Starting CipherClip (Local Encrypted Video Catalog)...
node src/server.js
pause
