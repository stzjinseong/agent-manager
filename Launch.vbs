' Claude Kiugi - no console window: start server (skip if running) and open browser
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node ""app\launch.mjs""", 0, False
