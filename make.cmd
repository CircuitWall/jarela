@echo off
rem make.cmd — thin shim so `make <target>` works on Windows.
rem Delegates to make.ps1 in the same directory.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make.ps1" %*
