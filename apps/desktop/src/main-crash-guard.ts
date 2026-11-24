/**
 * The main process's own uncaught-exception handler.
 *
 * WHY THIS FILE EXISTS. Electron installs exactly one `uncaughtException` listener, and its whole body is a
 * modal dialog:
 *
 *     function (error) {
 *       if (process.listenerCount('uncaughtException') > 1) return
 *       import('electron').then(({ dialog }) => {
 *         dialog.showErrorBox('A JavaScript error occurred in the main process',
 *           'Uncaught Exception:\n' + (error.stack ?? `${error.name}: ${error.message}`))
 *       })
 *     }
 *
 * (read out of the shipped `electron.exe` 44.0.0, not from memory — see
 * `tests/main-crash-guard.test.mjs`).
 *
 * So an application that registers **one** listener of its own makes the count 2, and Electron's handler
 * returns before it reaches `showErrorBox`. That is the documented, supported way to say "not a dialog".
 *
 * WHY A DIALOG IS THE WRONG ANSWER HERE. The exception that motivated this module is undici's
 * `assert(!this.paused)`, thrown from a socket `end` handler when a response body was abandoned mid-flight:
 * one request failed, and the pool is fine. Nothing is corrupted, nothing needs restarting, and the window
 * keeps working — but the user is handed a modal that says `AssertionError [ERR_ASSERTION]` over a stack
 * trace through `node:internal/deps/undici`, with an `OK` button and no next step. Reported twice as "what
 * is this popup", which is the correct reaction: it is a dialog about an implementation detail.
 *
 * WHY LOGGING RATHER THAN SILENCE. The failure is still real — a dropped request can surface as a dead
 * button — and the only thing that makes it diagnosable later is the text. `qialike-desktop.log` already
 * exists, already rotates, and is already what the startup-failure dialog names; this writes there, one
 * entry per occurrence, with the runtime versions that make a report actionable.
 *
 * WHY IT IS NOT `process.on('unhandledRejection')` AS WELL. A rejected promise with no handler is a bug
 * worth failing on, and Node's own escalation path (rejection → uncaught exception) ends up here anyway.
 * Catching it earlier would silently change "this must be fixed" into "this was logged", for every promise
 * in the process. One listener is also exactly what keeps Electron's count at 2; two listeners would mean
 * the same thing to Electron and one more class of swallowed bug to us.
 *
 * WHY IT NEVER THROWS. It runs while the process is already misbehaving. A handler that throws turns one
 * failure into two, and the second one happens in front of a user who is looking at a broken window — the
 * same rule `host-crash.ts` states for its report writer.
 *
 * @module @qialike/desktop/main-crash-guard
 */

import { appendDesktopLog } from './desktop-log.ts'

/**
 * What kind of failure this was, from the point of view of what a reader should do about it.
 *
 * `undici-paused-parser` is singled out because it is the one class known to be benign per occurrence: the
 * reader can dismiss it. Everything else stays `unknown` on purpose — a classifier that guesses turns a
 * real diagnosis into a wrong one.
 */
export type MainProcessFailureKind = 'undici-paused-parser' | 'unhandled-rejection' | 'unknown'

/** One failure, already reduced to the text the log keeps. */
export interface MainProcessFailure {
  readonly kind: MainProcessFailureKind
  /** One line, on the entry's first line, so `grep` over the log answers "what happened". */
  readonly summary: string
  /** The whole entry: summary, runtime facts, and the stack. */
  readonly text: string
}

/** The slice of `process` the guard touches, so a test can hand it an EventEmitter instead. */
export interface CrashEmitter {
  on: (event: 'uncaughtException', listener: (error: unknown, origin?: string) => void) => unknown
  removeListener: (event: 'uncaughtException', listener: (error: unknown, origin?: string) => void) => unknown
}

