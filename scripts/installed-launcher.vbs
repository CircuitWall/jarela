' installed-launcher.vbs — hidden-window wrapper around installed-launcher.ps1.
'
' Task Scheduler launching `powershell.exe -WindowStyle Hidden` still creates
' a console window briefly, and any child started with `-NoNewWindow`
' (as our launcher does for `node server.js`) can flash that window to the
' foreground. wscript.exe with intWindowStyle=0 has no console at all, so
' the whole subtree stays invisible.
'
' Argument 0 to .Run: window style (0 = hidden).
' Argument 1: wait for completion (False = fire and forget).

Option Explicit

Dim sh, here, ps1
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ps1  = here & "\launcher.ps1"

sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
