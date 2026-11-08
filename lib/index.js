// dsh-desktop-restart-button
//
// Two things, both drawn by a single inline index-injection row:
//   1. a "重启" (restart) button appended to the desktop window menu bar, after
//      应用 / 编辑;
//   2. a tech-style boot animation that replaces the app's plain "正在加载设置…"
//      cold-start caption.
//
// The restart itself runs OUTSIDE the desktop app's Job Object. Every child of the
// app dies with it, so a restarter spawned normally would kill the app and then be
// killed itself, leaving the user with nothing. The chain is therefore:
//
//   this handler -> powershell launch.ps1 -> WMI Win32_Process.Create -> wscript.exe
//                -> launch.vbs (hidden) -> restart.ps1 -> kill app -> relaunch
//
// WMI creates the child from WmiPrvSE, which is not in the app's job; wscript is a
// GUI-subsystem binary so no console window ever flashes.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCH_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'launch.ps1')
const RESTART_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'restart.ps1')

const PACKAGE_NAME = 'dsh-desktop-restart-button'
const ROUTE_BASE = '/dsh-desktop-restart-button'
const ROUTE_PING = `${ROUTE_BASE}/ping`
const ROUTE_RESTART = `${ROUTE_BASE}/restart`

// Seconds between "the button was pressed" and "the app is killed". The HTTP
// response is already on its way by then, so this only has to cover the round trip.
const DELAY_SECONDS = 1

const WINDOWS = process.platform === 'win32'

// Used only when the host is not the desktop binary; kept as a constant so the
// guess is visible instead of buried in a candidate list.
const FALLBACK_EXE = 'D:\\deepseek\\DeepSeek Harness.exe'

const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/**
 * The desktop host runs as the Electron binary in Node mode, so `process.execPath`
 * is the very executable the user launched. That is what we relaunch. When the
 * plugin is loaded by a plain `dsh web` (no Electron), fall back to the desktop
 * app's usual install location.
 */
function resolveAppTarget() {
  const execPath = process.execPath
  // Under the desktop app the host is the Electron binary itself, so this is the
  // executable the user launched. Only a non-Electron host (plain `dsh web`) needs
  // the install-location fallback.
  const exe = WINDOWS && execPath && /\.exe$/i.test(execPath) ? execPath : FALLBACK_EXE
  const processName = path.basename(exe, path.extname(exe))
  return { exe, processName }
}

