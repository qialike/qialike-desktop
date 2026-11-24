/**
 * The office-engine row's route and activation, against the composed profile.
 *
 * WHY A BOOTED PROFILE RATHER THAN A UNIT TEST OF THE ROW. The row imports
 * `@deepseek-ai/dsh-home-paths` and resolves `@deepseek-ai/libreoffice-kit`, and neither resolves in
 * this repository's `node_modules` — so the module cannot be imported here at all. The rules worth
 * unit testing were split into `lib/install.js` for that reason; what is left is wiring, and wiring
 * is tested by booting it. Booting is also the stronger test in one way that has already mattered
 * twice on this feature:
 *
 *   · A row that fails to resolve prints ONE line — `warning: 1 entry did not activate` — and then
 *     the profile boots, serves and renders normally. The row was in exactly that state until the
 *     app package declared the dependency edge, and nothing but this assertion would have said so.
 *   · A package that declares `dsh.client` but whose manifest lacks the `exports["./client"]`
 *     subpath is discovered by nothing, so the Settings row does not exist however correct the
 *     bundle is. That was also true until this test was written.
 *
 * WHAT IT DOES NOT COVER. It never installs anything: `plan` and `install` reach the network and
 * write 46 MiB, so a suite running them would fail on a bad network and pass for the wrong reason on
 * a cached one. Those are covered by `scripts/desktop/probes/office-preview-probe.mjs --install`,
 * which drives a real packaged application from the page context — the call the Settings button
 * makes — and then asserts the preview renders the document. This file answers the narrower
 * question the suite can answer cheaply and offline.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'office-engine-probe.mjs')
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
        reject(new Error(`the office-engine probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

const timeout = 180_000

describe.skipIf(!assembled)('the office-engine row', () => {
  it('activates, so no row silently failed to resolve', async () => {
    // The failure this guards is one line on stderr while everything else looks healthy. It has
    // already fired once on this feature, when the app package did not declare the dependency edge.
    const { stderr } = await probe()
    expect(stderr).not.toMatch(/did not activate/u)
  }, timeout)

  it('puts the client bundle in the document the browser is served', async () => {
    // Two separate ways to get this wrong, and this catches both: the package reached by no mounted
    // row is discovered by nothing, and a manifest without `exports["./client"]` cannot be resolved
    // to a file even when the row is mounted.
    const { report } = await probe()
    expect(report.clientIds).toContain('@qialike/qialike-desktop-office-engine')
  }, timeout)
})

describe.skipIf(!assembled)('the engine state over the real route', () => {
  it('serves a description that names every engine this host could use', async () => {
    // A LIST, NOT ONE NAME, and the reason is measured: the kit's preferred engine on Linux is
    // `linux-x64-glibc` and that package is unpublished (404 on both registries), so the row has to
    // offer the WebAssembly engine beside it. A single `packageName` field would force the row to
    // predict which one exists, which is what it got wrong first.
    const { report } = await probe()
    expect(report.initial.status).toBe(200)
    const body = report.initial.body
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(body.candidates.length).toBeGreaterThan(0)
    for (const candidate of body.candidates) {
      expect(candidate.packageName).toMatch(/^@deepseek-ai\/libreoffice-kit-/u)
      expect(typeof candidate.target).toBe('string')
    }
    // On Linux the last candidate is the wasm fallback; elsewhere there is no fallback at all,
    // because the kit never looks at a wasm engine off Linux.
    if (process.platform === 'linux') {
      expect(body.candidates.at(-1).target).toBe('wasm')
    }
  }, timeout)

  it('does not claim an engine is resolvable before anything installed one', async () => {
    // The state this phase exists to describe. If a build bundles the engine, this probe's home has
    // no engine and the tree does — so the assertion is about the *host's* state, which is what the
    // route reports: a bundled build says `bundled`, a pruned one says `missing`.
    const { report } = await probe()
    expect(['bundled', 'missing']).toContain(report.initial.body.mode)
    // And nothing on this host's search path before an install, in the pruned case.
    if (report.initial.body.mode === 'missing') {
      expect(report.resolvableBefore).toBeNull()
    }
  }, timeout)

  it('answers the same thing twice, so the interface can rely on it', async () => {
    const { report } = await probe()
    expect(report.stable).toBe(true)
  }, timeout)

  it('refuses an unknown op rather than guessing one', async () => {
    const { report } = await probe()
    expect(report.unknownOp.status).toBe(400)
    expect(report.unknownOp.body.message).toMatch(/unknown op/u)
  }, timeout)

  it('refuses a body that is not JSON', async () => {
    const { report } = await probe()
    expect(report.badBody.status).toBe(400)
    expect(report.badBody.body).toMatch(/valid JSON/u)
  }, timeout)

  it('leaves the shared configuration document alone', async () => {
    // `qialike.json` is the file the CLI and this application both write. This row keeps its state
    // on disk instead — the engine itself is the state — so touching that document would be a bug
    // the CLI's users would feel.
    const { report } = await probe()
    expect(report.configAfter).toEqual(report.seeded)
  }, timeout)
})
