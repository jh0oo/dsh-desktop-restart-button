# Restart the DeepSeek Harness desktop app.
# Launched OUTSIDE the desktop app's Job Object (via WMI Win32_Process.Create), so it
# survives the app being killed and can relaunch it.
#
# Timing is tuned for "click -> window back" latency: every wait polls instead of
# sleeping a fixed amount, and the old port is NOT waited for (the Host always binds
# a random port, so the old one never blocks the new instance).
param(
  [int]$DelaySeconds = 2,
  [int]$OldPort = 0,
  [string]$LogPath = (Join-Path $env:USERPROFILE '.dsh\dsh-desktop-restart-button.log'),
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Log([string]$m) {
  try {
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [pid $PID] $m" | Out-File -FilePath $LogPath -Append -Encoding utf8
  } catch {}
}
function AppProcs { @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) }
function PidsOf($ps) { ($ps | ForEach-Object { $_.Id }) -join ',' }

# Job objects are inherited by children only, so "is this process a descendant of the
# app?" is the check that actually matters. The old IsProcessInJob test also fired for
# unrelated jobs the shell puts every windowed app into, which made the guard refuse to
# restart on machines where the WMI child was perfectly safe.
function Test-DescendsFromApp {
  $appPids = @{}
  foreach ($p in (AppProcs)) { $appPids[[int]$p.Id] = $true }
  if ($appPids.Count -eq 0) { return $false }
  $procId = $PID
  for ($i = 0; $i -lt 12; $i++) {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if (-not $me) { return $false }
    $parentId = [int]$me.ParentProcessId
    if ($parentId -le 4) { return $false }
    if ($appPids.ContainsKey($parentId)) { return $true }
    $procId = $parentId
  }
  return $false
}

# True when this process lives in the desktop app's Job Object. A restarter in there
# dies together with the app it just killed, so the app would close and never come back.
function Test-InJobObject {
  try {
    if (-not ([System.Management.Automation.PSTypeName]'DshRestart.Native').Type) {
      $code = '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);'
      Add-Type -Namespace DshRestart -Name Native -MemberDefinition $code -ErrorAction Stop
    }
    $inJob = $false
    $handle = [System.Diagnostics.Process]::GetCurrentProcess().Handle
    if ([DshRestart.Native]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)) { return [bool]$inJob }
  } catch {}
  return $false
}

Log "---- restarter started (delay ${DelaySeconds}s, oldPort $OldPort) ----"

# Safety net: if we were started inside the app's job (e.g. by hand, or by any code
# running in the app), killing the app would kill us too. Hand off to the WMI launcher
# that creates the restarter outside the job, then leave without touching the app.
if (Test-DescendsFromApp) {
  # Loop breaker: if a WMI child still lands inside the job, re-dispatching again would
  # keep spawning restarters forever and the app would never restart (the UI would sit
  # on "restarting" until the user quits by hand).
  $marker = Join-Path $env:TEMP 'dsh-desktop-restart-button.handoff'
  $lastHandoff = $null
  if (Test-Path $marker) {
    try { $lastHandoff = [datetime]::Parse((Get-Content $marker -Raw).Trim()) } catch {}
  }
  if ($lastHandoff -and ((Get-Date) - $lastHandoff).TotalSeconds -lt 30) {
    Log "guard: re-dispatch already attempted within 30s -> refusing to loop, exiting"
    Log "guard: the app could not be restarted from here; ask the user to quit it by hand"
    exit 0
  }
  Log "guard: running inside the app process tree -> re-dispatching through WMI"
  $launcher = Join-Path $PSScriptRoot 'launch.ps1'
  if ($DryRun) {
    Log "guard: DRY RUN, would hand off via $launcher"
    Log "guard: exiting without touching the app"
    exit 0
  }
  if (Test-Path $launcher) {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Set-Content -Path $marker -Value (Get-Date).ToString('o') -Encoding ascii
    $handoff = & $psExe -NoProfile -ExecutionPolicy Bypass -File $launcher `
      -ScriptPath $PSCommandPath -DelaySeconds 2 -OldPort $OldPort `
      -Exe $Exe -ProcessName $ProcessName -LogPath $LogPath
    Log ("guard: handoff -> " + (($handoff | Out-String).Trim()))
  } else {
    Log ("guard: missing launcher " + $launcher)
  }
  Log "guard: exiting without touching the app"
  exit 0
}
# Cap the post-click wait: the button's HTTP response is already on its way before this
# process even starts, so the delay only adds perceived latency. Older callers pass 5.
if ($DelaySeconds -gt 1) { $DelaySeconds = 1 }

# Reaching this line means we are outside the app's job object, so killing the app
# cannot take us down with it. Log it: this is the contract the launcher must keep.
Log "outside app job object: ok (safe to kill and relaunch)"
if ($DryRun) {
  Log "DRY RUN: stopping before touching the app"
  Log "---- restarter done (dry run) ----"
  exit 0
}

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

# 1) ask the window to close and give the app a moment to quit on its own, so its
#    settings/session writes finish cleanly; only kill what is still alive after that.
$procs = AppProcs
Log ("found " + $procs.Count + " app process(es): " + (PidsOf $procs))
foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} }
for ($i = 0; $i -lt 20; $i++) {
  if (@(AppProcs).Count -eq 0) { break }
  Start-Sleep -Milliseconds 150
}
foreach ($p in (AppProcs)) {
  try { $p.Kill(); Log ("killed " + $p.Id) } catch { Log ("kill failed " + $p.Id + ": " + $_.Exception.Message) }
}

# 2) wait for every app process (including the Host) to disappear
for ($i = 0; $i -lt 100; $i++) {
  if (@(AppProcs).Count -eq 0) { break }
  Start-Sleep -Milliseconds 100
}
Log ("all app processes gone: " + (@(AppProcs).Count -eq 0))

# 3) relaunch with a clean environment (ELECTRON_RUN_AS_NODE must not leak in)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
for ($try = 1; $try -le 4; $try++) {
  if (@(AppProcs).Count -eq 0) {
    try {
      Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent) -ErrorAction Stop
      Log "launch attempt $try issued"
    } catch { Log ("launch attempt $try failed: " + $_.Exception.Message) }
  } else {
    Log ("app already running (self-relaunch?): " + (PidsOf (AppProcs)))
    break
  }
  # wait until the new process group actually exists (usually < 1s)
  for ($i = 0; $i -lt 40; $i++) {
    if (@(AppProcs).Count -gt 0) { break }
    Start-Sleep -Milliseconds 250
  }
  if (@(AppProcs).Count -gt 0) { break }
}

# 4) last resort: never leave the user with a closed app. Keep retrying for a minute.
if (@(AppProcs).Count -eq 0) {
  Log "launch did not take, falling back to a 60s retry loop"
  for ($i = 0; $i -lt 20; $i++) {
    try {
      Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent) -ErrorAction Stop
      Log ("fallback launch attempt " + ($i + 1) + " issued")
    } catch { Log ("fallback launch failed: " + $_.Exception.Message) }
    for ($j = 0; $j -lt 12; $j++) {
      if (@(AppProcs).Count -gt 0) { break }
      Start-Sleep -Milliseconds 250
    }
    if (@(AppProcs).Count -gt 0) { break }
  }
}

$final = AppProcs
Log ("RESULT processes=" + (PidsOf $final) + " elapsedMs=" + [int]$sw.Elapsed.TotalMilliseconds)
Log "---- restarter done ----"
