/**
 * The update row's activation, against the composed profile.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE ROW. The client half needs `react` and the window's
 * module loader, and the host half needs a Cordis context — neither exists in this process. What is left is
 * wiring, and wiring is tested by booting it. Booting is also the stronger test here in a way that has already
 * mattered twice on this feature:
 *
 *   · A row that fails to mount prints ONE line — `warning: 1 entry did not activate`, followed by
 *     `failed to import` — and then the profile boots, serves and renders normally. This row was in exactly
 *     that state when this test was written: the host module exported a marker constant instead of the
 *     `name`/`apply` pair a Cordis plugin owes. The import succeeded, which is what made it worth a test — a
 *     module that loads is not a module the Loader accepts.
 *   · A package that declares `dsh.client` but is reached by no mounted row is discovered by nothing, so its
 *     bundle is never served and the Settings row does not exist however correct the bundle is.
 *
 * WHAT IT DOES NOT COVER. It never checks for a real update, because that reaches the network and would fail on
 * a bad connection while passing for the wrong reason on a cached one; and it cannot see whether the row
 * renders, because that needs a browser. It answers the question this suite can answer cheaply and offline:
 * is the row mounted, and is its bundle served.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { UPDATE_PACKAGE } from '../apps/desktop-bin/lib/own-packages.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'update-row-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** Boot once for every assertion below: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      // The probe seeds its own throwaway home; the developer's must not be read.
      env: { ...process.env, DSH_HOME: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the update-row probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the update row, in the composed profile', () => {
  it('mounts, with nothing failing to activate', async () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE HOST HALF. `rowListed` alone is not enough — the Loader lists
    // an entry that failed to import — so the stderr line is asserted separately, and the probe reports the
    // warnings rather than swallowing them. Note this probe only sees that line because it wraps
    // `process.stderr.write`: the harness writes it there, not through `console`, and an earlier version of
    // the probe wrapped only `console` and reported an empty list while the row was failing.
    const { report, stderr } = await probe()
    expect(report.rowListed, 'the Loader has no entry for the update row').toBe(true)
    expect(report.warnings).toEqual([])
    expect(stderr).not.toMatch(/did not activate/u)
  })

  it('serves its client bundle, so the row can exist in the browser', async () => {
    // The other half, and the one a row that mounts can still fail: nothing is discovered from a package that
    // no mounted row reaches, so the bundle is never requested and Settings shows no row at all.
    const { report } = await probe()
    expect(report.clientServed, `${UPDATE_PACKAGE} is not named in the served document`).toBe(true)
  })

  it('is mounted as the id the cordis patch names, not some other row', async () => {
    // A probe that only asked "is a row listed" would pass for a profile where ours silently never mounted and
    // something else took its place, so the id is the assertion rather than the count.
    const { report } = await probe()
    expect(report.clientIds).toContain(UPDATE_PACKAGE)
    expect(report.rowCount).toBeGreaterThan(0)
  })
})
