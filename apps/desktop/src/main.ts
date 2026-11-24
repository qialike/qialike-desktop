/**
 * The Electron shell.
 *
 * Startup order matters and is deliberate: the window is created and loaded
 * **before** the Host starts, so the user sees the application immediately
 * rather than a blank frame during a boot that takes seconds. The page it loads
 * waits on `__DSH_BOOT_READY__`, which the shell resolves over IPC once the Host
 * reports the rows the client needs.
 *
 * The shell owns three things and delegates everything else:
 *
 *   · **The origin.** It serves the packaged Web dist and proxies the rest to the
 *     Host, so the client's own transport works unmodified.
 *   · **The credential.** It redeems the Host's tokenized URL for a cookie it
 *     keeps to itself, and never hands the token to a renderer.
 *   · **The profile.** It prepares `$DSH_HOME/profiles/qialike-desktop` before
 *     the Host starts, so the Host never creates state.
 *
 * Everything else — sessions, providers, permissions, the agent loop — is the
 * Host's, reached over the same authenticated HTTP API the Web client uses.
 *
 * @module @qialike/desktop/main
 */

import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, protocol, session, shell } from 'electron'
import { APP_HOSTNAME, DESKTOP_IPC, SHELL_HOSTNAME, assertApplicationSender, type DesktopBootPayload } from './ipc.ts'
import { startHost, type DesktopHost, type HostExit } from './host-process.ts'
import { summariseHostExit, writeCrashReport } from './host-crash.ts'
import { appendDesktopLog, desktopLogPath } from './desktop-log.ts'
import { installMainProcessGuard } from './main-crash-guard.ts'
import { GUIDE_BUTTONS, buildMenuTemplate, guideActionFor, guideUrl } from './menu.ts'
import { summariseStartupFailure } from './startup-failure.ts'
import { COPYRIGHT, PRODUCT_DESCRIPTION, PRODUCT_NAME, dshHome, resolvePaths, type DesktopPaths } from './paths.ts'
import { disableThirdPartyPlugins, profileBundleDrift } from './project-manager.ts'
import { describeRunningInstance } from './running-instance.ts'
import { UpdateCoordinator, type UpdaterLike } from './update-coordinator.ts'
import { resolveUpdateFeed, updateFeedWarning } from './update-feed.ts'
import { resolveUpdateScheduleConfig } from './update-schedule.ts'
import {
  assetChoice, channelFileFor, measuringEnabled, packagedFeedUrl, packageTypeOf, requestHeadersFor,
  routeUpdateSource, updateSources,
} from './update-sources.ts'
import type { UpdateFeed, UpdateState } from './update-contract.ts'
import {
  APP_ORIGIN, SHELL_ORIGIN, authenticateWebHost, forwardWebRequest,
  isStaticDocument, serveStatic, websocketHandshakeHeaders,
} from './web-document.ts'

/** The privileged scheme every application document is served from. */
const SCHEME = 'qialike-app'

/**
 * The update coordinator, created once the application is ready.
 *
 * `undefined` until then, and `undefined` forever in a run whose build has no
 * feed — which is a normal state, not a degraded one. See update-feed.ts.
 */
let updates: UpdateCoordinator | undefined

/** The product version, inlined by the build. */
const VERSION = process.env.QIALIKE_DESKTOP_VERSION ?? app.getVersion()

/**
 * How long to wait for the renderer's first frame before showing the window anyway.
 *
 * Eight seconds is generous against a cold start that has to boot the Host and compose the
 * profile — measured at roughly two to four seconds on this machine — so a healthy launch
 * always wins the race. It is short enough that a machine which will never paint does not
 * look hung for longer than a person would wait before force-quitting.
 */
const WINDOW_SHOW_FALLBACK_MS = 8000

/**
 * Where the shell's own log lives: `$DSH_HOME/qialike-desktop.log`, beside the Host's `qialike.log`.
 *
 * Resolved once, here, because the dialog names it and a path computed at the point of failure could
 * disagree with the one the file was written to.
 */
const logPath = desktopLogPath(dshHome())

/**
 * Whether the application got far enough to have a window worth keeping.
 *
 * Read by the crash guard to decide whether a dialog is still the right instrument for an unexplained
 * failure. Before this is true there is no window, so a modal is the only channel and it is a fair one;
 * after it, the user is working and the log is the better place — see `main-crash-guard.ts`.
 */
let startupSettled = false

// Installed here, above everything that can throw, and before `app.whenReady()`: the listener's only job is
// to be present when Electron's own handler counts the listeners, and a failure during startup is exactly
// the kind this has to catch.
installMainProcessGuard({
  logPath,
  announce: (title, body) => { dialog.showErrorBox(title, body) },
  shouldAnnounce: () => !startupSettled,
})

/** The release channel, inlined by the build; absent on a plain development run. */
const CHANNEL = process.env.QIALIKE_DESKTOP_CHANNEL

const paths: DesktopPaths = resolvePaths({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  userDataPath: app.getPath('userData'),
})

