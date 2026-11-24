/**
 * What the shell writes down when the Host dies on its own.
 *
 * WHY A FILE AND NOT JUST A DIALOG. A dialog is read once, by whoever happens to be
 * at the machine, and then it is gone — and the person reporting the problem is
 * usually not the person who can act on it. The Host's own last words are the only
 * evidence that explains *why* it died, and once the child is reaped they exist
 * nowhere: the shell kept them in a string that dies with the process.
 *
 * WHY IT IS FORMATTED RATHER THAN JSON-DUMPED. The reader is a human deciding what to
 * do next, and the first line has to answer "is this the same crash I saw last week"
 * without opening anything else. So the header carries the facts that identify it —
 * exit code, signal, version, time — and the Host's stderr follows verbatim, because
 * a summary of a stack trace is not a stack trace.
 *
 * THE FUNCTIONS HERE ARE PURE ON PURPOSE. Everything they need arrives as arguments,
 * so `tests/host-crash.test.mjs` can assert the report's content without Electron, a
 * spawned Host, or a real crash. The alternative — building the text inside a dialog
 * handler — is the part that cannot be tested, and it is also the part that would
 * quietly lose a field.
 *
 * @module qialike-desktop/host-crash
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How many lines of the Host's stderr a report keeps by default. */
const DEFAULT_TAIL_LINES = 60

/**
 * The one-line summary a dialog and a bug report both start from.
 *
 * A signal is reported before an exit code because a signal is the more specific
 * fact: `SIGSEGV` says the Host's own code failed, while a code alone cannot.
 * Exit code 0 with no signal is called out as such rather than described as a
 * crash, because that is what a Host exiting cleanly on its own looks like — a
 * different bug with a different cause.
 *
 * @param exit - the raw exit facts.
 * @returns one line, no trailing newline.
 */
export function summariseHostExit(exit: { code: number | null, signal: NodeJS.Signals | null }): string {
  if (exit.signal !== null) return `the Host was killed by ${exit.signal}`
  if (exit.code === 0) return 'the Host exited on its own with status 0 (it did not report a failure)'
  return `the Host exited with status ${String(exit.code)}`
}

/**
 * The full report text.
 *
 * @param facts - everything the report states.
 * @returns the file's contents, newline-terminated.
 */
export function formatCrashReport(facts: {
  product: string
  version: string
  code: number | null
  signal: NodeJS.Signals | null
  when: Date
  url: string
  profile: string
  stderr: string
}): string {
  const lines = [
    `${facts.product} — the Host stopped unexpectedly`,
    '',
    `time:     ${facts.when.toISOString()}`,
    `version:  ${facts.version}`,
    `summary:  ${summariseHostExit(facts)}`,
    `exit:     code=${String(facts.code)} signal=${String(facts.signal)}`,
    `url:      ${facts.url}`,
    `profile:  ${facts.profile}`,
    '',
    'The Host\'s own output follows, newest last. This file is written only when the',
    'Host stops without being asked to, so its presence means the window kept running',
    'after its backend was gone.',
    '',
    '--- Host stderr ---',
    facts.stderr.trimEnd(),
    '',
  ]
  return lines.join('\n')
}

/**
 * Where a report for this moment goes.
 *
 * One file per crash, named so the directory lists chronologically, and placed beside
 * the shell's other per-user state rather than in a temporary directory — the whole
 * point is that it outlives the process.
 *
 * @param userDataDir - the Electron user-data directory.
 * @param when - the crash time, which is also the file's name.
 * @returns the absolute path to write.
 */
export function crashReportPath(userDataDir: string, when: Date): string {
  const stamp = when.toISOString().replace(/[:.]/gu, '-')
  return join(userDataDir, 'crashes', `host-${stamp}.txt`)
}

/**
 * Write a report, and never take the application down doing it.
 *
 * A crash handler that throws is worse than no crash handler: it turns one failure
 * into two, and the second one happens while the user is already looking at a broken
 * window. So a disk that is full, a directory that cannot be created and a read-only
 * home all end in `undefined` — the caller reports the crash it already knows about
 * and loses only the file.
 *
 * @param facts - the report and where it goes.
 * @returns the path written, or undefined when it could not be.
 */
export function writeCrashReport(
  facts: Parameters<typeof formatCrashReport>[0] & { userDataDir: string, stderrTailLines?: number },
): string | undefined {
  const path = crashReportPath(facts.userDataDir, facts.when)
  const stderr = facts.stderr.split('\n').slice(-(facts.stderrTailLines ?? DEFAULT_TAIL_LINES)).join('\n')
  try {
    mkdirSync(join(facts.userDataDir, 'crashes'), { recursive: true })
    writeFileSync(path, formatCrashReport({ ...facts, stderr }), { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}
