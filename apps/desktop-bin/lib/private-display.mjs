/**
 * A private X display for anything that opens a window.
 *
 * WHY THIS EXISTS. Every probe and the end-to-end run launch the real application, which opens a real
 * window. They inherited `DISPLAY` from the shell, so those windows appeared on the developer's own desktop
 * — dozens of them over a working session, each stealing focus and each looking exactly like the
 * application starting on its own. That is a nuisance at best and, when one of them leaves a modal dialog
 * open, indistinguishable from a real defect: the person sees "Qialike could not start" and has no way to
 * know a test put it there.
 *
 * The fix is a nested X server: `Xephyr` runs a display inside a window, so the application renders into a
 * display nothing else is looking at. It is a real X server, so rendering, screenshots and input all behave
 * as they do on a desktop — which a genuinely headless mode would not give us, because this application is
 * Chromium and Chromium needs a display to paint into.
 *
 * FALLING BACK IS LOUD, NEVER SILENT. If `Xephyr` is missing the inherited display is used, and the caller
 * is told, because the consequence is windows on someone's desk. A silent fallback would restore exactly
 * the behaviour this module exists to remove, and the person would have no way to tell.
 *
 * A DISPLAY NUMBER IS CHECKED BY ASKING IT, NOT BY LOOKING FOR ITS SOCKET. This module used to choose a
 * number by listing `/tmp/.X11-unix`, which is wrong in two ways that both end in the same false claim.
 * The directory can be *invisible* — a sandbox with a private `/tmp` shows nothing, so every run picks the
 * same number — and a server can be reachable without leaving a socket there at all, because X also
 * listens on an abstract socket. In either case a leaked server from an earlier run answers on the number
 * we just chose, this module reports `private: true` while the window is going somewhere it can see, and
 * the child we spawned has already exited for a reason we never looked at.
 *
 * So the chosen number is now confirmed free by asking, and `stop` insists until the display is actually
 * gone. Leaks happen — a probe killed by `timeout` never reaches its `finally` — and the defence that
 * matters is that the *next* run cannot be fooled by one.
 *
 * @module qialike-desktop/private-display
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

/** Display numbers below this are left alone; they may belong to the person using the machine. */
const FIRST_DISPLAY = 90
const LAST_DISPLAY = 199

/** How long `stop` waits for a display to go away before insisting with SIGKILL. */
const STOP_TIMEOUT_MS = 3000

/**
 * Pick a display number nothing is using.
 *
 * Pure, and separate from the spawning, because it is the part that can be wrong in a way worth testing:
 * two runs at once must not land on the same display.
 *
 * TWO WAYS A NUMBER IS TAKEN, AND BOTH ARE CHECKED. The socket directory is a cheap first filter, but it
 * is not authoritative (see the module comment), so `occupies` asks the display itself. A number is
 * skipped if either says so.
 *
 * @param options.taken - display numbers whose socket is present. Defaults to the X socket directory.
 * @param options.occupies - `(number) => boolean`, whether a live server already answers there. Defaults
 *   to always false, so the pure caller — and the tests of the socket filter alone — need no X server.
 * @returns a free display number.
 * @throws Error when the whole range is occupied.
 */
export function pickDisplayNumber({ taken = takenDisplays(), occupies = () => false } = {}) {
  for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n += 1) {
    if (taken.has(n)) continue
    if (occupies(n)) continue
    return n
  }
  throw new Error(
    `qialike-desktop: no free X display in ${String(FIRST_DISPLAY)}-${String(LAST_DISPLAY)}. Something is `
    + 'holding all of them; the private display cannot be started.',
  )
}

/** The display numbers the local X socket directory shows as in use. */
function takenDisplays() {
  const taken = new Set()
  for (const dir of ['/tmp/.X11-unix']) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const match = /^X(\d+)$/u.exec(entry)
      if (match !== null) taken.add(Number(match[1]))
    }
  }
  return taken
}

/** Whether a display answers. `xdpyinfo` is the tool that can ask; without it, the socket is all we know. */
function displayAnswers(display) {
  const probe = spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore' })
  // A missing `xdpyinfo` reports an error too, so it cannot be distinguished from a dead display here; the
  // caller falls back to waiting on the socket, and the timeout below is the real guard.
  return probe.status === 0
}

/**
 * Start a private display.
 *
 * @param options.log - progress sink.
 * @param options.timeoutMs - how long to wait for it to answer.
 * @returns `{ display, stop, private }` — `display` is the value to put in the child's env, `private` says
 *   whether it is actually isolated, and `stop` releases it. Safe to call `stop` more than once.
 */
export function startPrivateDisplay({ log = () => {}, timeoutMs = 10_000 } = {}) {
  if (spawnSync('Xephyr', ['-help'], { stdio: 'ignore' }).error !== undefined) {
    log('private-display: Xephyr is not installed, so windows will open on the inherited display')
    return { display: process.env.DISPLAY, stop: () => {}, private: false }
  }

  // Asked, not inferred: a number that already answers belongs to someone else, and starting beside it
  // would report a private display while rendering into theirs.
  const number = pickDisplayNumber({ occupies: (n) => displayAnswers(`:${String(n)}`) })
  const display = `:${String(number)}`

  const child = spawn('Xephyr', [display, '-screen', '1280x800', '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true,
  })
  let stopped = false
  const signalGroup = (signal) => {
    try {
      // The group, not just the child: Xephyr may fork, and a surviving X server holds the display number
      // until the machine reboots, which would make the next run pick a different one every time.
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    signalGroup('SIGTERM')
    // THEN CONFIRMED GONE, AND INSISTED ON. A server that ignores SIGTERM would leave this module's promise
    // — that the display is released — quietly false, and the next run would find the number answering.
    // Polled rather than awaited, because callers release the display from a `finally`.
    //
    // NOT EXERCISED BY ANY TEST, and said plainly rather than implied: on this machine Xephyr is gone before
    // the first check runs, so reverting this loop to a bare SIGTERM still passes the suite. It is here for
    // the case that has not been observed, not because it has been shown to be needed.
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!displayAnswers(display)) return
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
    }
    signalGroup('SIGKILL')
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (displayAnswers(display)) {
      log(`private-display: ${display} (Xephyr), so nothing opens on the inherited display`)
      return { display, stop, private: true }
    }
    // A synchronous wait, deliberately: this runs before any child exists, and the alternative is making
    // every caller of launchApp asynchronous for a few hundred milliseconds of setup.
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 120)'])
  }

  stop()
  log(`private-display: ${display} did not answer within ${String(timeoutMs)}ms, so windows will open on the inherited display`)
  return { display: process.env.DISPLAY, stop: () => {}, private: false }
}