/** The Host, once it is up. */
let host: DesktopHost | undefined
/** Its origin and cookie, once the credential has been redeemed. */
let hostOrigin: string | undefined
let hostCookie: string | undefined
/** The main window. */
let mainWindow: BrowserWindow | undefined
/** Startup, so a renderer that asks early still gets an answer. */
let startup: Promise<void> | undefined
/**
 * Whether the unexpected-exit report has already run its course.
 *
 * One dialog, one report, one relaunch decision: a crash handler that fires twice
 * would stack dialogs over a window that no longer exists.
 */
let hostExitReported = false

/**
 * Register the application scheme as privileged.
 *
 * Must run before `app.whenReady()`: `standard` gives the origin a real
 * same-origin policy and lets relative URLs resolve, `secure` makes it a
 * trustworthy origin so the client's `crypto.subtle` and service-worker checks
 * pass, and `supportFetchAPI`/`stream` let the proxy stream a response body
 * rather than buffer it.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
}])

/** The dist directory the packaged browser surface is served from. */
function webDistDir(): string {
  return join(paths.runtime, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
}

/** The shell's own documents: the loading page a first paint shows. */
function shellDir(): string {
  return join(app.getAppPath(), 'renderer')
}

/**
 * Bring the Host up and redeem its credential.
 *
 * Runs at most once. Both the window's first load and a renderer asking for its
 * boot rows go through this, so neither can start a second Host.
 */
function startBackend(): Promise<void> {
  startup ??= (async () => {
    // The profile is created by the Host, as its first action — see
    // project-manager.ts for why the shell does not do it. This only reports a
    // profile that an older build left declaring a different layer set.
    const drift = profileBundleDrift(paths.profile)
    if (drift !== undefined) console.warn(`qialike desktop: ${drift}`)
    if (!app.isPackaged) console.log(`qialike desktop: runtime ${paths.runtime}\nqialike desktop: profile ${paths.profile}`)

    const running = await startHost({
      runtime: paths.runtime,
      profile: paths.profile,
      port: 0,
      // THE ONLY WATCHER ON A HOST THAT DIES AFTER STARTUP. Without this the child
      // is observed by nothing until the shell decides to stop it, so a mid-session
      // crash leaves the window rendering over a backend that is gone — every
      // request fails, nothing says why, and the diagnostics died with the process.
      // `expected` carries the difference between "it crashed" and "we asked it to
      // stop", because a dialog on every quit is noise.
      onExit: (exit) => { void reportHostExit(exit) },
    })
    host = running
    hostOrigin = new URL(running.url).origin
    hostCookie = await authenticateWebHost(running.url)
    // The WebSocket handshake goes to the Host's own address, not through this
    // origin, so it needs the credential attached here — the one request the
    // proxy never sees.
    //
    // AND A DECLINED HANDSHAKE IS RECORDED, because declining one is otherwise
    // invisible from every direction. The carrier retries forever, the window shows
    // "Reconnecting...", the Host answers 403 without logging anything the shell can
    // see, and the only trace is a Chromium console line inside the page. Naming the
    // origin we refused is what turns that into a cause; it is bounded by a Set, so a
    // retry loop cannot turn a diagnostic into a flood.
    const declinedOrigins = new Set<string>()
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*', 'ws://localhost/*'] }, (details, callback) => {
      const requestOrigin = details.requestHeaders.origin ?? ''
      const overrides = websocketHandshakeHeaders(hostCookie ?? '', hostOrigin ?? '', requestOrigin)
      if (overrides === undefined && !declinedOrigins.has(requestOrigin)) {
        declinedOrigins.add(requestOrigin)
        console.error(
          `qialike desktop: refusing to authenticate a WebSocket handshake for ${details.url}`
          + ` — the page's origin is ${JSON.stringify(requestOrigin)}, which is neither`
          + ` ${APP_ORIGIN} nor ${SHELL_ORIGIN}`,
        )
      }
      callback(overrides === undefined ? { requestHeaders: details.requestHeaders } : { requestHeaders: { ...details.requestHeaders, ...overrides } })
    })

    // ── what this page may ask the operating system for ──────────────────────
    //
    // TWO THINGS, ONLY FROM OUR OWN DOCUMENT: the microphone, and the clipboard.
    //
    // Electron approves every permission request by default, which would be the wrong
    // default twice over: an embedded guest (the sidebar's browser) could reach the
    // microphone, and a page that navigated anywhere could too. So the decision is made
    // here, where the origin is known.
    //
    // `media` is the voice-input bundle — an optional feature the user turns on from
    // Plugins — which records from `getUserMedia` and posts the audio to the Host for
    // transcription. Only `audio` is granted; `video` is refused because nothing here
    // captures a camera, and a blanket grant would make a future request for one
    // invisible in review.
    //
    // THE CLIPBOARD IS THE OTHER ONE, AND REFUSING IT WAS A DEFECT OF THIS FILE. The first
    // version granted `media` alone, on the reasoning that nothing else was needed. It was:
    // every copy affordance in the product goes through
    // `navigator.clipboard.writeText` — the per-message copy icon, "Copy Session ID" — and
    // that call is gated on this permission. MEASURED on 0.4.7:
    //
    //     navigator.clipboard.writeText(…)  →  NotAllowedError: Write permission denied
    //     navigator.permissions.query({name:'clipboard-write'}).state  →  "denied"
    //     log: refused the "clipboard-read" permission for qialike-app://app/
    //
    // The failure was silent in the interface because the harness's own helper returns
    // `false` instead of throwing, so a copy that could never work looked like a copy that
    // did nothing. `clipboard-sanitized-write` is what this Chromium actually requests;
    // `clipboard-read` is listed because Chromium asks for it as part of the same feature
    // and refusing it only produces noise. Read access is NOT granted by the API surface
    // the page uses — nothing here calls `readText`.
    //
    // EVERYTHING ELSE IS LEFT ASKED-BUT-REFUSED rather than approved, and that is a
    // deliberate narrowing of what the default allowed. Nothing in this product asks for
    // notifications, geolocation, HID, serial or MIDI, so a request for one is either a
    // defect or a hostile page — neither of which should be granted silently.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requesting = details.requestingUrl ?? contents.getURL()
      // `mediaTypes` exists only on the media variant of the union, so it is read after
      // the permission is known to be `media` — the type system asks for that narrowing
      // and it is also the honest order of the question.
      const mediaTypes = permission === 'media'
        ? (details as { mediaTypes?: readonly string[] }).mediaTypes ?? []
        : []
      const ours = requesting.startsWith(APP_ORIGIN)
      // `clipboard-sanitized-write` is the name Chromium uses for a page writing text; it is
      // the one the failing call above actually needed. `clipboard-read` rides along because
      // Chromium asks for the pair when the feature is first touched, and answering it is
      // harmless: the API this page can reach has no read entry point.
      const allowed = ours && (
        (permission === 'media'
          && mediaTypes.length > 0
          && mediaTypes.every((kind) => kind === 'audio'))
        || permission === 'clipboard-sanitized-write'
        || permission === 'clipboard-read'
      )
      if (!allowed) {
        console.warn(
          `qialike desktop: refused the ${JSON.stringify(permission)} permission for ${requesting}`
          + `${permission === 'media' ? ` (${mediaTypes.join(', ') || 'no media types'})` : ''}`,
        )
      }
      callback(allowed)
    })
    // Chromium also asks this one for a *check* — a page inspecting whether it may ask —
    // and a handler that only answers the request would leave that path on the default.
    // `permissions.query({name:'clipboard-write'})` reads THIS handler, so a permission
    // granted above and refused here would still report `denied` and the write would still
    // fail: the two have to agree, which is why they are written together.
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (!requestingOrigin.startsWith(APP_ORIGIN)) return false
      if (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') return true
      if (permission !== 'media') return false
      return details.mediaType === undefined || details.mediaType === 'audio'
    })
  })()
  return startup
}