/** Options for {@link installMainProcessGuard}. */
export interface CrashGuardOptions {
  /** Where entries go: `$DSH_HOME/qialike-desktop.log`. */
  readonly logPath: string
  /** Runtime versions, defaulting to the live `process.versions`. */
  readonly versions?: Record<string, string | undefined>
  /** Injectable clock, so a test can assert a stable entry. */
  readonly now?: () => Date
  /**
   * Show a message box, for the one case where a dialog is still the right instrument: an unexplained
   * failure during startup, when there is no window to be broken yet and no other channel to the user.
   */
  readonly announce?: (title: string, body: string) => void
  /** Whether {@link announce} may run right now. Defaults to never. */
  readonly shouldAnnounce?: () => boolean
  /** The emitter to attach to. Defaults to the real `process`. */
  readonly emitter?: CrashEmitter
  /** Log every Nth repeat of an identical failure after the first. Defaults to 25. */
  readonly repeatLogEvery?: number
  /** Cap on the stack text kept per entry. Defaults to 6000 characters. */
  readonly stackLimit?: number
}

/** The default cap on stack text; long enough for a real trace, short enough to stay greppable. */
const DEFAULT_STACK_LIMIT = 6000

/** The repeat threshold: an unread failure is not worth a full entry every time it happens. */
const DEFAULT_REPEAT_LOG_EVERY = 25

/** The assertion undici throws from `Parser.finish`. */
const UNDICI_ASSERTION = /assert\(!this\.paused\)/u

/** The two frames that identify that assertion even when the message is not the assertion text. */
const UNDICI_FRAME = /Parser\.finish/u
const UNDICI_SOCKET_FRAME = /onHttpSocketEnd/u

/** The one-line note a reader needs before deciding whether to care. */
const UNDICI_EXPLANATION =
  'a socket ended while undici\u2019s HTTP parser was paused, which drops one request and nothing else. '
  + 'Known Node/undici behaviour (nodejs/undici#5360); fixed upstream in nodejs/undici#5474.'

/**
 * Turn anything that can be thrown into an Error-shaped value.
 *
 * JavaScript permits `throw 'string'` and `throw { code }`, and both reach an `uncaughtException` handler.
 * Normalising here rather than at each use keeps the formatter total.
 *
 * @param thrown - whatever arrived.
 * @returns an Error, with the original value kept in `cause` when it was not one.
 */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown
  const text = typeof thrown === 'string' ? thrown : String(thrown)
  return new Error(text, { cause: thrown })
}

/**
 * Classify a failure.
 *
 * @param error - the exception, already normalised.
 * @param origin - Node's second argument: `'uncaughtException'` or `'unhandledRejection'`.
 * @returns the kind a reader acts on.
 */
export function classifyMainProcessFailure(
  error: Error,
  origin?: string,
): MainProcessFailureKind {
  const stack = error.stack ?? ''
  if (UNDICI_ASSERTION.test(`${error.message}\n${stack}`)) return 'undici-paused-parser'
  if (UNDICI_FRAME.test(stack) && UNDICI_SOCKET_FRAME.test(stack)) return 'undici-paused-parser'
  if (origin === 'unhandledRejection') return 'unhandled-rejection'
  return 'unknown'
}

/** The runtime line, so a report is reproducible without asking which build it came from. */
function runtimeLine(versions: Record<string, string | undefined>): string {
  const parts = ['electron', 'node', 'undici', 'chrome']
    .filter((name) => versions[name] !== undefined)
    .map((name) => `${name} ${String(versions[name])}`)
  return parts.length === 0 ? 'runtime versions unavailable' : parts.join(' \u00b7 ')
}

/**
 * Reduce a failure to the text the log keeps.
 *
 * @param thrown - whatever arrived.
 * @param options - the origin Node reported, the runtime versions, and the stack cap.
 * @returns the kind, the one-line summary and the whole entry.
 */
