' pr-watch-service.vbs — start the watch-pr resident poller + dashboard hidden in the
' background (no console window, no browser). This is the "always-on" (Tier 2) entry:
' the process stays resident, keeps the dashboard live, and fires desktop/phone
' notifications with no Claude session running. It is idle-cheap when nothing is being
' watched (an empty list = zero Azure calls).
'
' It runs at login via a shortcut in shell:startup (Win+R -> shell:startup). To stop it,
' end the matching "node" process in Task Manager, or remove the startup shortcut.
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' Full node path so it works at login regardless of PATH timing. 0 = hidden window,
' False = don't wait for it to exit (runs detached in the background).
sh.Run Chr(34) & "C:\nvm4w\nodejs\node.exe" & Chr(34) & " " & Chr(34) & dir & "\server.js" & Chr(34), 0, False