/** The boot payload the renderer starts the client from. */
function bootPayload(): DesktopBootPayload {
  if (host === undefined || hostOrigin === undefined) {
    throw new Error('qialike desktop: the Host is not ready')
  }
  return {
    injections: host.injections,
    streamBaseUrl: hostOrigin,
    version: VERSION,
    ...(CHANNEL === undefined ? {} : { channel: CHANNEL }),
  }
}

/** Install the protocol handler that answers every application-origin request. */
function installProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)

    // The shell's own documents never touch the Host: they have to work exactly
    // when the Host does not.
    if (url.hostname === SHELL_HOSTNAME) {
      return serveStatic(request, shellDir(), { gateBoot: false })
    }
    if (url.hostname !== APP_HOSTNAME) return new Response(null, { status: 404 })

    // The document and its assets come from the packaged dist, so the window can
    // paint while the Host is still booting. The index gets the boot gate: the
    // rows it needs do not exist yet.
    if (isStaticDocument(url.pathname)) {
      return serveStatic(request, webDistDir(), { gateBoot: true })
    }

    // Everything else is the product's API, streamed from the Host.
    if (hostOrigin === undefined || hostCookie === undefined) return new Response(null, { status: 503 })
    try {
      return await forwardWebRequest(request, hostOrigin, hostCookie)
    } catch (error) {
      // A Host that died mid-request is a 502, not an unhandled rejection that
      // would leave the renderer waiting on a promise that never settles.
      const message = error instanceof Error ? error.message : String(error)
      return new Response(JSON.stringify({ error: `the desktop Host is unreachable: ${message}` }), {
        status: 502, headers: { 'content-type': 'application/json' },
      })
    }
  })
}

