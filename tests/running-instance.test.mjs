/**
 * Naming the instance that already holds the lock.
 *
 * WHY THIS IS A TEST AND NOT A HABIT. The failure this module reports used to leave no
 * trace anywhere, so the only way to check it was to hit it by hand: leave an instance
 * running, launch a second one, and notice that nothing happened. That is not a check
 * anyone performs, and the bug it hides reads as "the new build does not start" —
 * reported against a build that was never at fault.
 *
 * WHAT IS ASSERTED. The symlink Electron actually writes, read back through the same
 * function the shell logs with. The interesting cases are the ones where the target
 * cannot be trusted: a lock left by another machine names a pid that may belong to
 * something else here, so the sentence must not present it as a process to stop.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SINGLETON_LOCK_FILE, describeRunningInstance, parseLockTarget } from '../apps/desktop/src/running-instance.ts'

const cleanups = []
function userData() {
  const dir = mkdtempSync(join(tmpdir(), 'qialike-lock-'))
  cleanups.push(dir)
  return dir
}
function withLock(target) {
  const dir = userData()
  symlinkSync(target, join(dir, SINGLETON_LOCK_FILE))
  return dir
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop(), { recursive: true, force: true })
})

describe('parseLockTarget', () => {
  it('reads the <host>-<pid> target Electron writes', () => {
    expect(parseLockTarget('GW-PIPO-3138')).toEqual({ host: 'GW-PIPO', pid: 3138 })
  })

  it('splits on the last hyphen, so a hyphenated hostname still parses', () => {
    // A hostname is not guaranteed to be hyphen-free, and splitting on the first one
    // would report the pid as part of the machine's name.
    expect(parseLockTarget('my-work-laptop-42')).toEqual({ host: 'my-work-laptop', pid: 42 })
  })

  it('refuses a target that is not one, rather than guessing', () => {
    for (const target of ['', 'no-hyphen', '-12', 'host-', 'host-0', 'host-12a']) {
      expect(parseLockTarget(target), JSON.stringify(target)).toBeUndefined()
    }
  })

  it('does not validate the hostname, and says so by reading the pid anyway', () => {
    // WHAT THIS DELIBERATELY DOES NOT DO. A hostname has rules (no trailing hyphen, and
    // so on) and this parser checks none of them, because a half-check would claim more
    // than it verifies: the target's tail is what identifies the process to stop, and it
    // is unambiguous even when the name in front of it is odd. `host--3` therefore reads
    // as pid 3 on a host called `host-`. Rejecting it would throw away a pid that is
    // correct, which is the opposite of what this module is for.
    expect(parseLockTarget('host--3')).toEqual({ host: 'host-', pid: 3 })
  })
})

describe('describeRunningInstance', () => {
  it('names the pid and the host, and says what to do about it', () => {
    const sentence = describeRunningInstance(withLock('GW-PIPO-3138'))
    expect(sentence).toContain('pid 3138')
    expect(sentence).toContain('GW-PIPO')
    // The remedy is the part a user needs; a diagnosis without one still leaves them
    // with a window that will not open.
    expect(sentence).toContain('kill 3138')
  })

  it('does not present an unparseable target as a process to stop', () => {
    // The case that must not be dressed up: a lock whose target is not <host>-<pid>
    // cannot be resolved to a pid here, and telling the user to kill one would be
    // worse than saying nothing.
    const sentence = describeRunningInstance(withLock('not-a-lock-target'))
    expect(sentence).toContain('not a <host>-<pid> target')
    expect(sentence).not.toContain('kill ')
  })

  it('says the holder could not be named when the lock cannot be read at all', () => {
    // The lock was held — that is why this is called — so a missing file must not be
    // reported as "no other instance".
    const sentence = describeRunningInstance(userData())
    expect(sentence).toContain('names no holder')
  })

  it('never returns an empty string, on any path', () => {
    // It runs while the process is on its way out of a launch that is already
    // confusing; a diagnostic that returns nothing repeats the original problem.
    const cases = [
      withLock('GW-PIPO-1'),
      withLock('broken'),
      userData(),
      join(userData(), 'does-not-exist'),
      // A regular file where a symlink is expected: readlink throws EINVAL.
      (() => {
        const dir = userData()
        writeFileSync(join(dir, SINGLETON_LOCK_FILE), 'GW-PIPO-9')
        return dir
      })(),
      // A directory: joining a lock onto a path that is not one at all.
      (() => {
        const dir = userData()
        mkdirSync(join(dir, SINGLETON_LOCK_FILE))
        return dir
      })(),
    ]
    for (const dir of cases) {
      const sentence = describeRunningInstance(dir)
      expect(typeof sentence).toBe('string')
      expect(sentence.length).toBeGreaterThan(0)
    }
  })
})
