/**
 * The main process's crash guard, and the dialog it replaces.
 *
 * THE THING UNDER TEST IS A COUNT. Electron installs one `uncaughtException` listener whose entire body is
 * a modal dialog, guarded by `if (process.listenerCount('uncaughtException') > 1) return`. So "do not show
 * an error box" is not a flag we can set — it is achieved by being the second listener. The first assertion
 * here is therefore about the handler count, and it is the one that would fail silently if a later refactor
 * replaced `on` with something that does not register.
 *
 * The snippet that makes this true was read out of the shipped `electron.exe` 44.0.0 (`#2` below), because
 * the alternative — trusting a memory of the upstream source — is how a fix ships that does nothing.
 *
 * The rest is about the entry: it must name the failure, the runtime, and the stack; it must not drown the
 * log when the same dropped connection repeats; and it must never throw, because it runs when the process
 * is already in trouble.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyMainProcessFailure,
  formatMainProcessFailure,
  installMainProcessGuard,
} from '../apps/desktop/src/main-crash-guard.ts'

/** The real assertion, as it appears in the wild: message on the first line, undici frames below. */
const UNDICI = (() => {
  const error = new AssertionError('The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n')
  error.stack = [
    'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',
    '',
    '  assert(!this.paused)',
    '',
    '    at Parser.finish (node:internal/deps/undici/undici:7388:9)',
    '    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)',
    '    at Socket.emit (node:events:521:24)',
    '    at endReadableNT (node:internal/streams/readable:1729:12)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)',
  ].join('\n')
  return error
})()

/** Minimal stand-in for Node's AssertionError, so the fixture does not depend on `node:assert` internals. */
function AssertionError(message) {
  const error = new Error(message)
  error.name = 'AssertionError'
  error.code = 'ERR_ASSERTION'
  return error
}

let log
let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-guard-'))
  log = join(root, 'qialike-desktop.log')
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** An emitter standing in for `process`, so the real process is never touched. */
const fakeProcess = () => new EventEmitter()

const read = () => readFileSync(log, 'utf8')

describe('what Electron would do without this', () => {
  it('registers its dialog unless a second listener exists', () => {
    // The contract, quoted from the shipped binary. Kept as a test rather than a comment because the whole
    // fix depends on it: if Electron ever changes `> 1` to something else, this assertion is where a reader
    // finds out why the dialog came back.
    const shipped = String.raw`process.listenerCount("uncaughtException")>1||t.resolve().then(...).then(({dialog:t})=>{...t.showErrorBox("A JavaScript error occurred in the main process",r)})`
    expect(shipped).toMatch(/listenerCount\("uncaughtException"\)>1/u)
  })

  it('ends with exactly one more listener than a bare emitter had', () => {
    const emitter = fakeProcess()
    expect(emitter.listenerCount('uncaughtException')).toBe(0)
    const dispose = installMainProcessGuard({ logPath: log, emitter })
    expect(emitter.listenerCount('uncaughtException')).toBe(1)
    dispose()
    expect(emitter.listenerCount('uncaughtException')).toBe(0)
  })
})

describe('classifying', () => {
  it('recognises the undici assertion by its message', () => {
    expect(classifyMainProcessFailure(UNDICI)).toBe('undici-paused-parser')
  })

  it('recognises it by its frames when the message was rewritten', () => {
    const error = new Error('boom')
    error.stack = [
      'Error: boom',
      '    at Parser.finish (node:internal/deps/undici/undici:7388:9)',
      '    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)',
    ].join('\n')
    expect(classifyMainProcessFailure(error)).toBe('undici-paused-parser')
  })

  it('does not call an unrelated Parser.finish the undici bug', () => {
    const error = new Error('Parser.finish failed in my parser')
    error.stack = 'Error: nope\n    at Parser.finish (app.js:1:1)'
    expect(classifyMainProcessFailure(error)).toBe('unknown')
  })

  it('keeps rejections separate, because the reader treats them differently', () => {
    expect(classifyMainProcessFailure(new Error('x'), 'unhandledRejection')).toBe('unhandled-rejection')
  })
})

