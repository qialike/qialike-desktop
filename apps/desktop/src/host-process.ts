/**
 * The Host child process: spawn it, read its readiness, and stop it cleanly.
 *
 * The shell runs the Host as the **Electron binary in Node mode** rather than as
 * `node`. That is what lets the application require no Node installation: the
 * runtime is already there, and the Host gets the same V8 and the same
 * Node-API ABI the packaged tree's native addons were built against.
 *
 * The protocol is deliberately small — a handful of JSON messages over the
 * child's `ipc` descriptor — and every inbound message is validated structurally
 * before it is trusted. A Host is not a hostile peer, but it is a peer that can
 * be replaced by a different build, and a message whose shape is assumed is how a
 * version skew becomes an `undefined` deep inside the shell.
 *
 * @module @qialike/desktop/host-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { PROFILE_BUNDLES } from './paths.ts'

/** The protocol generation the shell and the Host must agree on. */
export const HOST_PROTOCOL_VERSION = 1

/** How long a Host may take to report readiness. */
export const READY_TIMEOUT_MS = 120_000

/** How long a graceful shutdown may take before the shell escalates. */
export const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * How long the shell waits for a killed Host to actually be gone.
 *
 * SIGKILL cannot be caught, so this expires only for a process the kernel has not
 * released — uninterruptible I/O, most often a stuck network or FUSE mount. It exists
 * so that the quit waiting on {@link stopHost} always completes; see the wait it bounds.
 */
export const EXIT_TIMEOUT_MS = 5_000

/** Readiness: the Host bound its port and can serve. */
export interface HostReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections: readonly unknown[]
}

/** Startup failure, carrying the Host's own inspected error. */
export interface HostFatalEvent {
  readonly type: 'fatal'
  readonly message: string
  readonly diagnostic?: string
}

/** The Host finished tearing its tree down. */
export interface HostShutdownEvent {
  readonly type: 'shutdown-complete'
}

/** Every message the Host may send. */
export type HostEvent = HostReadyEvent | HostFatalEvent | HostShutdownEvent

/**
 * Validate one inbound message.
 *
 * A structural check rather than a cast, and it rejects rather than ignores: an
 * unrecognised message means the two sides disagree about the protocol, and
 * continuing would run a Host the shell cannot control.
 */
export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const candidate = value as Record<string, unknown>
  switch (candidate.type) {
    case 'ready':
      return typeof candidate.url === 'string'
        && candidate.url.length > 0
        && Array.isArray(candidate.injections)
    case 'fatal':
      return typeof candidate.message === 'string'
      // The diagnostic is optional: a Host that failed before it could inspect
      // the error still reports the message.
      && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'shutdown-complete':
      return true
    default:
      return false
  }
}

/**
 * The environment the Host runs with.
 *
 * `ELECTRON_RUN_AS_NODE=1` is what turns the Electron binary into a Node
 * process; without it the child would try to open a window. The variable is
 * removed from the *renderer's* environment by Electron itself, so it cannot be
 * inherited by anything the agent later spawns.
 */
export function hostEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ELECTRON_RUN_AS_NODE: '1' }
}

/**
 * How long each step of the shutdown ladder waits.
 *
 * INJECTABLE SO THE LADDER CAN BE TESTED AT ALL. Every step after the graceful request
 * is a timeout, so with the real values a test of the escalation path spends fifteen
 * seconds proving what a hundred milliseconds proves — which is why the suite did not
 * cover the ladder, and why the bound at its end went in unnoticed until a shell was
 * found still running thirteen hours after it was asked to close. A caller that supplies
 * nothing gets the real deadlines.
 */
export interface ShutdownTimeouts {
  /** How long the Host has to acknowledge before it is signalled. */
  readonly gracefulMs: number
  /** How long to wait for SIGTERM to work before sending SIGKILL. */
  readonly termMs: number
  /** How long a killed Host has to be gone before the shell stops waiting. */
  readonly exitMs: number
}

/** The deadlines a real quit uses. */
export const SHUTDOWN_TIMEOUTS: ShutdownTimeouts = {
  gracefulMs: SHUTDOWN_TIMEOUT_MS,
  termMs: 5_000,
  exitMs: EXIT_TIMEOUT_MS,
}

