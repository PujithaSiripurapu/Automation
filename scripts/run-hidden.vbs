' Launches run-pest-book-cancel.cmd without showing a console window (used by Task Scheduler).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run("cmd /c """ & scriptDir & "\run-pest-book-cancel.cmd""", 0, True)
