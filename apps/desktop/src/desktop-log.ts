/**
 * The desktop shell's own log file.
 *
 * WHY THE SHELL NEEDS ONE. Everything the shell and the Host print goes to stdout and stderr, and that was
 * enough while the application was only ever run from a terminal. Launched from the desktop it is not
 * enough: stdout and stderr go to the systemd journal, which a user cannot reasonably be asked to read, and
 * the one dialog that matters — the startup failure — was pointing at "the Host log above this message",
 * i.e. at its own text, while the actual diagnosis sat in the journal.
 *
 * So the shell now writes the same lines to a file beside the Host's own log, where someone can open it.
 *
 * WHY BESIDE `qialike.log` RATHER THAN INSIDE THE APPLICATION'S USER-DATA DIRECTORY. `$DSH_HOME` is the one
 * directory a user of this product already knows, because the CLI keeps its log there too:
 *
 *     ~/.dsh/qialike.log              the Host (and the CLI), rotated to `.1` at 1 MiB
 *     ~/.dsh/qialike-desktop.log      this shell
 *
 * Two products, two logs, one directory. The user-data directory would work, but its name is
 * `@qialike/desktop` — an artefact of the package name, and not somewhere anyone would look.
 *
 * The rotation policy is copied from the Host's deliberately: same threshold, same `.1` suffix, same
 * "rename the old one out of the way" behaviour. Two files in one directory should not age differently.
 *
 * @module @qialike/desktop/desktop-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The log's file name inside `$DSH_HOME`, beside the Host's. */
export const DESKTOP_LOG_NAME = 'qialike-desktop.log'

/** The rotation threshold, matching the Host's own (`MAX_BYTES` in `@qialike/qialike-app`). */
export const DESKTOP_LOG_MAX_BYTES = 1 << 20

/**
 * Where the desktop log lives.
 *
 * @param home - `$DSH_HOME`, as the shell resolved it.
 * @returns the absolute path.
 */
export function desktopLogPath(home: string): string {
  return join(home, DESKTOP_LOG_NAME)
}

/**
 * Append one entry to the desktop log, rotating first if the file has grown past the threshold.
 *
 * NEVER THROWS. This runs on paths that are already reporting a failure, and a log that cannot be written
 * must not become a second failure — least of all inside the handler for the first one. Callers get a
 * boolean and may ignore it.
 *
 * @param path - the log's absolute path.
 * @param text - the entry. A timestamp is prepended; the caller does not supply one.
 * @returns whether the entry was written.
 */
export function appendDesktopLog(path: string, text: string): boolean {
  const entry = `[${new Date().toISOString()}] ${text.trimEnd()}\n`
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      if (statSync(path).size > DESKTOP_LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // No file yet, or it cannot be stat-ed. Appending below will report a real problem by failing.
    }
    appendFileSync(path, entry, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
