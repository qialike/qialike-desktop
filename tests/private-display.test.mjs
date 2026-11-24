/**
 * The private display: the part that can be wrong, and the fallback that must not be silent.
 *
 * WHY THIS IS TESTED AT ALL. The module exists to stop probes opening windows on whoever ran them, and its
 * failure mode is the original behaviour coming back quietly: if `Xephyr` is missing, or the display does not
 * come up, the probe runs on the inherited display and the person sees a window with no way to know a test
 * put it there. So the fallback says so, and the number-picking is checked because two runs at once must not
 * land on the same display.
 */

import { describe, expect, it } from 'vitest'
import { pickDisplayNumber, startPrivateDisplay } from '../apps/desktop-bin/lib/private-display.mjs'
import { spawnSync } from 'node:child_process'

const hasXephyr = spawnSync('Xephyr', ['-help'], { stdio: 'ignore' }).error === undefined

describe('pickDisplayNumber', () => {
  it('avoids the numbers already in use', () => {
    expect(pickDisplayNumber({ taken: new Set([90, 91, 92]) })).toBe(93)
  })

  it('works from an empty set', () => {
    expect(pickDisplayNumber({ taken: new Set() })).toBe(90)
  })

  it('refuses rather than guessing when the range is full', () => {
    // It must not wrap around or pick 0: a display number that belongs to something else would make the
    // application render into a stranger's session, which is worse than not starting.
    const all = new Set(Array.from({ length: 200 }, (_, index) => index))
    expect(() => pickDisplayNumber({ taken: all })).toThrow(/no free X display/u)
  })

  it('starts above the numbers a desktop normally uses', () => {
    // `:0` and `:1` are where real X sessions live; a probe must never take one.
    expect(pickDisplayNumber({ taken: new Set() })).toBeGreaterThan(1)
  })

  it('skips a number a live server answers on, even when no socket says so', () => {
    // The socket directory is not authoritative, and this is the failure that motivated asking instead:
    // a leaked server from a run that was killed before its `finally` answers on a number whose socket the
    // chosen directory cannot see -- a sandbox with a private `/tmp` shows nothing at all. Picking it means
    // reporting a private display while rendering into someone else's, so the number has to be asked about.
    const busy = new Set([90, 91])
    expect(pickDisplayNumber({ taken: new Set(), occupies: (n) => busy.has(n) })).toBe(92)
  })

  it('refuses when every number is answered for, not only when every socket is present', () => {
    expect(() => pickDisplayNumber({ taken: new Set(), occupies: () => true })).toThrow(/no free X display/u)
  })
})

describe('startPrivateDisplay', () => {
  it.runIf(hasXephyr)('brings up a display that answers, and releases it on stop', () => {
    const display = startPrivateDisplay({ timeoutMs: 15_000 })
    try {
      expect(display.private, 'a display was reported as private but is not isolated').toBe(true)
      expect(display.display).toMatch(/^:\d+$/u)
      expect(spawnSync('xdpyinfo', ['-display', String(display.display)], { stdio: 'ignore' }).status).toBe(0)
    } finally {
      display.stop()
    }
    // Released BY THE TIME stop() RETURNS, with no grace period -- that is the contract callers need, since
    // they release from a `finally` and the process then exits.
    //
    // HONESTLY: THIS ASSERTION DOES NOT PROVE THE CONFIRMATION LOOP IN `stop` IS NEEDED. Reverting `stop` to
    // a bare SIGTERM still passes it here, because Xephyr exits faster than the `xdpyinfo` below takes to
    // spawn. The loop guards a server that *ignores* SIGTERM, which has not been reproduced on this machine,
    // so it is written as a belt-and-braces guard rather than as something this test has shown to matter.
    // The earlier version polled for five seconds, which was weaker still.
    expect(
      spawnSync('xdpyinfo', ['-display', String(display.display)], { stdio: 'ignore' }).status,
      'the display was still answering when stop() returned',
    ).not.toBe(0)
  })

  it.runIf(hasXephyr)('says so when it falls back, rather than opening a window silently', () => {
    // Forced by asking for a display number that cannot come up: the module must report the fallback and
    // return the inherited display, which is exactly what the caller needs to know about.
    const said = []
    const display = startPrivateDisplay({ timeoutMs: 1, log: (line) => said.push(line) })
    display.stop()
    // Either it came up inside 1ms (unlikely but possible) or it reported the fallback. Both are fine; what
    // must never happen is falling back with no message.
    if (!display.private) {
      expect(said.join('\n')).toMatch(/inherited display/u)
    }
  })

  it('is safe to stop twice', () => {
    const display = startPrivateDisplay({ timeoutMs: 15_000 })
    display.stop()
    expect(() => display.stop()).not.toThrow()
  })
})
