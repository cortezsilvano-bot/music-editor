@echo off
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787
echo Song Studio separation -^> http://localhost:%PORT%
python -m uvicorn app:app --host 127.0.0.1 --port %PORT%