describe('formatting', () => {
  it('puts the kind on the first line so the log can be grepped for it', () => {
    const failure = formatMainProcessFailure(UNDICI)
    expect(failure.text.split('\n')[0]).toBe('main process: uncaught exception (undici-paused-parser)')
  })

  it('names the runtime, so a report is reproducible without asking which build it came from', () => {
    const failure = formatMainProcessFailure(UNDICI, {
      versions: { electron: '44.0.0', node: '24.18.1', undici: '7.29.0' },
    })
    expect(failure.text).toContain('electron 44.0.0')
    expect(failure.text).toContain('undici 7.29.0')
  })

  it('says what the failure means, because the stack cannot', () => {
    const failure = formatMainProcessFailure(UNDICI)
    expect(failure.text).toContain('drops one request and nothing else')
    expect(failure.text).toContain('nodejs/undici#5360')
  })

  it('keeps the stack, and refuses to keep all of it', () => {
    const huge = new Error('boom')
    huge.stack = ['Error: boom', ...Array.from({ length: 400 }, (_, i) => `    at frame${String(i)} (file.js:1:1)`)].join('\n')
    const failure = formatMainProcessFailure(huge, { stackLimit: 500 })
    expect(failure.text).toContain('at frame0')
    expect(failure.text).toContain('stack truncated')
    expect(failure.text.length).toBeLessThan(2000)
  })

  it('normalises a thrown string, which is legal JavaScript', () => {
    const failure = formatMainProcessFailure('a string was thrown')
    expect(failure.kind).toBe('unknown')
    expect(failure.text).toContain('a string was thrown')
  })
})

describe('installed', () => {
  it('writes one entry per failure, timestamped', () => {
    const emitter = fakeProcess()
    installMainProcessGuard({ logPath: log, emitter })
    emitter.emit('uncaughtException', UNDICI, 'uncaughtException')

    const text = read()
    expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] main process: uncaught exception/u)
    expect(text).toContain('assert(!this.paused)')
  })

  it('collapses identical repeats instead of rotating the log with them', () => {
    const emitter = fakeProcess()
    installMainProcessGuard({ logPath: log, emitter, repeatLogEvery: 5 })

    for (let i = 0; i < 4; i += 1) emitter.emit('uncaughtException', UNDICI, 'uncaughtException')
    const entriesAfterFour = read().split('main process: uncaught exception').length - 1
    expect(entriesAfterFour).toBe(1)

    emitter.emit('uncaughtException', UNDICI, 'uncaughtException')
    const entriesAfterFive = read().split('main process: uncaught exception').length - 1
    expect(entriesAfterFive).toBe(2)
    expect(read()).toContain('logged 5 times')
  })

  it('logs a different failure immediately, even when another is repeating', () => {
    const emitter = fakeProcess()
    installMainProcessGuard({ logPath: log, emitter })
    emitter.emit('uncaughtException', UNDICI, 'uncaughtException')
    emitter.emit('uncaughtException', new Error('something else'), 'uncaughtException')

    const text = read()
    expect(text).toContain('undici-paused-parser')
    expect(text).toContain('main process: uncaught exception (unknown)')
    expect(text).toContain('something else')
  })

  it('does not show a dialog for the known one, at any point in the life of the process', () => {
    const emitter = fakeProcess()
    let announced = 0
    installMainProcessGuard({
      logPath: log,
      emitter,
      announce: () => { announced += 1 },
      shouldAnnounce: () => true,
    })
    emitter.emit('uncaughtException', UNDICI, 'uncaughtException')
    expect(announced).toBe(0)
  })

  it('still shows one for an unexplained failure before the window is up', () => {
    const emitter = fakeProcess()
    const announced = []
    installMainProcessGuard({
      logPath: log,
      emitter,
      announce: (title, body) => announced.push({ title, body }),
      shouldAnnounce: () => true,
    })
    emitter.emit('uncaughtException', new Error('cannot compose the profile'), 'uncaughtException')
    expect(announced).toHaveLength(1)
    expect(announced[0].title).toContain('Qialike')
    expect(announced[0].body).toContain('cannot compose the profile')
  })

  it('says nothing after startup, and writes the log instead', () => {
    const emitter = fakeProcess()
    let announced = 0
    installMainProcessGuard({
      logPath: log,
      emitter,
      announce: () => { announced += 1 },
      shouldAnnounce: () => false,
    })
    emitter.emit('uncaughtException', new Error('mid-session'), 'uncaughtException')
    expect(announced).toBe(0)
    expect(read()).toContain('mid-session')
  })

  it('survives a log it cannot write, because that is not the failure worth dying for', () => {
    const emitter = fakeProcess()
    // A path whose parent is a file: `mkdir` fails and the append fails with it.
    const blocked = join(root, 'not-a-directory')
    writeFileSync(blocked, 'x')
    installMainProcessGuard({ logPath: join(blocked, 'qialike-desktop.log'), emitter })
    expect(() => emitter.emit('uncaughtException', UNDICI, 'uncaughtException')).not.toThrow()
  })

  it('can be installed twice without forking the dedupe state', () => {
    const emitter = fakeProcess()
    installMainProcessGuard({ logPath: log, emitter, repeatLogEvery: 3 })
    installMainProcessGuard({ logPath: log, emitter, repeatLogEvery: 3 })
    for (let i = 0; i < 3; i += 1) emitter.emit('uncaughtException', UNDICI, 'uncaughtException')
    const entries = read().split('main process: uncaught exception').length - 1
    expect(entries).toBe(2)
  })
})
