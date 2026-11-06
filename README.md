# dsh-desktop-restart-button

English | [中文](README.zh.md)

A **restart button** for **DeepSeek Harness Desktop on Windows**, plus a small
tech-style boot animation that replaces the app's plain "Loading settings…"
cold-start caption.

Both are drawn by an inline index-injection row, so **`app.asar` is never
touched** — installing and uninstalling this plugin leaves the shipped
application exactly as it was.

![boot animation](assets/boot-animation.png)

## Why a plugin and not a menu item

The desktop window menu bar (`应用` / `编辑`) is built by Electron's preload
script with exactly two hard-coded buttons, and the app exposes **no restart IPC
channel and no CLI entry point** — its own `app.relaunch()` menu item only exists
in development builds. There is also no way to use `dsh plugin --profile desktop`,
because the desktop profile is managed exclusively by the Electron application.

The one supported extension point on the desktop is a **profile plugin that
pushes an inline script row into the host's index injection table**. That is what
this package is.

## Install

Desktop profiles cannot be managed from the CLI. Install it through the app's
own plugin manager:

1. Open **设置 → 插件** in the app.
2. Search for `dsh-desktop-restart-button` (or install from a local tarball).
3. Restart the app once.

The button appears in the title bar, right after `应用` and `编辑`. On any
platform other than Windows the plugin loads but adds nothing: the menu bar it
attaches to only exists on Windows, and the restart path is WMI/PowerShell.

## Why restarting needs a launcher at all

Electron puts children of the app into a **Job Object**, and every process the
app spawns is killed when the app is killed. A restarter started the normal way
would therefore kill the app and then die with it, leaving the user staring at a
closed window. `CREATE_BREAKAWAY_FROM_JOB` is refused by that job.

The chain that works, and the one this plugin uses:

```
button click
  → POST /dsh-desktop-restart-button/restart
  → execFile powershell scripts/launch.ps1
  → WMI Win32_Process.Create          ← created by WmiPrvSE, outside the job
  → wscript.exe scripts/launch.vbs    ← GUI-subsystem binary, no console ever
  → restart.ps1                       ← kills the app, then relaunches it
```

`wscript.exe` is not an accident: WMI-created `powershell.exe` always flashes a
console window, and neither `-WindowStyle Hidden` nor
`Win32_ProcessStartup.ShowWindow = 0` suppresses it (while
`CreateFlags = CREATE_NO_WINDOW` makes the WMI call fail outright). A
GUI-subsystem binary plus `WshShell.Run(cmd, 0, False)` is the only combination
that stays invisible.

Measured on the author's machine: **click → window back ≈ 5 seconds**, most of
which is Host startup, not the restart itself.

## Safety

- **Origin fence.** The restart route accepts only `dsh-app://app` (how the
  desktop shell serves its own UI) and loopback origins. A random web page in
  your browser cannot reach it.
- **In-job guard.** `restart.ps1` calls `IsProcessInJob` before touching
  anything. If it finds itself inside the app's job — for example because
  someone ran it by hand from a terminal that the app owns — it re-dispatches
  itself through the WMI launcher and exits **without killing the app**,
  instead of closing it and dying.
- **No data is lost on purpose.** The app is asked to close its window first
  and is only force-killed if it is still alive afterwards, so settings and
  session writes finish normally.
- **Never leaves a closed app.** If the relaunch does not take, the restarter
  retries for up to a minute before giving up.

Log: `%USERPROFILE%\.dsh\dsh-desktop-restart-button.log`

## Configuration

```yaml
- id: dsh-desktop-restart-button
  name: dsh-desktop-restart-button
  config:
    bootAnimation: false
```

`bootAnimation` defaults to `true`. Set it to `false` to keep the app's original
"正在加载设置…" caption. Requires an app restart to take effect, since the
injection row is collected once at startup.

## The boot animation

The overlay it replaces is the app's onboarding surface, which renders a lone
`[role="status"]` node while the Host is starting. The plugin marks **only that
exact state** (an overlay that has a status node and no wizard content) and
hides the caption on the marked element via an attribute selector — the real
onboarding wizard keeps its own text.

The animation itself is pure CSS/SVG (three counter-rotating arcs, a breathing
core, a sweeping bar, a slowly drifting dot grid) with a
`prefers-reduced-motion` fallback to static. No canvas, no rAF loop, no work
after the overlay unmounts.

## Notes and limits

- **Windows only.** `dsh.bundle.platforms: ["win32"]`.
- **Desktop only.** It attaches to the preload-built window menu bar, which a
  plain `dsh web` session does not have. On web the plugin is harmless but
  invisible.
- The app relaunches `process.execPath`, i.e. the executable the host is
  running as. If that is ever not the desktop binary, it falls back to
  `D:\deepseek\DeepSeek Harness.exe`.
- The desktop host binds a **random port every start**, so the page you were on
  is not valid after a restart. The button does not try to navigate for you.

## License

MIT