// ---------------------------------------------------------------------------
// Renderer-side script. Stringified into the index injection row, so it must stay
// self-contained: no imports, no references to anything outside its own body.
// `supported` is injected as its only argument.
// ---------------------------------------------------------------------------
function dshDesktopRestartClient(supported, bootAnimation) {
  // --- boot animation -----------------------------------------------------
  // The app's onboarding overlay renders a lone `[role=status]` node holding
  // "正在加载设置…" while the Host is still starting. Swap that caption for an
  // animation, only for that exact state: the real onboarding wizard also lives
  // in this overlay but renders more than a status node.
  var FX_CLASS = 'dsh-boot-fx'
  var FX_STYLE_ID = 'dsh-boot-fx-style'
  var FX_PHRASES = ['初始化内核', '加载插件', '同步会话']

  var FX_HTML =
    '<div class="dsh-boot-fx-grid"></div>' +
    '<svg viewBox="0 0 140 140" aria-hidden="true">' +
    '<defs><linearGradient id="dshb-g1" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#38bdf8"/>' +
    '<stop offset="0.55" stop-color="#6366f1"/>' +
    '<stop offset="1" stop-color="#22d3ee"/>' +
    '</linearGradient></defs>' +
    '<circle class="dsh-boot-fx-ticks" cx="70" cy="70" r="62" stroke="#a5b4fc" stroke-width="1" stroke-dasharray="1 7"/>' +
    '<circle class="dsh-boot-fx-ring dsh-boot-fx-r1" cx="70" cy="70" r="52" stroke="url(#dshb-g1)" stroke-width="2" stroke-dasharray="72 255"/>' +
    '<circle class="dsh-boot-fx-ring dsh-boot-fx-r2" cx="70" cy="70" r="38" stroke="#818cf8" stroke-width="1.6" stroke-dasharray="34 205"/>' +
    '<circle class="dsh-boot-fx-ring dsh-boot-fx-r3" cx="70" cy="70" r="25" stroke="#22d3ee" stroke-width="1.4" stroke-dasharray="9 148"/>' +
    '<circle class="dsh-boot-fx-halo" cx="70" cy="70" r="14" fill="#38bdf8" opacity="0.14"/>' +
    '<circle class="dsh-boot-fx-core" cx="70" cy="70" r="4.5" fill="#38bdf8"/>' +
    '</svg>' +
    '<div class="dsh-boot-fx-bar"><span></span></div>' +
    '<div class="dsh-boot-fx-label">' +
    FX_PHRASES[0] +
    '</div>'

  var FX_CSS = [
    // Hide the plain caption only on the overlay we actually decorated (marked with
    // data-dsh-boot-fx), so the real onboarding wizard keeps any status text it renders.
    '[class*="_onboardingOverlay"][data-dsh-boot-fx] [role="status"]{display:none!important}',
    '.' + FX_CLASS + '{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;pointer-events:none;user-select:none;-webkit-user-select:none;overflow:hidden}',
    // faint dot grid + radial glow, both masked to fade out from the centre
    '.' + FX_CLASS + ' .dsh-boot-fx-grid{position:absolute;inset:-10%;background-image:radial-gradient(circle at 1px 1px,rgba(99,102,241,.22) 1px,transparent 0);background-size:28px 28px;-webkit-mask-image:radial-gradient(circle at 50% 46%,#000 0%,rgba(0,0,0,.45) 38%,transparent 66%);mask-image:radial-gradient(circle at 50% 46%,#000 0%,rgba(0,0,0,.45) 38%,transparent 66%);animation:dshb-drift 14s linear infinite}',
    '.' + FX_CLASS + ' svg{position:relative;width:190px;height:190px;overflow:visible;filter:drop-shadow(0 0 14px rgba(56,189,248,.4))}',
    '.' + FX_CLASS + ' .dsh-boot-fx-ring,' + '.' + FX_CLASS + ' .dsh-boot-fx-ticks{fill:none;stroke-linecap:round;transform-box:view-box;transform-origin:70px 70px}',
    '.' + FX_CLASS + ' .dsh-boot-fx-ticks{opacity:.55;animation:dshb-spin 40s linear infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-r1{animation:dshb-spin 2.4s linear infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-r2{animation:dshb-spin-rev 3.6s linear infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-r3{animation:dshb-spin 1.7s linear infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-halo,' +
      '.' + FX_CLASS + ' .dsh-boot-fx-core{transform-box:view-box;transform-origin:70px 70px;animation:dshb-pulse 2s ease-in-out infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-bar{position:relative;width:196px;height:2px;border-radius:2px;background:rgba(99,102,241,.16);overflow:hidden}',
    '.' + FX_CLASS + ' .dsh-boot-fx-bar span{position:absolute;top:0;left:0;width:48%;height:100%;border-radius:2px;background:linear-gradient(90deg,transparent,#38bdf8,#6366f1,transparent);animation:dshb-sweep 1.5s ease-in-out infinite}',
    '.' + FX_CLASS + ' .dsh-boot-fx-label{font-size:13px;letter-spacing:.28em;text-indent:.28em;color:var(--dsw-alias-label-secondary,#64748b);animation:dshb-fade .5s ease-out both}',
    '@keyframes dshb-spin{to{transform:rotate(360deg)}}',
    '@keyframes dshb-spin-rev{to{transform:rotate(-360deg)}}',
    '@keyframes dshb-pulse{0%,100%{opacity:.3}50%{opacity:1}}',
    '@keyframes dshb-sweep{0%{transform:translateX(-115%)}100%{transform:translateX(240%)}}',
    '@keyframes dshb-drift{to{transform:translate(-28px,-28px)}}',
    '@keyframes dshb-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.' + FX_CLASS + ' *{animation-duration:0s!important;animation-iteration-count:1!important}}',
  ].join('')

  function ensureFxStyle() {
    if (document.getElementById(FX_STYLE_ID)) return
    var style = document.createElement('style')
    style.id = FX_STYLE_ID
    style.textContent = FX_CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  function decorateOverlay(overlay) {
    if (!overlay || overlay.querySelector('.' + FX_CLASS)) return
    // Only the "still loading" surface has a lone status node; skip the wizard.
    if (!overlay.querySelector('[role="status"]')) return
    ensureFxStyle()
    overlay.setAttribute('data-dsh-boot-fx', '')
    var fx = document.createElement('div')
    fx.className = FX_CLASS
    fx.innerHTML = FX_HTML
    overlay.appendChild(fx)
  }

  function scanOverlays() {
    var overlays = document.querySelectorAll('[class*="_onboardingOverlay"]')
    for (var i = 0; i < overlays.length; i++) decorateOverlay(overlays[i])
  }

  // Cycle the caption; harmless when no overlay is on screen.
  var phraseIndex = 0
  setInterval(function () {
    var labels = document.querySelectorAll('.' + FX_CLASS + ' .dsh-boot-fx-label')
    if (!labels.length) return
    phraseIndex = (phraseIndex + 1) % FX_PHRASES.length
    for (var i = 0; i < labels.length; i++) labels[i].textContent = FX_PHRASES[phraseIndex]
  }, 1600)

  // --- restart button -----------------------------------------------------
  // The menu bar is built by the Electron preload as a shadow root, and only on
  // Windows. On any other platform there is nothing to attach to.
  if (supported) {
    var ENDPOINT = '/dsh-desktop-restart-button/restart'
    var LABEL = '重启'
    var MARK = 'data-dsh-desktop-restart-button'
    var busy = false

    var press = function (event) {
      event.preventDefault()
      event.stopPropagation()
      var button = event.currentTarget
      if (busy) return
      busy = true
      var original = button.textContent
      button.textContent = '重启中'
      button.disabled = true
      button.style.opacity = '0.55'
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var abortTimer = controller
        ? setTimeout(function () {
            controller.abort()
          }, 20000)
        : null
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller ? controller.signal : undefined,
      })
        .then(function (response) {
          if (abortTimer) clearTimeout(abortTimer)
          return response.json().then(function (data) {
            return { ok: response.ok, data: data }
          })
        })
        .then(function (result) {
          if (!result.ok || !result.data || result.data.ok !== true) {
            throw new Error((result.data && result.data.error) || 'restart request failed')
          }
          button.textContent = '正在重启'
          // A successful restart tears this page down; if the window is still here
          // after this long, the restart never happened and the user must be told
          // instead of being left on a dead "restarting" label forever.
          setTimeout(function () {
            if (!busy) return
            busy = false
            button.disabled = false
            button.style.opacity = ''
            button.textContent = '重启超时'
            setTimeout(function () {
              button.textContent = original
            }, 3000)
            if (window.console) {
              window.console.warn('[dsh-desktop-restart-button] restart did not happen; see ~/.dsh/dsh-desktop-restart-button.log')
            }
          }, 25000)
        })
        .catch(function (error) {
          busy = false
          button.disabled = false
          button.style.opacity = ''
          button.textContent = '重启失败'
          setTimeout(function () {
            button.textContent = original
          }, 2500)
          if (window.console) window.console.error('[dsh-desktop-restart-button]', error)
        })
    }

    var create = function () {
      var button = document.createElement('button')
      button.type = 'button'
      button.textContent = LABEL
      button.title = '重启 DeepSeek Harness（关闭并重新打开）'
      button.setAttribute('role', 'menuitem')
      button.setAttribute(MARK, '')
      button.tabIndex = -1
      button.addEventListener('click', press)
      return button
    }

    var install = function (root) {
      var bar = root.querySelector('[role="menubar"]')
      if (!bar) return false
      if (root.querySelector('[' + MARK + ']')) return true
      bar.appendChild(create())
      return true
    }
  }

  function tryInstall() {
    if (bootAnimation) scanOverlays()
    if (!supported) return true
    var host = document.querySelector('[data-windows-menu]')
    if (!host || !host.shadowRoot) return false
    return install(host.shadowRoot)
  }

  var timer = setInterval(function () {
    if (tryInstall()) clearInterval(timer)
  }, 300)

  try {
    var observer = new MutationObserver(function () {
      if (tryInstall()) clearInterval(timer)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch (error) {}

  // Run once eagerly: on a fast start the mutation may land before this row executes.
  if (bootAnimation) scanOverlays()
}

const clientRow = (bootAnimation) =>
  `(${String(dshDesktopRestartClient)})(${WINDOWS ? 'true' : 'false'}, ${bootAnimation ? 'true' : 'false'})`
const CLIENT_ROW_TEXT = clientRow(true)
const CLIENT_ROW_TEXT_NO_FX = clientRow(false)
const CLIENT_ROW_MARKER = 'data-dsh-desktop-restart-button'
const CLIENT_ROW_MARKER_FX = 'dsh-boot-fx-style'

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

// The desktop shell serves the UI from `dsh-app://app` and proxies every non-asset
// request here with that Origin intact. Anything else must be loopback. Without
// this the route would be reachable from any web page the user happens to visit.
function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  if (origin === 'dsh-app://app') return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Runs the WMI launcher and reports what it printed. The launcher exits as soon as
 * the outside-the-job restarter is created, so this returns before the app dies.
 */
function launchRestart(oldPort, exe, processName) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      LAUNCH_SCRIPT,
      '-ScriptPath',
      RESTART_SCRIPT,
      '-DelaySeconds',
      String(DELAY_SECONDS),
      '-OldPort',
      String(oldPort),
      '-Exe',
      exe,
      '-ProcessName',
      processName,
    ]
    execFile(POWERSHELL, args, { windowsHide: true, timeout: 12000 }, (error, stdout, stderr) => {
      resolve({ error, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() })
    })
  })
}

