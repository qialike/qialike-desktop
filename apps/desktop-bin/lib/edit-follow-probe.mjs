/**
 * The edit-follow route and the row's activation, against the composed profile.
 *
 * WHAT ONLY A BOOTED PROFILE CAN SHOW, and why this exists next to the unit tests. The row
 * imports `@deepseek-ai/dsh-home-paths`, which resolves in the assembled runtime tree and
 * not in this repository's `node_modules`, so the module is unreachable from a unit test.
 * Booting it also answers two questions the unit tests cannot: whether the row *activates*
 * (a row naming a package the bundle does not depend on is dropped with one line of stderr,
 * `warning: 1 entry did not activate`, and the profile then boots and serves normally), and
 * whether its client bundle reached the document the browser is served (a package declaring
 * `dsh.client` that no mounted row reaches is discovered by nothing).
 *
 * THE SEEDED HOME IS WHAT MAKES THE WRITE ASSERTIONS MEANINGFUL. `qialike.json` is shared
 * with the CLI and the two sibling rows, so it is seeded with a `theme` section and a key
 * this row knows nothing about. A write that replaced the document would drop the user's
 * colourscheme, and that is the failure the unit tests can only model — they never touch a
 * home another product also writes.
 *
 * Usage: `node edit-follow-probe.mjs <absolute runtimeDir>`; prints `__REPORT__{json}`.
 *
 * @module qialike-desktop/edit-follow-probe
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: edit-follow-probe.mjs <runtimeDir>\n')
  process.exit(2)
}
// A relative runtimeDir silently resolves the install anchor against the wrong directory,
// so it is refused at the door rather than producing a profile that mounts nothing.
if (!isAbsolute(runtimeDir)) {
  process.stderr.write(`edit-follow-probe: runtimeDir must be absolute, got ${JSON.stringify(runtimeDir)}\n`)
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'qialike-edit-follow-'))
process.env.DSH_HOME = home

/**
 * A document another product already owns.
 *
 * `theme` is the CLI's own section (the real `qialike.json` carries it plus `colors`), and
 * `sidebar_mode` is one of its top-level keys. Both must survive a write by this row.
 */
const SEEDED = {
  theme: { colorscheme: 'dracula', colors: { primary: '#ff8800' } },
  sidebar_mode: 'on',
}
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

// The Loader's activation outcome is collected from stderr, so the probe has to run with the
// profile's warnings visible rather than swallowed.
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

/** Call the edit-follow route. */
async function call(method, body) {
  const response = await fetch(`${origin}/api/qialike/edit-follow`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, payload: await response.json().catch(() => undefined) }
}

/** The document as it is on disk. */
const document = () => JSON.parse(readFileSync(join(home, 'qialike.json'), 'utf8'))

const initial = await call('GET')

// Every activated Loader row, so a row that mounted but registered nothing is
// distinguishable from one that never mounted.
const rows = [...ctx.loader.entries()]
  .map((entry) => entry.options?.id)
  .filter((id) => typeof id === 'string')

// The client bundle's presence in what the browser is served.
const served = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
const clientIds = [...served.matchAll(/"id"\s*:\s*"([^"]+)"/gu)].map((match) => match[1])

const write = await call('POST', { op: 'setEnabled', enabled: false })
const afterWrite = document()
const reRead = await call('GET')
const unknownOp = await call('POST', { op: 'setFollowEverything' })
const documentAfterUnknownOp = document()
const badType = await call('POST', { op: 'setEnabled', enabled: 'false' })
const documentAfterBadType = document()

process.stdout.write(`__REPORT__${JSON.stringify({
  initial: {
    status: initial.status,
    ok: initial.payload?.ok,
    enabled: initial.payload?.enabled,
    default: initial.payload?.default,
  },
  afterWrite: { ok: write.payload?.ok, status: write.status, enabled: write.payload?.enabled },
  reRead: reRead.payload?.enabled,
  unknownOp: { ok: unknownOp.payload?.ok, message: unknownOp.payload?.message },
  badType: { ok: badType.payload?.ok, message: badType.payload?.message },
  document: afterWrite,
  documentAfterUnknownOp,
  documentAfterBadType,
  activation: { editFollowRow: rows.includes('qialike-edit-follow'), rowCount: rows.length },
  clientIds,
})}\n`)

await running.shutdown.shutdown(0)
rmSync(home, { recursive: true, force: true })
process.exit(0)
