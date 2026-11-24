/**
 * Drive the update path end to end against a feed served from this machine.
 *
 * `tests/update-subsystem.test.mjs` verifies the state machine against a fake
 * updater, which says nothing about `electron-updater` itself: whether the feed
 * file parses, whether the version comparison fires, whether the artifact's digest
 * is checked, whether the AppImage backend will run at all. This probe answers
 * those by serving a real feed to a real packaged application and reading the
 * phases over the DevTools protocol.
 *
 * It stops at `ready`. Applying an AppImage update replaces the running file and
 * restarts it, which would destroy the process doing the observing — and on a real
 * release it is irreversible. So the install step is deliberately untested here.
 *
 * Usage: `node update-feed-probe.mjs <appBinary> <artifactDir> [--packaged-feed] [--expect <phase>]`
 *
 * @module qialike-desktop/update-feed-probe
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './app-launch.mjs'

const [appBinary, artifactDir, ...rest] = process.argv.slice(2)
if (appBinary === undefined || artifactDir === undefined) {
  console.error('usage: update-feed-probe.mjs <appBinary> <artifactDir> [--packaged-feed] [--expect <phase>]')
  process.exit(2)
}
const expectIndex = rest.indexOf('--expect')
const expectedPhase = expectIndex < 0 ? 'ready' : rest[expectIndex + 1]
const DEBUG_PORT = 19233
const FEED_PORT = 19234

/**
 * The artifact the feed offers, and its real digest.
 *
 * DISCOVERED, NOT NAMED. This was the literal `qialike-0.1.0-x86_64.AppImage`, which quietly
 * coupled a tool to one release. `electron-builder.config.mjs` names artifacts
 * `'${productName}-${version}-${arch}.${ext}'`, so bumping `package.json` renames the file and
 * the probe then died at `readFileSync` with ENOENT — in a file **no test runs**, so nothing
 * would have caught it before someone reached for the probe mid-release, which is exactly when
 * a broken instrument is most expensive.
 *
 * `<artifactDir>` is already an argument, so the name is derivable and no new flag is needed.
 * Filtering on `.AppImage` is deliberate rather than a convenience: the feed written below is
 * `latest-linux.yml`, so this probe drives the AppImage backend by construction and an artifact
 * of another kind could not work here anyway.
 */
const candidates = readdirSync(artifactDir).filter((name) => name.endsWith('.AppImage')).sort()
if (candidates.length === 0) {
  const present = readdirSync(artifactDir).sort()
  console.error(
    `update-feed-probe: no .AppImage in ${artifactDir}.\n`
    + '  This probe drives the Linux/AppImage update path (it writes latest-linux.yml), so it needs one.\n'
    + `  present: ${present.length === 0 ? '(empty)' : present.join(', ')}`,
  )
  process.exit(2)
}
if (candidates.length > 1) {
  // Refused rather than guessed: offering one of several artifacts would make the feed's
  // subject depend on directory order, and the probe would still exit 0 while reporting on a
  // file the operator did not mean.
  console.error(
    `update-feed-probe: ${String(candidates.length)} .AppImage files in ${artifactDir}, so which one to offer is ambiguous.\n`
    + '  Keep one, or point <artifactDir> at a directory holding just this release\'s artifact.\n'
    + `  found: ${candidates.join(', ')}`,
  )
  process.exit(2)
}
const artifact = candidates[0]
const artifactPath = join(artifactDir, artifact)

const sha512 = createHash('sha512').update(readFileSync(artifactPath)).digest('base64')
const feedDir = mkdtempSync(join(tmpdir(), 'qialike-feed-'))

// A version far above anything built here, so the comparison fires without
// depending on the build's own number.
const yml = [
  'version: 9.9.9',
  'files:',
  `  - url: ${artifact}`,
  `    sha512: ${sha512}`,
  `    size: ${String(statSync(artifactPath).size)}`,
  `path: ${artifact}`,
  `sha512: ${sha512}`,
  `releaseDate: '2026-01-01T00:00:00.000Z'`,
  '',
].join('\n')
writeFileSync(join(feedDir, 'latest-linux.yml'), yml)
// electron-updater looks for the channel file by platform; serving both names means
// the test does not depend on which one it asks for.
writeFileSync(join(feedDir, 'latest.yml'), yml)

const server = createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '/').split('?')[0].replace(/^\//u, ''))
  const path = join(feedDir, name)
  if (name === '') { response.writeHead(404).end('no'); return }
  try {
    const info = statSync(path)
    response.writeHead(200, {
      'content-length': info.size,
      'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
    })
    createReadStream(path).pipe(response)
  } catch {
    // The artifact lives in `artifactDir`, not the feed dir: served from the same
    // mount so one base URL covers both.
    try {
      const real = join(artifactDir, name)
      const info = statSync(real)
      response.writeHead(200, { 'content-length': info.size, 'content-type': 'application/octet-stream' })
      createReadStream(real).pipe(response)
    } catch {
      response.writeHead(404).end('not found')
    }
  }
})
await new Promise((resolve) => { server.listen(FEED_PORT, '127.0.0.1', resolve) })
const feedUrl = `http://127.0.0.1:${String(FEED_PORT)}`
console.log(`feed:      ${feedUrl} (${artifact}, sha512 ${sha512.slice(0, 16)}…)`)

const userData = mkdtempSync(join(tmpdir(), 'qialike-upd-user-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-upd-home-'))

// The AppImage runtime extracts the payload into `$TMPDIR` (or `/tmp`) and only
// removes it when it exits cleanly — which, when it is signalled, it does not. Giving
// the child its own `TMPDIR` means the extraction directory can be removed by exact
// path afterwards, instead of globbing `/tmp` for something that looks like ours.
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-probe-tmp-'))

