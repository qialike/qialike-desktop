/**
 * What the shell does when the Host dies on its own (M8: crash reporting).
 *
 * THE BUG THIS CLOSES WAS SILENCE, WHICH IS WHY THE TESTS ARE ABOUT ABSENCE AS MUCH
 * AS PRESENCE. After readiness, `waitForReady` detaches every listener, and the only
 * thing watching the child afterwards was `stopHost` — which runs when the shell
 * *asked* for a stop. So a Host that died mid-session was observed by nothing: the
 * window kept rendering over a backend that was gone, every request failed, and the
 * child's own stderr — the only thing that could explain why — had already been
 * discarded with the process.
 *
 * TWO WAYS TO GET THIS WRONG, AND THEY PULL IN OPPOSITE DIRECTIONS:
 *
 *   · Report a crash on every quit. `stop()` is called on quit, on update and on
 *     every relaunch, so a handler that keys off "the child exited" fires constantly
 *     and trains the user to dismiss the dialog. The `expected` flag is the whole
 *     defence, and it is asserted here rather than assumed.
 *   · Never report one, which is the bug.
 *
 * A third, quieter one: the handler itself failing. It runs when the application is
 * already broken, so a full disk or a read-only home must cost the *file* and nothing
 * else — turning one failure into two, in front of a user who is already looking at a
 * dead window.
 *
 * Everything here is pure Node. `summariseHostExit` and `writeCrashReport` take their
 * facts as arguments precisely so this suite needs no Electron, no spawned Host and no
 * real crash; the wiring in `main.ts` is what a boot would add, and it is verified by
 * the packaged-app probe instead.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const LIB = join(ROOT, 'apps', 'desktop', 'lib')
const compiled = existsSync(join(LIB, 'host-crash.js'))
const { summariseHostExit, formatCrashReport, crashReportPath, writeCrashReport } = compiled
  ? await import(join(LIB, 'host-crash.js'))
  : {}

/** A scratch user-data directory, removed by the caller. */
const scratch = () => mkdtempSync(join(tmpdir(), 'qialike-crash-'))

/** The facts a report needs, with the boring parts filled in. */
const facts = (overrides = {}) => ({
  product: 'Qialike',
  version: '0.1.0',
  code: 1,
  signal: null,
  when: new Date('2026-09-30T02:00:00.000Z'),
  url: 'http://127.0.0.1:41234',
  profile: '/home/someone/.local/share/qialike/profiles/qialike-desktop',
  stderr: 'line one\nline two\n',
  ...overrides,
})

describe.skipIf(!compiled)('summarising the exit', () => {
  it('names the signal before the code, because the signal is the more specific fact', () => {
    expect(summariseHostExit({ code: null, signal: 'SIGSEGV' }))
      .toBe('the Host was killed by SIGSEGV')
    // A signal and a code can both be present; the signal is what killed it.
    expect(summariseHostExit({ code: 139, signal: 'SIGSEGV' }))
      .toBe('the Host was killed by SIGSEGV')
  })

  it('does not call a clean exit a crash, because it is a different bug', () => {
    // A Host that exits 0 on its own has not crashed — something told it to stop, or
    // it decided to. Reporting that as a crash sends the reader looking in the wrong
    // place, so the wording says what happened instead of guessing.
    expect(summariseHostExit({ code: 0, signal: null }))
      .toBe('the Host exited on its own with status 0 (it did not report a failure)')
    expect(summariseHostExit({ code: 7, signal: null })).toBe('the Host exited with status 7')
    // Neither fact: still not a crash, and saying "status null" would be worse.
    expect(summariseHostExit({ code: null, signal: null })).toBe('the Host exited with status null')
  })
})

