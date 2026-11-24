/**
 * The edit-follow row's route, against the composed profile and a seeded home.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE ROW. The row imports
 * `@deepseek-ai/dsh-home-paths`, which resolves in the assembled runtime tree and not in
 * this repository's `node_modules` — so the module cannot be imported here at all. It is
 * booted instead, which is also the stronger test: the route runs under the real resolver,
 * the real connection and the real home, so a row that failed to activate (the
 * `warning: 1 entry did not activate` failure that shipped M5's read guard inert) is caught
 * rather than assumed.
 *
 * The probe seeds a throwaway `DSH_HOME`, writes a `qialike.json` that already holds other
 * products' keys, and then exercises the route: read the default, store a change, read it
 * back, and confirm nothing else in the document moved. That last part is what the unit
 * tests can only model — they never touch a home the CLI also writes.
 *
 * WHAT IS NOT COVERED HERE: whether the switch moves anything in a window. That is the
 * browser half — covered by `tests/edit-follow-client.test.mjs` up to the registry boundary,
 * and beyond it only by a real desktop.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'edit-follow-probe.mjs')
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
        reject(new Error(`the edit-follow probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

const timeout = 120_000

describe.skipIf(!assembled)('the edit-follow row', () => {
  it('activates, so no row silently failed to resolve', async () => {
    // The failure this guards is one line on stderr — `warning: 1 entry did not
    // activate` — while the profile boots, serves and renders normally.
    const { report, stderr } = await probe()
    expect(stderr).not.toMatch(/did not activate/u)
    expect(report.activation.editFollowRow).toBe(true)
  }, timeout)

  it('puts the client bundle in the document the browser is served', async () => {
    // A package that declares `dsh.client` but is reached by no mounted row is discovered
    // by nothing, so the switch would not exist however correct the bundle is. This is the
    // half of "the row is there" a host probe can see.
    const { report } = await probe()
    expect(report.clientIds).toContain('@qialike/qialike-desktop-edit-follow')
  }, timeout)
})

describe.skipIf(!assembled)('the switch over the real route', () => {
  it('serves the default when the document says nothing', async () => {
    const { report } = await probe()
    expect(report.initial.status).toBe(200)
    expect(report.initial.ok).toBe(true)
    expect(report.initial.enabled).toBe(true)
    expect(report.initial.default).toBe(true)
  }, timeout)

  it('stores a change and reads it back', async () => {
    const { report } = await probe()
    expect(report.afterWrite.ok).toBe(true)
    expect(report.afterWrite.status).toBe(200)
    expect(report.reRead).toBe(false)
  }, timeout)

  it('leaves the other products’ keys in the document alone', async () => {
    // The seeded document holds a `theme` section and a key this row knows nothing about. A
    // write that replaced the document would drop the user's colourscheme — the one failure
    // the unit tests can only model, never observe.
    const { report } = await probe()
    expect(report.document.theme).toEqual({ colorscheme: 'dracula', colors: { primary: '#ff8800' } })
    expect(report.document.sidebar_mode).toBe('on')
    expect(report.document.desktop_edit_follow).toEqual({ enabled: false })
  }, timeout)

  it('refuses a mutation it does not understand, without writing', async () => {
    const { report } = await probe()
    expect(report.unknownOp.ok).toBe(false)
    expect(report.unknownOp.message).toContain('setFollowEverything')
    expect(report.documentAfterUnknownOp.desktop_edit_follow).toEqual({ enabled: false })
  }, timeout)

  it('refuses a non-boolean, so a typo cannot disable the feature', async () => {
    const { report } = await probe()
    expect(report.badType.ok).toBe(false)
    expect(report.badType.message).toContain('boolean')
    expect(report.documentAfterBadType.desktop_edit_follow).toEqual({ enabled: false })
  }, timeout)
})
