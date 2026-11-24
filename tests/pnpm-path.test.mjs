/**
 * Making the pinned pnpm the one a child process finds.
 *
 * The failure this guards is specific and was observed: electron-builder shells out
 * to a bare `pnpm` to collect production dependencies, so a global pnpm that disagrees
 * with `packageManager` refuses with `ERR_PNPM_BAD_PM_VERSION` and the packaging run
 * dies after it has already staged the application. The pin is only meaningful if the
 * tools the build drives also honour it.
 *
 * These tests use injected environments rather than the ambient one, so they describe
 * the rule on every host and do not depend on what happens to be installed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pinnedPnpmEntry, pinnedPnpmVersion, shouldShimPnpm, writePnpmShim } from '../apps/desktop-bin/lib/pnpm-path.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

describe('pinnedPnpmVersion', () => {
  it('reads the version out of packageManager', () => {
    // Read from the real manifest, because a wrong answer here would silently disable
    // the shim rather than fail loudly.
    expect(pinnedPnpmVersion(ROOT)).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('returns undefined for a root that pins nothing or pins another manager', () => {
    expect(pinnedPnpmVersion('/nonexistent-root')).toBeUndefined()
  })
})

describe('pinnedPnpmEntry', () => {
  it('prefers the pnpm already running the build, when its version is the pinned one', () => {
    const version = pinnedPnpmVersion(ROOT)
    // The invoking entry point exists on disk in this repository, so it is usable.
    const running = join(ROOT, 'package.json')
    const entry = pinnedPnpmEntry({
      root: ROOT,
      env: { npm_execpath: running, npm_config_user_agent: `pnpm/${version} npm/? node/v24 win32 x64` },
    })
    expect(entry).toBe(running)
  })

  it('does not accept an invoking pnpm whose version disagrees with the pin', () => {
    // The whole point: a mismatch is what produces ERR_PNPM_BAD_PM_VERSION, so handing
    // it on unchanged would reproduce the failure this exists to prevent.
    const entry = pinnedPnpmEntry({
      root: ROOT,
      env: { npm_execpath: join(ROOT, 'package.json'), npm_config_user_agent: 'pnpm/12.2.0 npm/? node/v24 win32 x64' },
    })
    expect(entry).toBeUndefined()
  })

  it('falls back to the Corepack cache for the pinned version', () => {
    const version = pinnedPnpmVersion(ROOT)
    const home = mkdtempSync(join(tmpdir(), 'qialike-corepack-'))
    try {
      const cached = join(home, 'v1', 'pnpm', version, 'bin')
      // Written rather than assumed, so the case is exercised on any machine.
      mkdirSync(cached, { recursive: true })
      writeFileSync(join(cached, 'pnpm.mjs'), '')
      expect(pinnedPnpmEntry({ root: ROOT, env: { COREPACK_HOME: home } })).toBe(join(cached, 'pnpm.mjs'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('fetches nothing: an empty environment yields no entry rather than a download', () => {
    // A missing entry point must leave PATH alone. The alternative — installing a pnpm
    // mid-package — would make a packaging run depend on the network.
    expect(pinnedPnpmEntry({ root: ROOT, env: {} })).toBeUndefined()
  })
})

describe('writePnpmShim', () => {
  let dir

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  it('writes both spellings, each pointing at the pinned entry point', () => {
    dir = mkdtempSync(join(tmpdir(), 'qialike-shim-'))
    const target = join(dir, 'shim')
    const entry = join(ROOT, 'package.json')
    writePnpmShim({ dir: target, entry })

    // Both, because the child may look for either and the platform decides which one
    // it finds first — Windows resolves `pnpm.cmd`, POSIX executes `pnpm`.
    const posix = join(target, 'pnpm')
    const windows = join(target, 'pnpm.cmd')
    expect(existsSync(posix)).toBe(true)
    expect(existsSync(windows)).toBe(true)
    expect(readFileSync(posix, 'utf8')).toContain(entry)
    expect(readFileSync(windows, 'utf8')).toContain(entry)
  })

  it('rebuilds from scratch, so a shim cannot outlive its entry point', () => {
    dir = mkdtempSync(join(tmpdir(), 'qialike-shim-'))
    const target = join(dir, 'shim')
    writePnpmShim({ dir: target, entry: '/first/pnpm.mjs' })
    writePnpmShim({ dir: target, entry: '/second/pnpm.mjs' })
    // A stale shim is worse than none: it resolves `pnpm` to a path that is gone, and
    // the child fails with ENOENT rather than with the version mismatch it should report.
    expect(readFileSync(join(target, 'pnpm'), 'utf8')).toContain('/second/pnpm.mjs')
    expect(readFileSync(join(target, 'pnpm'), 'utf8')).not.toContain('/first/pnpm.mjs')
  })

  it('reports whether a shim is worth writing', () => {
    expect(shouldShimPnpm(undefined)).toBe(false)
    expect(shouldShimPnpm('')).toBe(false)
    expect(shouldShimPnpm('/some/pnpm.mjs')).toBe(true)
  })
})