describe.skipIf(!compiled)('the report', () => {
  it('leads with the facts that identify it, so two crashes can be compared', () => {
    const text = formatCrashReport(facts())
    const lines = text.split('\n')
    expect(lines[0]).toBe('Qialike — the Host stopped unexpectedly')
    // Each of these is what someone needs to answer "is this the same crash as last
    // week" without reading further.
    expect(text).toContain('time:     2026-09-30T02:00:00.000Z')
    expect(text).toContain('version:  0.1.0')
    expect(text).toContain('summary:  the Host exited with status 1')
    expect(text).toContain('exit:     code=1 signal=null')
    expect(text).toContain('url:      http://127.0.0.1:41234')
    expect(text).toContain(`profile:  ${facts().profile}`)
  })

  it('carries the Host’s output verbatim, because a summary of a stack trace is not one', () => {
    const stderr = 'TypeError: x is not a function\n    at /runtime/lib/a.js:1:2\n'
    const text = formatCrashReport(facts({ stderr }))
    expect(text).toContain('--- Host stderr ---')
    expect(text).toContain('    at /runtime/lib/a.js:1:2')
    // And says why the file exists, so it is not mistaken for a log someone enabled.
    expect(text).toContain('without being asked to')
  })

  it('is newline-terminated, so appending to it later cannot merge two entries', () => {
    expect(formatCrashReport(facts()).endsWith('\n')).toBe(true)
  })

  it('names the file so the directory lists chronologically', () => {
    const path = crashReportPath('/data', new Date('2026-09-30T02:03:04.005Z'))
    // Colons and dots are not portable in filenames; the ordering survives their
    // replacement because the fields stay in place. `join` for the directory part,
    // since the separator is the host's business and not what is under test here.
    expect(path).toBe(join('/data', 'crashes', 'host-2026-09-30T02-03-04-005Z.txt'))
    const earlier = crashReportPath('/data', new Date('2026-09-30T02:03:04.004Z'))
    expect(earlier < path).toBe(true)
  })
})

describe.skipIf(!compiled)('writing it', () => {
  it('creates the directory and writes a private file', () => {
    const dir = scratch()
    try {
      const path = writeCrashReport({ ...facts(), userDataDir: dir })
      expect(path).toBe(join(dir, 'crashes', 'host-2026-09-30T02-00-00-000Z.txt'))
      expect(readFileSync(path, 'utf8')).toContain('the Host exited with status 1')
      // 0600: a crash report carries paths and whatever the Host printed, which can
      // include a URL with a token in it. Nobody else on the machine needs it.
      //
      // On Windows there is no mode to assert: `chmod` only toggles the read-only
      // attribute, and readability is decided by the inherited ACL. The report is
      // written under Electron's `userData`, inside the user's own profile, so it is
      // owner-only by that inheritance rather than by a bit this code sets — asserting
      // 0o600 there would assert the host rather than the property. What is still worth
      // checking on Windows is that the private-file write left the report readable to
      // its owner, which the assertion above has already done.
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the tail of a long log rather than the head', () => {
    // The lines that explain a death are the ones next to it. A Host that has been
    // running for hours has a stderr far longer than anyone will read, and keeping
    // its beginning would keep the startup banner and discard the stack trace.
    const dir = scratch()
    try {
      const stderr = Array.from({ length: 500 }, (_, index) => `line ${String(index)}`).join('\n')
      const path = writeCrashReport({ ...facts(), userDataDir: dir, stderr, stderrTailLines: 5 })
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('line 499')
      expect(text).not.toContain('line 494')
      expect(text).not.toContain('line 0\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined instead of throwing when it cannot write', () => {
    // THE FAILURE MODE THAT MATTERS. This runs while the application is already
    // broken; throwing here turns one failure into two, in front of a user looking at
    // a dead window. A path that cannot be a directory is the cheapest way to force
    // the error without mocking the filesystem.
    const dir = scratch()
    try {
      const file = join(dir, 'not-a-directory')
      writeFileSync(file, 'this is a file, not a directory')
      expect(writeCrashReport({ ...facts(), userDataDir: file })).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes one file per crash, never overwriting an earlier one', () => {
    // Two crashes in the same session is exactly the case where the first report is
    // the interesting one: the second may be a consequence of the first.
    const dir = scratch()
    try {
      writeCrashReport({ ...facts(), userDataDir: dir, when: new Date('2026-09-30T02:00:00.000Z') })
      writeCrashReport({ ...facts(), userDataDir: dir, when: new Date('2026-09-30T02:00:01.000Z') })
      expect(readdirSync(join(dir, 'crashes'))).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
