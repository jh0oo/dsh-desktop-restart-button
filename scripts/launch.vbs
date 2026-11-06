' Windowless launcher for restart.ps1.
'
' Wscript.exe is a GUI-subsystem executable: it never allocates a console window.
' It then starts PowerShell through WshShell.Run with a window style of 0 (hidden),
' so the restarter runs completely invisible instead of flashing a command window.
'
' Usage: wscript.exe //nologo launch.vbs <restart.ps1 path> [extra raw args...]
Option Explicit

Dim shellHost, ps, cmdLine, arg, i

If WScript.Arguments.Count < 1 Then WScript.Quit 2

ps = CreateObject("WScript.Shell").ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
cmdLine = Chr(34) & ps & Chr(34) & _
  " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Chr(34) & WScript.Arguments(0) & Chr(34)

' Re-quote every argument: WScript drops the quotes it stripped from the command
' line, so an unquoted path with a space ("D:\deepseek\DeepSeek Harness.exe")
' would otherwise be split into two arguments by PowerShell and rejected.
For i = 1 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Then arg = Chr(34) & Replace(arg, Chr(34), Chr(34) & Chr(34)) & Chr(34)
  cmdLine = cmdLine & " " & arg
Next

Set shellHost = CreateObject("WScript.Shell")
' 0 = hidden window, False = do not wait (wscript exits, PowerShell keeps running).
shellHost.Run cmdLine, 0, False
