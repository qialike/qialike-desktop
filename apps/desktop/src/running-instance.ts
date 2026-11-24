/**
 * Naming the instance that already holds this application's single-instance lock.
 *
 * WHY THIS EXISTS. A launch that the lock refuses does not fail loudly. Electron's
 * `requestSingleInstanceLock()` returns false, the shell hands its intent to the
 * running instance and calls `app.quit()` — all of it *before* the per-launch log line
 * is written, because that line lives in `whenReady`. So from the outside, a launch the
 * lock refused is indistinguishable from a click that did nothing at all: no window, no
 * error, not even a log entry to read afterwards.
 *
 * That is how a user comes to report "the new build will not start" while an instance
 * started thirteen hours earlier is still running and still holding the lock. The
 * absence of any trace is the whole problem, so this module exists to produce one.
 *
 * WHAT IT READS. Electron keeps the lock as a symlink at `userData/SingletonLock`
 * whose target is `<hostname>-<pid>`. The `userData` that matters is **Electron's own**
 * — `app.getPath('userData')` — which is *not* always the same directory as this
 * application's `paths.userData`: `QIALIKE_DESKTOP_USER_DATA_DIR` moves the latter and
 * leaves the former alone. Reading the wrong one does not fail loudly, it produces the
 * confident wrong answer ("names no holder") while a named holder sits in the other
 * directory, so the caller passes Electron's.
 *
 * Both halves of the target earn their place in the sentence: the pid is what the user
 * has to stop, and the hostname is what says whether that pid is even meaningful here —
 * a lock left by a session on another machine names a pid that may belong to something
 * unrelated on this one, so its target is reported as a string rather than trusted as a
 * process.
 *
 * @module @qialike/desktop/running-instance
 */

import { readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Electron's lock file, relative to `userData`. */
export const SINGLETON_LOCK_FILE = 'SingletonLock'

/** The instance a lock target names. */
export interface LockHolder {
  /** The process id the lock names. Meaningful only on {@link host}. */
  readonly pid: number
  /** The machine that wrote the lock. */
  readonly host: string
}

/**
 * Parse Electron's `<hostname>-<pid>` lock target.
 *
 * The split is on the **last** hyphen, so a hostname that contains one still parses:
 * `my-host-1234` is host `my-host`, pid `1234`. A target with no hyphen, or with a tail
 * that is not a positive integer, is not a lock this application wrote — reported as
 * `undefined` rather than guessed at.
 *
 * @param target - the symlink's target, as read.
 * @returns the holder, or `undefined` when the target is not in that form.
 */
export function parseLockTarget(target: string): LockHolder | undefined {
  const cut = target.lastIndexOf('-')
  if (cut <= 0) return undefined
  const host = target.slice(0, cut)
  const digits = target.slice(cut + 1)
  if (!/^[1-9][0-9]*$/u.test(digits)) return undefined
  return { pid: Number(digits), host }
}

/**
 * Describe the instance holding this application's lock, for a log line.
 *
 * NEVER THROWS, and never returns an empty string: it runs on the way out of a launch
 * that is already doing something confusing, and a diagnostic that itself fails would
 * leave the user with nothing again. Every branch states whether a holder could be
 * named, and the named branch ends with the thing to do about it.
 *
 * @param userData - the directory Electron writes `SingletonLock` in.
 * @returns one sentence, suitable to append to `qialike desktop: `.
 */
export function describeRunningInstance(userData: string): string {
  const path = join(userData, SINGLETON_LOCK_FILE)
  let target: string
  try {
    target = readlinkSync(path)
  } catch {
    // Held, but nothing readable names the holder. Worth saying exactly that: the
    // alternative is a reader concluding there is no other instance at all.
    return `another instance holds this application's single-instance lock, but ${path} names no holder`
  }

  const holder = parseLockTarget(target)
  if (holder === undefined) {
    return `another instance holds this application's single-instance lock (${path} → ${JSON.stringify(target)}, which is not a <host>-<pid> target)`
  }

  const elsewhere = ` on ${holder.host}`
  return `another instance is already running (pid ${String(holder.pid)}${elsewhere}) and holds this application's single-instance lock; quit that window, or stop it with \`kill ${String(holder.pid)}\``
}
