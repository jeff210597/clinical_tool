Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\Watch_Cloudflare_Relay_Loop.ps1"""
shell.Run cmd, 0, False