/** Create the main window and load the application document. */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#1b1c20',
    title: PRODUCT_NAME,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      // Not under `lib/`: that directory is the TypeScript output, and this file
      // is hand-written CommonJS because a sandboxed preload can only resolve
      // `electron`, `events`, `timers` and `url`. See preload/preload.cjs.
      preload: join(app.getAppPath(), 'preload', 'preload.cjs'),
      // The renderer is a web page. It gets no Node, no direct Electron IPC, and
      // its own isolated world; everything it may do crosses the preload.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Embedded guests are the sidebar browser's, and only the main window may
      // create one.
      webviewTag: true,
    },
  })

  // THE WINDOW MUST NOT DEPEND ON ONE EVENT TO BECOME VISIBLE.
  //
  // `show: false` plus `ready-to-show` is the ordinary pattern: it avoids the white flash
  // before the first paint. But `ready-to-show` is emitted by the RENDERER's first frame, so
  // anywhere that frame never arrives the window stays hidden while the process runs
  // normally — reported from a Wayland session as "it is running but nothing appears".
  //
  // This is a real class of failure rather than a guess: under Wayland a compositor and GPU
  // stack that cannot produce a frame (no EGL/GL context, `--disable-gpu` unset, an
  // XWayland-less session) leaves the renderer without a first paint, and Electron has no
  // timeout of its own. The application then looks hung while the Host, the router and the
  // profile are all healthy — and the log says nothing, because nothing failed.
  //
  // So the event is an optimisation, not the mechanism: a timer shows the window regardless.
  // Showing a window that is still blank is strictly better than an application that appears
  // not to have started, and on a healthy machine the event wins the race and this never
  // fires.
  const showAnyway = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }, WINDOW_SHOW_FALLBACK_MS)
  window.once('ready-to-show', () => {
    clearTimeout(showAnyway)
    window.show()
  })
  window.on('closed', () => {
    clearTimeout(showAnyway)
    mainWindow = undefined
  })

  // The product page must never navigate away from its own origin: an external
  // link belongs in the user's browser, not in a window with a preload attached.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  void window.loadURL(`${APP_ORIGIN}/`)
  mainWindow = window
  return window
}

/**
 * The About panel's content, shown by this application's own dialog off macOS.
 *
 * WHY THE PROFILE LINE IS GONE. It printed `paths.profile`, which is `PROFILE_NAME` — a constant this
 * application owns one of and never varies — so every user saw the same string on every run. It read as
 * a diagnostic, and a diagnostic that cannot differ is not one.
 */
function showAboutDialog(): void {
  void dialog.showMessageBox({
    title: `About ${PRODUCT_NAME}`,
    message: `${PRODUCT_NAME} ${VERSION}`,
    detail: `${PRODUCT_DESCRIPTION}\n${COPYRIGHT}`,
  })
}

/**
 * Give the system About panel the same content, so both platforms say one thing.
 *
 * macOS does not show the dialog above: its About is a system panel, reachable from the application
 * menu, and without this it would show only a name and a version while every other platform showed the
 * description and the licence. `applicationVersion` is the field macOS presents as the version;
 * `version` is the build number, which this product does not set.
 *
 * Called from `whenReady` rather than at module load because the panel reads it when it opens, and a
 * failure here must not be able to stop the application from starting.
 */
function installAboutPanel(): void {
  if (process.platform !== 'darwin') return
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: VERSION,
    credits: PRODUCT_DESCRIPTION,
    copyright: COPYRIGHT,
  })
}
/**
 * Install the application menu.
 *
 * The template is defined in `./menu.ts` so that a test can read it. It was inline here until a change to
 * it left the Help entry with no `submenu` — unclickable — while the test covering it passed, because that
 * test asserted on this file's text instead of on the menu's contents. `main.ts` cannot be imported by a
 * test; pure data can.
 */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    isMac: process.platform === 'darwin',
    productName: PRODUCT_NAME,
    // The same source the renderer's locale comes from, and MEASURED TO AGREE WITH IT rather than assumed:
    // on this machine `LANG=zh_CN.UTF-8` gives `app.getLocale() === 'zh-CN'` here and
    // `navigator.languages === ['zh-CN','zh-CN','zh']` in the renderer, and the default environment gives
    // `'en-GB'` in both. So the menu's language cannot disagree with the interface's.
    //
    // NOT `--lang`. It was tried, and it changes NEITHER: with `--lang=zh-CN` and an English environment,
    // `app.getLocale()` still answers `en-GB` and the renderer still reports `en-GB`. Chromium's locale on
    // this platform comes from the environment, so `--lang` is a no-op here and relying on it would have
    // produced an English menu over a Chinese interface.
    //
    // Read once, when the menu is built, which is why a language change needs a restart.
    locale: app.getLocale(),
    onShowAbout: showAboutDialog,
    // The `https:` guard is here rather than inside the menu module for the same reason the About dialog is:
    // that module holds the menu's shape, and opening URLs is the shell's business. It is the same guard the
    // window's own external links go through.
    onOpenGuide: () => { void showUserGuide() },
  })))
}

/**
 * Offer the user guide: open it, or hand the user its address.
 *
 * WHY A DIALOG AND NOT A SINGLE `shell.openExternal` CALL. That call cannot be trusted to report its own
 * failure, and this was measured on the machine the defect was found on rather than reasoned about:
 *
 *   · There, the default browser is a SNAP. Snap launches through `systemd-run`, and a caller inside a
 *     namespace systemd cannot attribute to a unit makes it fail with `cannot create transient scope …
 *     Process N is a kernel thread, refusing`.
 *   · **`xdg-open` still exits 0 when that happens**, so `shell.openExternal` RESOLVES and a `catch` around
 *     it never runs. The menu item does nothing, and — until this dialog existed — said nothing anywhere.
 *
 * So the failure cannot be detected reliably, and a dialog shown only on failure would never appear in the
 * case that motivated it. The dialog is therefore always shown, and it is the user's escape hatch: the
 * default button opens the browser, the second copies the address, and the detail says what to do if
 * nothing happens. The cost is stated where the buttons are declared: one keypress in the working case.
 */