/** What a caller may ask of {@link DesktopHost.stop}. */
export interface StopOptions {
  /**
   * Fail instead of escalating, for the paths that must not lose a session log.
   *
   * An update, and a relaunch, both need the Host to have flushed; a quit does not, so
   * only a quit accepts the escalation.
   */
  readonly requireGraceful?: boolean
  /** Override the ladder's deadlines; the test seam described on {@link ShutdownTimeouts}. */
  readonly timeouts?: Partial<ShutdownTimeouts>
}

/**
 * A running Host.
 */
export interface DesktopHost {
  readonly child: ChildProcess
  readonly url: string
  readonly injections: readonly unknown[]
  /** Stop the Host, escalating if it does not acknowledge in time. */
  stop(options?: StopOptions): Promise<void>
  /**
   * The tail of the Host's stderr, for a crash report.
   *
   * A function rather than a value because the point of reading it is usually that
   * the Host has *stopped* writing, and the interesting lines are the last ones.
   */
  stderrTail(lines?: number): string
}

/**
 * What the shell learns when the Host dies after startup.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS NOT OPTIONAL. `waitForReady` detaches every
 * listener once readiness arrives, and after that the only thing watching the child
 * is `stopHost` — which runs when the shell *asked* it to stop. So a Host that died
 * on its own mid-session was observed by nothing: the window stayed open, kept
 * rendering, and every request into it failed, with no dialog, no log line and no
 * non-zero exit anywhere. The user's report would be "it stopped working", and the
 * diagnostic that would explain it — the child's own stderr — had already been
 * discarded with the process.
 *
 * `expected` distinguishes the two cases, and getting it wrong in either direction
 * is bad: report a crash on every quit and the dialog becomes noise people click
 * through, while never reporting one is the silence above.
 */
export interface HostExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** True when the shell asked the Host to stop, so this is not a crash. */
  readonly expected: boolean
}

/**
 * Start the Host and wait for it to report readiness.
 *
 * @param options.paths - resolved application paths.
 * @param options.port - bind port; 0 lets the OS choose.
 * @param options.env - environment overrides, for development.
 * @param options.onExit - called when the Host exits *after* readiness, including
 *   on an intentional stop, so the caller can tell the two apart and report only
 *   what it should. See `HostExit`.
 * @returns the running Host.
 * @throws Error carrying the Host's own diagnostic when startup fails.
 */
export async function startHost(options: {
  runtime: string
  profile: string
  port: number
  env?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  onExit?: (exit: HostExit) => void
}): Promise<DesktopHost> {
  const entry = join(options.runtime, 'node_modules', '@qialike', 'qialike-desktop-host', 'lib', 'index.js')
  const child = spawn(process.execPath, [
    entry,
    options.runtime,
    options.profile,
    '--port', String(options.port),
    '--bundles', PROFILE_BUNDLES.join(','),
  ], {
    cwd: options.profile,
    env: hostEnvironment(options.env ?? process.env),
    // `ipc` is the channel the readiness message and control messages use.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  // The Host's stderr is kept for the failure message: a startup failure often
  // prints something more specific than the inspected error it reports over IPC.
  // It is kept for the whole session, not just startup, because the crash report
  // needs the lines a dying Host wrote last — and by then there is nothing left to
  // ask.
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { process.stdout.write(chunk) })

  const ready = await waitForReady(child, () => stderr, options.readyTimeoutMs ?? READY_TIMEOUT_MS)

  // `stopHost` sets this before signalling, so the observer below can tell an
  // intentional stop from a crash without inspecting the exit code — a Host that
  // exits 0 on its own is still a Host that died mid-session, and a Host killed
  // with SIGKILL after a graceful stop was asked for is still an expected exit.
  let stopping = false
  child.on('exit', (code, signal) => {
    options.onExit?.({ code, signal, expected: stopping })
  })

  return {
    child,
    url: ready.url,
    injections: ready.injections,
    stderrTail: (lines = 40) => stderr.split('\n').slice(-lines).join('\n'),
    stop: async (stopOptions) => {
      stopping = true
      await stopHost(child, stopOptions)
    },
  }
}

/**
 * Await `ready`, `fatal`, or an early exit, whichever comes first.
 *
 * All three are terminal for startup, and an early exit is the case a
 * message-only wait would hang on: a Host that dies before it can send anything
 * leaves nothing to match.
 */
function waitForReady(child: ChildProcess, stderrText: () => string, timeoutMs: number): Promise<HostReadyEvent> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      action()
    }
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new Error(
          `qialike desktop: the Host did not report readiness within ${String(timeoutMs)}ms.\n`
          + `Host output:\n${stderrText().slice(-2000)}`,
        ))
      })
    }, timeoutMs)

    const onMessage = (message: unknown): void => {
      const event = isUnknownHostEvent(message)
      if (event === 'unknown') {
        finish(() => {
          child.kill('SIGKILL')
          reject(new Error(
            `qialike desktop: the Host sent a message this shell does not understand (protocol ${String(HOST_PROTOCOL_VERSION)}): `
            + `${JSON.stringify(message)?.slice(0, 500)}`,
          ))
        })
        return
      }
      if (event.type === 'fatal') {
        finish(() => reject(new Error(
          `qialike desktop: the Host failed to start: ${event.message}\n${event.diagnostic ?? stderrText().slice(-2000)}`,
        )))
        return
      }
      if (event.type === 'ready') finish(() => resolve(event))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() => reject(new Error(
        `qialike desktop: the Host exited during startup (code ${String(code)}, signal ${String(signal)}).\n`
        + `Host output:\n${stderrText().slice(-2000)}`,
      )))
    }
    const onError = (error: Error): void => { finish(() => reject(error)) }

    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

