param(
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [int]$DelaySeconds = 8,
  [int]$OldPort = 0,
  [string]$Exe = '',
  [string]$ProcessName = '',
  [string]$LogPath = '',
  [switch]$DryRun
)

# Launches restart.ps1 through WMI so the child is created by WmiPrvSE and is
# therefore NOT inside the desktop app's Job Object. This process may die with the
# app; the restarter it spawns will not.
#
# The WMI child is wscript.exe (a GUI-subsystem binary, so no console window is ever
# allocated) which in turn starts PowerShell with a hidden window via launch.vbs.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'launch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $vbs)) {
  Write-Output ("FAIL missing launcher: " + $vbs)
  exit 4
}

$argline = '"{0}" //nologo "{1}" "{2}" -DelaySeconds {3} -OldPort {4}' -f $wscript, $vbs, $ScriptPath, $DelaySeconds, $OldPort
if ($Exe) { $argline = $argline + ' -Exe "{0}"' -f $Exe }
if ($ProcessName) { $argline = $argline + ' -ProcessName "{0}"' -f $ProcessName }
if ($LogPath) { $argline = $argline + ' -LogPath "{0}"' -f $LogPath }
if ($DryRun) { $argline = $argline + ' -DryRun' }

try {
  $res = ([wmiclass]'Win32_Process').Create($argline, $here, $null)
  if ($res.ReturnValue -eq 0) {
    Write-Output ("OK pid=" + $res.ProcessId)
    exit 0
  }
  Write-Output ("FAIL returnValue=" + $res.ReturnValue)
  exit 2
} catch {
  Write-Output ("FAIL " + $_.Exception.Message)
  exit 3
}