export function formatMainProcessFailure(
  thrown: unknown,
  {
    origin,
    versions = process.versions as Record<string, string | undefined>,
    stackLimit = DEFAULT_STACK_LIMIT,
  }: {
    origin?: string | undefined
    versions?: Record<string, string | undefined> | undefined
    stackLimit?: number
  } = {},
): MainProcessFailure {
  const error = toError(thrown)
  const kind = classifyMainProcessFailure(error, origin)

  const headline = kind === 'unhandled-rejection'
    ? 'main process: unhandled rejection'
    : 'main process: uncaught exception'

  const lines = [`${headline} (${kind})`, runtimeLine(versions)]

  if (kind === 'undici-paused-parser') lines.push(UNDICI_EXPLANATION)

  const stack = (error.stack ?? `${error.name}: ${error.message}`).trim()
  lines.push(stack.length > stackLimit ? `${stack.slice(0, stackLimit)}\n\u2026 (stack truncated)` : stack)

  return { kind, summary: `${headline} (${kind})`, text: lines.join('\n') }
}

/** What an entry says about repeats, once they start being collapsed. */
function repeatNote(count: number): string {
  return `(this failure has now been logged ${String(count)} times; identical repeats are collapsed)`
}

/**
 * The disposer for each emitter this module has already guarded.
 *
 * WHY INSTALLING TWICE IS A NO-OP RATHER THAN TWO LISTENERS. Electron only cares whether the count is above
 * one, so a duplicate would still suppress the dialog — and would fork the `seen` map, so every failure
 * this module writes would be written twice, by two handlers with independent repeat counters. The second
 * call here is therefore a bug in the caller, and the cheap defence is to hand back the disposer the first
 * one produced rather than to double the logging.
 */
const guarded = new WeakMap<CrashEmitter, () => void>()

/**
 * Install the handler, and return a function that removes it.
 *
 * THE COUNT IS THE MECHANISM, so it is stated where it would be broken: this must add exactly one
 * `uncaughtException` listener to the emitter Electron registered its own on.
 *
 * @param options - the log path and the optional policy knobs above.
 * @returns a disposer, for tests that must not leave a listener behind.
 */
export function installMainProcessGuard(options: CrashGuardOptions): () => void {
  const {
    logPath,
    versions,
    announce,
    shouldAnnounce = () => false,
    emitter = process as unknown as CrashEmitter,
    repeatLogEvery = DEFAULT_REPEAT_LOG_EVERY,
    stackLimit = DEFAULT_STACK_LIMIT,
  } = options

  const already = guarded.get(emitter)
  if (already !== undefined) return already

  /** How many times each identical failure has been seen, keyed by a signature that survives restarts. */
  const seen = new Map<string, number>()

  const handler = (thrown: unknown, origin?: string): void => {
    try {
      const failure = formatMainProcessFailure(thrown, { origin, versions, stackLimit })
      const error = toError(thrown)
      const firstFrame = (error.stack ?? '').split('\n')[1]?.trim() ?? ''
      const signature = `${failure.kind}|${error.name}|${error.message}|${firstFrame}`
      const count = (seen.get(signature) ?? 0) + 1
      seen.set(signature, count)

      // First occurrence in full; then every `repeatLogEvery`th, with a count. Entries are cheap but not
      // free, and this file rotates at 1 MiB — a dropped-connection loop must not push real history out.
      const worth = count === 1 || count % repeatLogEvery === 0
      if (worth) {
        appendDesktopLog(logPath, count === 1 ? failure.text : `${failure.text}\n${repeatNote(count)}`)
      }

      // A message box only for the case it is still good for: an unexplained failure while starting, when
      // there is no window to keep working in and no other channel to the person in front of the screen.
      if (failure.kind === 'unknown' && announce !== undefined && shouldAnnounce()) {
        announce('Qialike could not finish starting', failure.text)
      }
    } catch {
      // Nothing here may throw: see the module note. A failure to log is the log's problem, not a reason to
      // take down a process that is otherwise running.
    }
  }

  emitter.on('uncaughtException', handler)

  const dispose = (): void => {
    emitter.removeListener('uncaughtException', handler)
    guarded.delete(emitter)
  }
  guarded.set(emitter, dispose)
  return dispose
}
