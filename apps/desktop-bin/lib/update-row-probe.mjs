/**
 * The update row, against the composed profile.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE ROW. Whether this row exists is not a property of its
 * source. The package has to be placed in the runtime tree, mounted by a Loader entry, declared as a client
 * module by its manifest, and then actually named in the document the browser loads — four different files,
 * and a mistake in any one of them is invisible in the others. A bundle that is never served looks exactly
 * like a bundle with a bug in it.
 *
 * The two halves are reported separately because they fail independently:
 *
 *   · `rowListed` — the Loader has an entry by this id. A row that FAILED to import is listed too, which is
 *     why the warnings are captured rather than swallowed: `warning: N entry did not activate` is the only
 *     thing that says so.
 *   · `clientServed` — the served document names this client module. A package reached by no mounted row is
 *     discovered by nothing, so its bundle is never requested and the row cannot exist however correct it is.
 *
 * WHAT IT DOES NOT COVER. It never checks for a real update, because that reaches the network and would fail
 * on a bad connection while passing for the wrong reason on a cached one; and it cannot see whether the row
 * renders correctly, because that needs a browser. It answers the question the suite can answer cheaply and
 * offline: is the row mounted, and is its bundle served.
 *
 * Usage: `node update-row-probe.mjs <absolute runtimeDir>`; prints `__REPORT__{json}`.
 *
 * @module qialike-desktop/update-row-probe
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROW_ID = 'qialike-update'
const PACKAGE_NAME = '@qialike/qialike-desktop-update'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: update-row-probe.mjs <absolute runtimeDir>\n')
  process.exit(2)
}

/** A home of its own, so the developer's own profile and settings are never read. */
const home = mkdtempSync(join(tmpdir(), 'qialike-update-row-'))
process.env.DSH_HOME = home
mkdirSync(home, { recursive: true })

/**
 * Warnings the profile emitted while composing — where a failed activation appears.
 *
 * `process.stderr.write` is wrapped, and that is the part worth stating: the harness writes
 * `dsh: warning: N entry did not activate` straight to stderr, NOT through `console`. A probe that wrapped
 * only `console.warn` therefore saw an empty warning list while the row was failing to mount — the exact
 * silent-green shape this probe exists to prevent. Found by running it: `rowListed` said true, the bundle was
 * not served, and the reason was on line 1 of output the capture had discarded.
 */
const warnings = []
const remember = (line) => {
  if (/did not activate|failed to import/iu.test(line)) warnings.push(line)
}
const realWarn = console.warn
const realError = console.error
const realStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
  remember(typeof chunk === 'string' ? chunk : String(chunk))
  return realStderrWrite(chunk, ...rest)
}
const capture = (write) => (...args) => {
  remember(args.map((value) => (typeof value === 'string' ? value : String(value))).join(' '))
  write(...args)
}
console.warn = capture(realWarn)
console.error = capture(realError)

let exitCode = 1
try {
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

  const running = await profileBoot.runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: 'qialike-desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', '0'],
  })
  const ctx = running.ctx

     /**
      * The authenticated origin and cookie the shell itself redeems.
      *
      * `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5. The
      * `webserver/entry-url` event and the package that published it are gone, and
      * `packages/bundle/web-app` announces its own address with this method — so calling it
      * here is following the harness rather than falling back from it.
      *
      * The probe keeps its own call path on purpose: it observes the row independently, so it
      * must not import the code under test.
      */
     const origin = `http://127.0.0.1:${String(ctx.get('webServer').port)}`
     const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const raw = handshake.headers.get('set-cookie') ?? ''
  const cookie = raw.slice(0, raw.indexOf(';'))

  // Every activated Loader row. `rowListed` rather than "activated" for the reason in the header: this list
  // contains an entry that failed to import as well.
  const rows = [...ctx.loader.entries()]
    .map((entry) => entry.options?.id)
    .filter((id) => typeof id === 'string')

  // The served document is where a client bundle either is or is not.
  const served = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
  const clientIds = [...served.matchAll(/"id"\s*:\s*"([^"]+)"/gu)].map((match) => match[1])

  const report = {
    rowListed: rows.includes(ROW_ID),
    clientServed: clientIds.includes(PACKAGE_NAME),
    clientIds,
    rowCount: rows.length,
    warnings,
  }
  exitCode = report.rowListed && report.clientServed && warnings.length === 0 ? 0 : 1
  // THE REPORT GOES LAST, and that is a requirement rather than a style: the test parses everything after the
  // marker as JSON, so a human-readable line printed afterwards makes the parse throw — which surfaces as an
  // unhandled rejection and a test that times out, pointing at nothing. The readable lines therefore come
  // first, and a caller that wants the report takes the tail.
  process.stdout.write(`RESULT: ${exitCode === 0 ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`  rowListed    ${String(report.rowListed)}\n`)
  process.stdout.write(`  clientServed ${String(report.clientServed)}\n`)
  for (const line of warnings) process.stdout.write(`  warning      ${line.trim().slice(0, 180)}\n`)
  process.stdout.write(`__REPORT__${JSON.stringify(report, null, 2)}\n`)

  await running.stop?.()
} catch (error) {
  process.stdout.write(`\nRESULT: FAIL\n  error        ${error instanceof Error ? error.message : String(error)}\n`)
} finally {
  console.warn = realWarn
  console.error = realError
  process.stderr.write = realStderrWrite
  rmSync(home, { recursive: true, force: true })
}
process.exit(exitCode)