export default {
  name: PACKAGE_NAME,

  apply(root, config) {
    const options = config && typeof config === 'object' ? config : {}
    const bootAnimation = options.bootAnimation !== false
    const { exe, processName } = resolveAppTarget()

    const rowDisposers = []

    root.effect(() => () => {
      for (const dispose of rowDisposers) {
        try {
          dispose()
        } catch (error) {}
      }
    })

    // Must be registered synchronously: the host collects the injection table
    // exactly once, at the end of its own startup, and never re-collects it.
    rowDisposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind !== 'script' || typeof row.text !== 'string') continue
            if (row.text.indexOf(CLIENT_ROW_MARKER) >= 0 || row.text.indexOf(CLIENT_ROW_MARKER_FX) >= 0) return
          }
          const text = bootAnimation ? CLIENT_ROW_TEXT : CLIENT_ROW_TEXT_NO_FX
          table.push({ kind: 'script', placement: 'body', text })
        } catch (error) {}
      }),
    )

    root.inject(['webServer'], (ctx) => {
      const webServer = ctx.webServer

      rowDisposers.push(
        webServer.register({
          kind: 'exact',
          path: ROUTE_PING,
          handler: (req, res) => {
            if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' })
            sendJson(res, 200, {
              ok: true,
              name: PACKAGE_NAME,
              supported: WINDOWS,
              platform: process.platform,
              port: webServer.port,
              exe,
              processName,
              powershell: POWERSHELL,
              launchScript: LAUNCH_SCRIPT,
              restartScript: RESTART_SCRIPT,
              bootAnimation,
            })
          },
        }),
      )

      rowDisposers.push(
        webServer.register({
          kind: 'exact',
          path: ROUTE_RESTART,
          handler: async (req, res) => {
            if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
            if (!WINDOWS) return sendJson(res, 501, { ok: false, error: `unsupported platform: ${process.platform}` })

            const port = webServer.port
            const result = await launchRestart(port, exe, processName)

            if (result.error) {
              const message = result.err || result.out || result.error.message
              return sendJson(res, 500, { ok: false, error: message })
            }
            if (result.out.startsWith('OK')) {
              return sendJson(res, 200, {
                ok: true,
                pid: Number(result.out.slice(result.out.indexOf('pid=') + 4)) || null,
                delaySeconds: DELAY_SECONDS,
                oldPort: port,
              })
            }
            return sendJson(res, 500, { ok: false, error: result.out || result.err || 'launcher failed' })
          },
        }),
      )
    })
  },
}