// `electron-updater` stages the artifact it is downloading under `$XDG_CACHE_HOME`
// (falling back to `~/.cache`) before it verifies it, then renames it into place and
// keeps it — `AppUpdater.downloadUpdate` only unlinks it on the failure path. So the
// child needs a cache that is writable, and it must not be the developer's own. Both
// halves were observed:
//
//   · With `$HOME` read-only — as in this checkout's sandbox — the download fails with
//     `EROFS: read-only file system, open
//     '…/@qialikedesktop-updater/pending/2-temp-qialike-desktop-linux-….AppImage'`. Nothing in that
//     message mentions the probe, and it arrives after `available` has already lit up,
//     so it reads as a product bug rather than as a host constraint.
//   · With it writable, the ~290 MB this run downloaded is kept in
//     `~/.cache/@qialikedesktop-updater/` (the temp file was staged in that directory's
//     `pending/`, then renamed out of it) — a probe leaving its own download in the
//     developer's cache, where the next real check would find it.
//
// One directory per run answers both, and it is the same reasoning as `probeTmp`
// above: the child gets its own, and this script removes it by exact path.
const probeCache = mkdtempSync(join(tmpdir(), 'qialike-probe-cache-'))

const launched = launchApp({ binary: appBinary, args: [
  // An AppImage needs FUSE, which this container does not have; the runtime's
  // extract-and-run mode sets APPIMAGE the same way a normal launch does, and that
  // variable is what `electron-updater` uses to choose its Linux backend.
  ...(appBinary.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userData}`,
  '--no-sandbox', '--disable-gpu',
], env: {
  DSH_HOME: home,
  QIALIKE_DESKTOP_USER_DATA_DIR: userData,
  TMPDIR: probeTmp,
  XDG_CACHE_HOME: probeCache,
  // `--packaged-feed` omits the runtime override, so the feed has to come from the
  // `app-update.yml` electron-builder wrote — which is the path a released
  // artifact actually takes.
  ...(process.argv.includes('--packaged-feed') ? {} : { QIALIKE_DESKTOP_UPDATE_URL: feedUrl }),
    // The first check is armed at the polling interval — ten minutes by default,
    // because startup is the busiest moment and an update is never urgent. The
    // bridge deliberately offers no "check now", so the interval is how this drives
    // one; that also exercises the schedule and the env parsing end to end.
    DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3000',
    DSH_DESKTOP_UPDATE_CHECK_JITTER: '0',
    // `electron-updater`'s AppImage backend refuses to run without this, because it
    // is how it learns which file an update would replace. In a real AppImage
    // launch the runtime sets it.
    APPIMAGE: artifactPath,
  },
})
const log = () => launched.log()

/** Wait for the page target, then attach. */
async function attach() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`)).json()
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  return undefined
}

const page = await attach()
if (page === undefined) {
  console.log('NO_DEBUGGER_TARGET')
  console.log(log().slice(-3000))
  // Stopped through the same path as success, so a failed attach cannot leak an
  // application either.
  if (await stopApp(launched.child)) {
    removeDir(feedDir); removeDir(userData); removeDir(home); removeDir(probeTmp); removeDir(probeCache)
  }
  server.close()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let nextId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
function send(method, params) {
  const id = ++nextId
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.result?.value
}

// The bridge is installed by the preload, so its presence is itself the first
// assertion: without it the renderer's status call never resolves.
const bridge = await evaluate(`({
  hasMarker: typeof globalThis.dshDesktop !== 'undefined',
  hasUpdates: typeof (globalThis.dshDesktop || {}).updates !== 'undefined',
  methods: Object.keys((globalThis.dshDesktop || {}).updates || {}),
})`)
console.log('bridge:   ', JSON.stringify(bridge))

/** Drive one check and collect the phases the renderer observes. */
const observed = await evaluate(`(async () => {
  const updates = globalThis.dshDesktop.updates
  const seen = []
  const off = updates.subscribe((state) => seen.push(state))
  const first = await updates.status()
  const deadline = Date.now() + 240000
  let latest = first
  while (Date.now() < deadline) {
    latest = await updates.status()
    if (latest.phase === ${JSON.stringify(expectedPhase)} || latest.phase === 'error') break
    await new Promise((r) => setTimeout(r, 1000))
  }
  off()
  return { first, latest, seen: seen.slice(-8) }
})()`)

console.log('first:    ', JSON.stringify(observed?.first))
console.log('phases:   ', JSON.stringify(observed?.seen))
console.log('latest:   ', JSON.stringify(observed?.latest))
const ok = observed?.latest?.phase === expectedPhase
console.log(`RESULT:    ${ok ? 'PASS' : 'FAIL'} (expected ${expectedPhase})`)
if (!ok) console.log('--- log tail ---\n' + log().split('\n').filter((line) => line.trim()).slice(-15).join('\n'))

// Stop the application, confirm it is gone, and only then delete the directories it
// was handed. An earlier version killed the launcher — which for an AppImage is not
// the application — and deleted the user-data directory underneath the process that
// was still running, leaving a window on the desktop showing a failure. The exit
// code here reports that, rather than the verdict alone, because an unclean stop is
// a failure of this probe whatever the update did.
const stopped = await stopApp(launched.child)
if (stopped) {
  removeDir(feedDir)
  removeDir(userData)
  removeDir(home)
  removeDir(probeTmp)
  removeDir(probeCache)
} else {
  console.error('qialike-desktop: the application did not stop; leaving its directories in place')
}
server.close()
process.exit(ok && stopped ? 0 : 1)