async function showUserGuide(): Promise<void> {
    // RESOLVED PER INVOCATION, not captured at startup: `app.getLocale()` is the live answer,
    // and on macOS a language change takes effect without a relaunch. One lookup also keeps every
    // branch below — dialog text, copy, open, failure detail — on the same address, which a single
    // shared constant could not guarantee once there were two deployments.
    const url = guideUrl(app.getLocale())
  const options = {
    type: 'info' as const,
    title: `${PRODUCT_NAME} user guide`,
    message: 'User guide',
    detail: `${url}\n\n`
      + 'If "Open in browser" does nothing, this application could not start the computer\'s default '
      + 'browser. Copy the address above and paste it into a browser, or set a different default browser '
      + 'and choose User guide again.',
    buttons: [...GUIDE_BUTTONS],
    defaultId: 0,
    cancelId: GUIDE_BUTTONS.length - 1,
  }
  // Two calls rather than one with an optional parent, for the reason `confirmUpdate` above spells out: the
  // overloads do not accept `undefined`.
  const { response } = mainWindow === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(mainWindow, options)

  const action = guideActionFor(response)
  if (action === 'copy') {
    clipboard.writeText(url)
    appendDesktopLog(logPath, `user guide: copied ${url}`)
    await dialog.showMessageBox({
      type: 'info',
      title: `${PRODUCT_NAME} user guide`,
      message: 'Link copied',
      detail: url,
      buttons: ['OK'],
    })
    return
  }
  if (action !== 'open') {
    // A dismissal is still worth a line: it is the difference between "the user was not interested" and
    // "the application did nothing", and those read the same in every other record we keep.
    appendDesktopLog(logPath, `user guide: dismissed`)
    return
  }
  try {
    await shell.openExternal(url)
    // Recorded even on success, and that is the point: this call RESOLVES when the browser failed to start,
    // so the log is the only place the attempt itself is visible.
    appendDesktopLog(logPath, `user guide: asked the desktop to open ${url}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendDesktopLog(logPath, `user guide: could not open ${url}\n${message}`)
    const { response: after } = await dialog.showMessageBox({
      type: 'warning',
      title: `${PRODUCT_NAME} user guide`,
      message: 'Could not open the user guide',
      detail: `${message}\n\n${url}`,
      buttons: ['Copy link', 'Close'],
      defaultId: 0,
      cancelId: 1,
    })
    if (after === 0) clipboard.writeText(url)
  }
}

/**
 * Ask the user whether to restart into the downloaded update.
 *
 * A native dialog rather than an in-page one, because the answer destroys the
 * page: accepting restarts the application. The dialog is attached to the main
 * window so it cannot be lost behind it.
 *
 * @param state - what the updater reported; its version names the release.
 * @returns whether the user chose to install now.
 */
async function confirmUpdate(state: UpdateState): Promise<boolean> {
  const version = state.version === undefined ? '' : ` ${state.version}`
  const options = {
    type: 'info' as const,
    title: `${PRODUCT_NAME} update`,
    message: `Restart to install${version}?`,
    detail: 'The update has been downloaded. Restarting now closes any running session; '
      + 'choosing Later installs it the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }
  // Two calls rather than one with an optional parent: the overloads do not accept
  // `undefined`, and a dialog with no parent is a different (still correct) call.
  const { response } = mainWindow === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(mainWindow, options)
  return response === 0
}

/**
 * Attach the headers the feed's host cannot be read without.
 *
 * THE ONE PLACE THAT KNOWS. A feed arrives as an override URL, as a packaged
 * `app-update.yml`, or — after routing — as neither yet. The host requirement is the
 * same in every case, so it is applied to the feed once, here, rather than being
 * repeated by each path that can produce one. A `bundled` feed carries no URL, which
 * is exactly why this cannot be folded into the URL handling: the packaged
 * configuration is read for its address and the answer travels with the feed.
 *
 * @param feed - the feed as resolved.
 * @returns the feed, with headers when its host needs them.
 */
function withHostHeaders(feed: UpdateFeed): UpdateFeed {
  const url = feed.kind === 'url' ? feed.url : packagedFeedUrl(process.resourcesPath)
  if (url === undefined) return feed
  const headers = requestHeadersFor(url)
  if (headers === undefined) return feed
  return { ...feed, requestHeaders: headers }
}

/**
 * The source chooser for this build, or undefined when there is nothing to choose.
 *
 * THE ADDRESS THE BUILD CARRIES IS WHAT NAMES THE MIRROR. A packaged
 * `app-update.yml` records the feed, and `resolveUpdateFeed` reports only that it
 * exists — so the URL is read here to derive the mirror of *that* repository. The
 * consequence is the point: a fork pointing at its own server, a test feed, or a
 * build with no feed at all derives no mirror, gets no chooser, and keeps exactly
 * the behaviour it had before any of this existed.
 *
 * An explicit `QIALIKE_DESKTOP_UPDATE_URL` also yields one source, for the same
 * reason the CLI's `QIALIKE_INSTALL_BASE_URL` does: an override names one host on
 * purpose, and quietly adding a second would defeat it.
 *
 * @param feed - the resolved feed.
 * @returns the chooser, or undefined when the feed is the only answer.
 */
function buildSourceRoute(feed: UpdateFeed): (() => Promise<UpdateFeed | undefined>) | undefined {
  const packagedUrl = packagedFeedUrl(process.resourcesPath)
  const configured = feed.kind === 'url' ? feed.url : packagedUrl
  const sources = updateSources(configured)
  if (sources.length < 2) return undefined
  return async () => {
    const chosen = await routeUpdateSource({
      sources,
      channel: channelFileFor(process.platform),
      choice: assetChoice(process.platform, packageTypeOf(process.resourcesPath)),
      measure: measuringEnabled(process.env),
      log: (message) => { console.log(`qialike desktop: ${message}`) },
    })
    if (chosen.base === configured) return undefined
    // Switching hosts has to be handed to the updater, because `app-update.yml`
    // still names the original one. `packagedConfig` is true whenever that file is
    // what named the source, which is the only way a second source can exist here.
    //
    // The chosen source's own headers travel with it. They are not decoration: one
    // of the two hosts answers a manifest request carrying a query string with 404,
    // and this is what stops `electron-updater` adding one.
    return {
      kind: 'url',
      url: chosen.base,
      packagedConfig: packagedUrl !== undefined,
      ...(chosen.source?.requestHeaders === undefined ? {} : { requestHeaders: chosen.source.requestHeaders }),
    }
  }
}

/**
 * Create the update coordinator for this run.
 *
 * A configuration error — a malformed `QIALIKE_DESKTOP_UPDATE_URL`, or an
 * out-of-range interval — is reported and disables updates rather than stopping
 * the application: a mistyped environment variable must not make the product
 * unlaunchable.
 */
async function installUpdates(): Promise<void> {
  try {
    const resolved = resolveUpdateFeed({
      env: process.env,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    if (resolved === undefined) {
      console.log('qialike desktop: no update feed configured; update checks are disabled')
      return
    }
    // GIVE THE FEED THE HEADERS ITS HOST NEEDS, whichever way the URL arrived.
    //
    // There are three ways for a feed to be named — the environment override, the
    // packaged `app-update.yml`, and the routing decision — and the requirement is a
    // property of the host in all three. Attaching it here, once, is what keeps the
    // second and third from depending on the first: a `bundled` feed carries no URL
    // at all, so without this a build pointed at such a host could never check while
    // looking perfectly configured.
    const feed = withHostHeaders(resolved)
    // A check that works and a download that cannot: reported up front, because the
    // symptom appears much later and points nowhere near the cause.
    const warning = updateFeedWarning(feed)
    if (warning !== undefined) console.warn(`qialike desktop: update: ${warning}`)
    // Imported here rather than at the top of the file for two reasons: a
    // development run has no packaged feed for it to read, and this module is ESM —
    // `require` is not defined in it, so a lazy load has to be a dynamic `import`.
    const loaded = await import('electron-updater') as unknown as { autoUpdater?: UpdaterLike, default?: { autoUpdater?: UpdaterLike } }
    const autoUpdater = loaded.autoUpdater ?? loaded.default?.autoUpdater
    if (autoUpdater === undefined) {
      throw new Error('electron-updater exposed no autoUpdater')
    }
    const route = buildSourceRoute(feed)
    updates = new UpdateCoordinator({
      updater: autoUpdater,
      feed,
      schedule: resolveUpdateScheduleConfig(process.env),
      log: (message) => { console.log(`qialike desktop: ${message}`) },
      ...(route === undefined ? {} : { route }),
    })
    // Push each presentation to the window. The renderer's own `status()` call
    // covers the case where it mounted before the first transition, so a missed
    // push is a stale badge rather than a missing one.
    updates.subscribe((presentation) => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(DESKTOP_IPC.updatesPresentation, presentation)
    })
    updates.start()
  } catch (error) {
    console.error(
      `qialike desktop: update checks are disabled: ${error instanceof Error ? error.message : String(error)}`,
    )
    updates = undefined
  }
}

/** Register every IPC channel, each validating its sender. */
function installIpc(): void {
  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertApplicationSender(event)
    await startBackend()
    return bootPayload()
  })

  ipcMain.handle(DESKTOP_IPC.pickDirectory, async (event) => {
    assertApplicationSender(event)
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const result = window === undefined
      ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
      : await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  /**
   * Save a document the renderer produced, at a path the user chooses.
   *
   * THE SHELL OWNS THIS, not the page: a save dialog is a native window, and the write has to
   * happen outside the renderer's sandbox. `assertApplicationSender` is the same guard every
   * other channel uses — a request from a guest or a navigated frame is refused rather than
   * answered.
   *
   * `defaultPath` carries the suggested name, which is what makes the dialog open in a useful
   * place with a useful name instead of an empty box. The extension filter follows the media
   * type so the file is not saved as `.txt` by a filter mismatch.
   */
  ipcMain.handle(DESKTOP_IPC.saveDocument, async (event, request: unknown) => {
    assertApplicationSender(event)
    const input = request as { suggestedName?: unknown, contents?: unknown, mimeType?: unknown }
    const suggestedName = typeof input?.suggestedName === 'string' ? input.suggestedName : ''
    const contents = typeof input?.contents === 'string' ? input.contents : ''
    const mimeType = typeof input?.mimeType === 'string' ? input.mimeType : 'text/plain'
    if (suggestedName === '') throw new Error('qialike desktop: saveDocument needs a suggested name')

    const extension = suggestedName.includes('.') ? suggestedName.slice(suggestedName.lastIndexOf('.') + 1) : ''
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('documents'), suggestedName),
      ...(extension === '' ? {} : { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] }),
    }
    const result = window === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options)
    if (result.canceled || result.filePath === undefined || result.filePath === '') return null
    await writeFile(result.filePath, contents, 'utf8')
    void mimeType
    return result.filePath
  })

  ipcMain.handle(DESKTOP_IPC.locale, (event) => {
    assertApplicationSender(event)
    return app.getLocale()
  })

  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertApplicationSender(event)
    return updates?.status() ?? { phase: 'idle' as const }
  })

  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertApplicationSender(event)
    if (updates === undefined) return
    await updates.open(async (state) => await confirmUpdate(state))
  })

  // The manual pair behind Settings' update row. `check` deliberately does NOT download — the user asked
  // whether there is an update, and answering that must not commit them to fetching it. The row offers the
  // download as its own action, which arrives here.
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertApplicationSender(event)
    if (updates === undefined) return
    await updates.check({ download: false })
  })

  ipcMain.handle(DESKTOP_IPC.updatesDownload, async (event) => {
    assertApplicationSender(event)
    if (updates === undefined) return
    await updates.downloadNow()
  })

  ipcMain.on(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    try {
      assertApplicationSender(event)
    } catch {
      return
    }
    const text = typeof message === 'string' ? message : 'the client reported an unspecified startup failure'
    console.error(`qialike desktop: client startup failed: ${text}`)
    // Reported rather than swallowed: a client that cannot start leaves a page
    // that looks hung, and the only useful thing the shell can do is say so. The dialog carries a summary
    // and a remedy; the whole thing goes to the log, which the dialog names.
    const logged = appendDesktopLog(logPath, `client startup failed\n${text}`)
    const summary = summariseStartupFailure(text, logged ? { logPath } : {})
    void dialog.showMessageBox({
      type: 'error',
      title: `${PRODUCT_NAME} could not start`,
      message: summary.message,
      detail: summary.detail,
      buttons: ['Quit'],
    }).then(() => { app.quit() })
  })
}

/**
 * Recover from a Host that cannot start, once per process.
 *
 * The common cause is a third-party plugin that no longer loads. The dialog's
 * action disables third-party bundles and moves the user's patch layer aside,
 * keeping it, then restarts — which is a smaller intervention than a profile
 * reset and leaves the user's own layer recoverable.
 */
async function reportStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`qialike desktop: startup failed: ${message}`)
  const logged = appendDesktopLog(logPath, `the Host failed to start\n${message}`)
  const summary = summariseStartupFailure(message, logged ? { logPath } : {})
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: `${PRODUCT_NAME} could not start`,
    message: summary.message,
    detail: `${summary.detail}\n\nDisabling third-party plugins moves your profile patch layer aside (keeping a copy) and restarts.`,
    buttons: ['Quit', 'Disable third-party plugins and restart'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response === 1) {
    try {
      const backup = await disableThirdPartyPlugins(paths.profile, paths.runtime)
      console.log(`qialike desktop: third-party plugins disabled${backup === undefined ? ' (no patch layer to move)' : `; patch layer backed up to ${backup}`}`)
    } catch (recoveryError) {
      console.error(`qialike desktop: recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`)
    }
    app.relaunch()
  }
  app.exit(0)
}

/**
 * Report a Host that stopped after startup without being asked to.
 *
 * WHY THE WINDOW IS CLOSED FIRST. Leaving it up would be the cruellest option: it
 * still renders, its sidebar still opens, and every action silently fails. A window
 * that has lost its backend is not a usable window with a problem, it is a broken
 * one, and saying so is the whole job of this function.
 *
 * The report is written *before* the dialog, so that a user who clicks through
 * without reading still has the file, and the dialog names its path — which is the
 * only way someone can attach the Host's last words to a bug report later.
 *
 * @param exit - the exit facts, including whether the shell asked for it.
 */
async function reportHostExit(exit: HostExit): Promise<void> {
  // The ordinary case, and the reason this needs `expected` rather than an exit
  // code: `stop()` is called on quit, on update, and on every relaunch.
  if (exit.expected) return
  // A second exit would mean a second dialog, and `app.exit` below already ends the
  // process — but the listener is installed before the first one can arrive.
  if (hostExitReported) return
  hostExitReported = true

  const when = new Date()
  const report = writeCrashReport({
    product: PRODUCT_NAME,
    version: VERSION,
    code: exit.code,
    signal: exit.signal,
    when,
    url: hostOrigin ?? '(not resolved)',
    profile: paths.profile,
    // Read from the handle rather than from a variable here: the handle is what kept
    // it, and it is the only copy that survives the child being reaped.
    stderr: host?.stderrTail() ?? '',
    userDataDir: paths.userData,
  })
  const summary = summariseHostExit(exit)
  console.error(`qialike desktop: ${summary}${report === undefined ? ' (no report could be written)' : `; report at ${report}`}`)

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy()
  }
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: `${PRODUCT_NAME} stopped`,
    message: summary,
    detail: (report === undefined
      ? 'A report could not be written to disk.'
      : `A report was written to:\n${report}`)
      + '\n\nRestarting re-runs the same profile. If it stops again, the report names the reason.',
    buttons: ['Quit', 'Restart'],
    defaultId: 1,
    cancelId: 0,
  })
  if (response === 1) app.relaunch()
  app.exit(0)
}

// A second instance would race the first on the profile lock and on the port, so
// it hands its intent to the running one and exits.
//
// THE LOG LINE IS THE POINT, and it is written *here* rather than left to the
// per-launch entry in `whenReady` — which is downstream of this branch and therefore
// never runs. Without it, a refused launch leaves nothing behind at all: no window, no
// error, no log entry, so "the new build does not start" is reported against a build
// that was never the problem. Naming the holder is also what makes it actionable; see
// running-instance.ts for why both the pid and the host are in the sentence.
//
// AND IT READS `app.getPath('userData')`, NOT `paths.userData`. Those are the same
// directory in every ordinary launch, which is exactly why the difference is worth a
// comment: `QIALIKE_DESKTOP_USER_DATA_DIR` moves the *application's* idea of its data
// directory (`paths.userData`) but does not move Electron's, so a diagnostic that read
// the former would name a path holding no lock and conclude "names no holder" while a
// real holder sat in the other directory. Electron's own answer is the only one that
// describes where the lock it just refused actually is.
if (!app.requestSingleInstanceLock()) {
  appendDesktopLog(logPath, `refused this launch: ${describeRunningInstance(app.getPath('userData'))}`)
  app.quit()
} else {
  // The other half of the refusal above. That entry says a launch was turned away; this
  // one says the request *arrived here*, and whether there was a window to raise. Read
  // together they separate the two cases that look identical from the outside otherwise:
  // a running instance that was asked and could not respond, and one that was never
  // asked at all. The second is what a wedged shell produces, and before this entry it
  // produced no evidence either.
  app.on('second-instance', () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      appendDesktopLog(logPath, 'another launch asked this instance to show its window, but this instance has none to raise')
      return
    }
    appendDesktopLog(logPath, 'another launch asked this instance to show its window; raised it')
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.on('window-all-closed', () => {
    // Closing the last window on Windows and Linux ends the application; on
    // macOS it stays in the Dock, which is what the platform expects.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (mainWindow === undefined) createWindow()
  })

  // The Host is a child process with a profile lock; leaving it behind would make
  // the next launch refuse to start.
  //
  // TWO FLAGS, NOT ONE, AND THE SECOND IS THE FIX. `before-quit` fires again when
  // `app.quit()` is called from this handler, so a single `stopping` flag had to answer
  // two different questions — "is a teardown already running?" and "has it finished?" —
  // and it answered the first. A second quit request arriving mid-teardown (the user
  // pressing the shortcut again, or closing the window again, because nothing appeared
  // to happen) therefore fell through without `preventDefault()`, the shell exited on
  // the spot, and the in-flight `stop()` died with it: its escalation timers never ran,
  // so the Host was never killed. The orphan then holds the profile lock, and the *next*
  // launch refuses to start — the same dead end this comment warns about, reached by
  // trying to quit twice.
  //
  // `stopped` is what lets the quit through once, at the end, and only then. Nothing
  // here needs a deadline of its own: `stop()` is bounded inside host-process.ts
  // (graceful → SIGTERM → SIGKILL → a bounded wait for the exit), which is where the
  // unbounded await used to be. This handler's job is just to not abandon it.
  let stopping = false
  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped || host === undefined) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    void host.stop().catch((error: unknown) => {
      console.error(`qialike desktop: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { stopped = true; app.quit() })
  })

  void app.whenReady().then(async () => {
    mkdirSync(paths.userData, { recursive: true })
    // One line per launch, so the log exists before anything goes wrong and a later report can be read
    // against what was actually running: the version, the runtime tree, and the profile. Without it the
    // file's first entry would be a failure, with no statement of what failed.
    appendDesktopLog(logPath, `started ${PRODUCT_NAME} ${VERSION}\nruntime ${paths.runtime}\nprofile ${paths.profile}`)
    installProtocolHandler()
    installIpc()
    installAboutPanel()
    installMenu()
    // The window first, the Host after: the user sees the application start
    // rather than a blank frame while a profile composes.
    createWindow()
    // NO OFFICE CHECK HERE, AND THAT IS A DELIBERATE MOVE RATHER THAN AN OMISSION. It used to run
    // once per launch and put its verdict in a modal dialog, which meant every user met a warning
    // about a feature most of them never open, and the ones who did met it far from the control
    // that fixes it. The question now belongs to the Office row in Settings → Built-in plugins,
    // which asks it there, when the user is looking at the answer — `diagnose.js` in
    // `@qialike/qialike-desktop-office-engine` is where it lives.
    // After the window exists: the first transition is pushed to it, and a
    // coordinator started earlier would have nowhere to report.
    // Not awaited: the update check is never a reason to delay the Host, and the
    // coordinator reports its own failures.
    await installUpdates()
    await startBackend().catch(reportStartupFailure)
    startupSettled = true
  })
}
