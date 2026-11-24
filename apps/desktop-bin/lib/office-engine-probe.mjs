/**
 * The office-engine row's route and activation, against the composed profile.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE ROW. The row imports
 * `@deepseek-ai/dsh-home-paths` and resolves `@deepseek-ai/libreoffice-kit`, neither of which
 * resolves in this repository's `node_modules` — so the module cannot be imported here at all. The
 * rules worth unit testing were split out into `lib/install.js` for exactly that reason; what is
 * left is wiring, and wiring is tested by booting it.
 *
 * Booting is also the stronger test in one specific way that matters here: a row that fails to
 * resolve produces one line of stderr — `warning: 1 entry did not activate` — and then the profile
 * boots, serves and renders normally. A feature had already shipped inert that way once in this
 * repository, so the activation outcome is asserted rather than assumed.
 *
 * WHAT IT DOES NOT COVER, AND WHY. It never installs anything: `plan` and `install` reach the
 * network and write 46 MiB, so a suite that ran them would fail on a bad network and pass for the
 * wrong reason on a cached one. Those are covered by `office-preview-probe.mjs --install`, which
 * drives a real packaged application from the page context — the same call the Settings button
 * makes — and then asserts the preview renders. This probe answers the narrower question the suite
 * can answer cheaply: is the row there, does it serve its status, and does it refuse what it should.
 *
 * Usage: `node office-engine-probe.mjs <absolute runtimeDir>`; prints `__REPORT__{json}`.
 *
 * @module qialike-desktop/office-engine-probe
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: office-engine-probe.mjs <absolute runtimeDir>\n')
  process.exit(2)
}

/** A home of its own, so the developer's `qialike.json` and engines directory are never read. */
const home = mkdtempSync(join(tmpdir(), 'qialike-office-engine-'))
process.env.DSH_HOME = home

// Seeded with another product's keys, so a write by this row is shown not to disturb them — the same
// property the edit-follow probe pins, asserted here because both rows write the same document.
const SEEDED = { theme: { colorscheme: 'dracula' }, sidebar_mode: 'on' }
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'qialike.json'), `${JSON.stringify(SEEDED, null, 2)}\n`)

const appBoot = await import(
  pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
)
const profileBoot = await import(
  pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href
)

const profileDir = join(home, 'profiles', 'qialike-desktop')
appBoot.initProfile(profileDir, [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qialike/qialike-desktop-app',
])
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)

// Run with the profile's warnings visible rather than swallowed: the activation outcome is read from
// stderr, and a probe that hid it would be unable to see the failure it exists to catch.
const running = await profileBoot.runProfile({
  environment: appBoot.loadLayeredEnv('dsh'),
  profile: 'qialike-desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
})

const ctx = running.ctx

/** The authenticated origin and cookie the shell itself redeems. */
async function authenticated() {
  const origin = `http://127.0.0.1:${String(ctx.get('webServer').port)}`
  // `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5: the
  // `webserver/entry-url` event and the package that published it were deleted, and
  // `packages/bundle/web-app` announces with this method itself. Calling it here keeps
  // the probe on its own call path rather than importing the code under test.
  const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const raw = handshake.headers.get('set-cookie') ?? ''
  return { origin, cookie: raw.slice(0, raw.indexOf(';')) }
}

const { origin, cookie } = await authenticated()

/** Call the engine route. */
async function call(method, body) {
  const response = await fetch(`${origin}/api/qialike/office-engine`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { unparsable: text.slice(0, 200) }
  }
  return { status: response.status, body: parsed }
}

// Every activated Loader row, so a row that mounted but registered nothing is distinguishable from
// one that never mounted — the `did not activate` failure produces one stderr line and is otherwise
// invisible.
const rows = [...ctx.loader.entries()]
  .map((entry) => entry.options?.id)
  .filter((id) => typeof id === 'string')

const initial = await call('GET')

// The served document is where a client bundle either is or is not. A package that declares
// `dsh.client` but is reached by no mounted row is discovered by nothing, so the Settings row would
// not exist however correct the bundle is — this is the half of "the row is there" a host can see.
const served = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
const clientIds = [...served.matchAll(/"id"\s*:\s*"([^"]+)"/gu)].map((match) => match[1])

// The engine must not be resolvable in this process before anything installs it, or the status this
// probe reads would be reporting a bundled engine instead of the state the row is meant to describe.
const resolvableBefore = (() => {
  try {
    return import.meta.resolve(`${initial.body.packageName}/package.json`)
  } catch {
    return null
  }
})()

// A second GET, because a status that changes between reads is a status the interface cannot rely on.
const second = await call('GET')

const unknownOp = await call('POST', { op: 'setEverything' })
const badBody = await fetch(`${origin}/api/qialike/office-engine`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: 'not json at all',
})
const badBodyText = await badBody.text()

// The document must be untouched: this row writes only under `engines/`, and a write to
// `qialike.json` here would be a bug the CLI's users would feel.
let configAfter
try {
  configAfter = JSON.parse(readFileSync(join(home, 'qialike.json'), 'utf8'))
} catch (error) {
  configAfter = { unreadable: String(error) }
}

await running.shutdown.shutdown(0)

process.stdout.write(`__REPORT__${JSON.stringify({
  // `rowListed` rather than "activated": the Loader lists an entry that FAILED to import too, so
  // mere presence proves nothing. What proves the row works is the route answering, which is
  // `initial.status` below — and the failure it guards prints one stderr line and nothing else.
  activation: { rowListed: rows.includes('qialike-office-engine'), rowCount: rows.length },
  clientIds,
  initial,
  second,
  stable: JSON.stringify(initial.body) === JSON.stringify(second.body),
  resolvableBefore,
  unknownOp,
  badBody: { status: badBody.status, body: badBodyText.slice(0, 200) },
  seeded: SEEDED,
  configAfter,
  home,
}, null, 2)}\n`)

rmSync(home, { recursive: true, force: true })
process.exit(0)