/** Distinguish a message that is an event from one that is not. */
function isUnknownHostEvent(message: unknown): HostEvent | 'unknown' {
  return isHostEvent(message) ? message : 'unknown'
}

/**
 * Stop the Host: ask, then escalate.
 *
 * A Host that acknowledges has torn its Cordis tree down and flushed its session
 * log. One that does not is killed, because a shell that waits forever on a
 * wedged child is worse than one that loses the tail of a log — but the
 * escalation is reported so it is not mistaken for a clean exit.
 */
async function stopHost(child: ChildProcess, options: StopOptions = {}): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  const limits: ShutdownTimeouts = { ...SHUTDOWN_TIMEOUTS, ...options.timeouts }

  const acknowledged = new Promise<boolean>((resolve) => {
    const onMessage = (message: unknown): void => {
      if (isHostEvent(message) && message.type === 'shutdown-complete') {
        child.off('message', onMessage)
        resolve(true)
      }
    }
    child.on('message', onMessage)
    child.once('exit', () => resolve(false))
  })

  try {
    child.send({ type: 'shutdown' })
  } catch {
    // The channel is already gone; the exit below is all that is left to await.
  }

  const graceful = await Promise.race([
    acknowledged,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limits.gracefulMs)),
  ])

  if (!graceful) {
    if (options.requireGraceful === true) {
      throw new Error(
        `qialike desktop: the Host did not acknowledge shutdown within ${String(limits.gracefulMs)}ms. `
        + 'A running task may not have been flushed to its session log.',
      )
    }
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, limits.termMs))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    // BOUNDED ON PURPOSE, and this is the only await in the ladder that was not. Every
    // step above has a deadline except the one that waits for the process to actually
    // go away — and that one is the step the shell cannot proceed without, because the
    // quit that called `stop()` is waiting on this promise. An unkillable child (a
    // process wedged in uninterruptible I/O ignores SIGKILL until the kernel lets go)
    // would therefore hold the quit open indefinitely, which is how a shell that was
    // asked to close stays on the desktop holding its single-instance lock.
    //
    // Resolving is the right answer rather than waiting: the caller is a quit, and a
    // quit that never completes is worse than one that reports what it could not
    // finish. The report is what keeps it from being mistaken for a clean exit.
    const settled = (): boolean => child.exitCode !== null || child.signalCode !== null
    const timer = setTimeout(() => {
      if (settled()) { resolve(); return }
      console.error(
        `qialike desktop: the Host was killed but has not exited ${String(limits.exitMs)}ms later; `
        + 'continuing to quit. It may still hold the profile lock, in which case the next launch '
        + 'will refuse to start until that process is gone.',
      )
      resolve()
    }, limits.exitMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
