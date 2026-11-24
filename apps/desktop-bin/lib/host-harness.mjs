/**
 * Spawn the assembled Host and drive its startup handshake.
 *
 * This is the harness the boot tests use, and it deliberately reproduces the
 * Electron shell's side of the protocol rather than approximating it: the same
 * argv, the same `stdio` with an IPC channel, the same readiness message, and
 * the same one-time exchange of the tokenized URL for an authority-bound
 * cookie. A test that authenticated differently from the shell would prove the
 * Host works under conditions the application never creates.
 *
 * @module qialike-desktop/host-harness
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long a boot may take before the harness gives up. */
export const BOOT_TIMEOUT_MS = 120_000

/** The bundles a qialike desktop profile composes, in application order. */
export const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qialike/qialike-desktop-app',
]

/**
 * Everything that arrived over IPC, in order.
 *
 * A Host that fails sends `fatal`; one that starts sends `ready`. Collecting
 * both lets a test report the diagnostic instead of a timeout.
 */
export function collectHostEvents(child) {
  const events = []
  const waiters = []
  child.on('message', (message) => {
    events.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  })
  return {
    events,
    /** Resolve with the first event (past or future) matching a predicate. */
    waitFor(match, { timeoutMs = BOOT_TIMEOUT_MS, what = 'a Host event' } = {}) {
      const existing = events.find(match)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve }
        waiters.push(waiter)
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(new Error(
            `qialike-desktop: timed out after ${String(timeoutMs)}ms waiting for ${what}. `
            + `Events received: ${JSON.stringify(events)}`,
          ))
        }, timeoutMs)
        waiter.resolve = (value) => { clearTimeout(timer); resolve(value) }
      })
    },
  }
}

/**
 * Start the Host against an assembled runtime tree.
 *
 * @param options.runtimeDir - the runtime tree root (`dist/runtime/dsh`).
 * @param options.home - `$DSH_HOME` for this run; a temp directory when omitted.
 * @param options.port - bind port; 0 lets the OS choose.
 * @param options.node - interpreter; the Electron binary in Node mode by default,
 *   because that is what ships and its Node major differs from the dev host's.
 * @param options.electron - Electron binary path, when `node` is not given.
 * @returns a handle with the child, its events, and helpers.
 */
export function startHost(options) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'qialike-home-'))
  const ownsHome = options.home === undefined
  const interpreter = options.node ?? options.electron ?? process.execPath
  const env = options.node === undefined && options.electron !== undefined
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env }

  const projectDir = join(home, 'profiles', 'qialike-desktop')
  // The child's cwd must exist before spawn. Node reports a missing cwd as
  // ENOENT on the *binary* path, which sends you looking at the interpreter
  // instead of at the directory.
  mkdirSync(projectDir, { recursive: true })
  const args = [
    join(options.runtimeDir, 'node_modules', '@qialike', 'qialike-desktop-host', 'lib', 'index.js'),
    options.runtimeDir,
    projectDir,
    '--port', String(options.port ?? 0),
    '--bundles', PROFILE_BUNDLES.join(','),
  ]
  const child = spawn(interpreter, args, {
    cwd: projectDir,
    env: { ...env, DSH_HOME: home },
    // `ipc` is the fourth descriptor: the Host reports readiness and takes
    // control messages over it, exactly as the shell drives it.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  const events = collectHostEvents(child)
  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  return {
    child,
    home,
    projectDir,
    events,
    stderr,
    /** Everything the Host wrote to stderr, for a failure message. */
    stderrText: () => stderr.join(''),
    /**
     * Wait for readiness, or reject with the Host's own diagnostic.
     *
     * A `fatal` message carries the inspected error the shell would show, so it
     * is almost always more useful than a timeout.
     */
    async ready({ timeoutMs = BOOT_TIMEOUT_MS } = {}) {
      const outcome = await Promise.race([
        events.waitFor((message) => message.type === 'ready' || message.type === 'fatal', {
          timeoutMs, what: 'the Host to reach ready or fail',
        }),
        new Promise((resolve) => child.once('exit', (code, signal) => resolve({
          type: 'fatal', message: `the Host exited early (code ${String(code)}, signal ${String(signal)})`,
          diagnostic: stderr.join(''),
        }))),
      ])
      if (outcome.type === 'fatal') {
        throw new Error(`qialike-desktop: the Host failed to start: ${outcome.message}\n${outcome.diagnostic ?? ''}`)
      }
      return outcome
    },
    /** Ask the Host to shut down and wait for its acknowledgement. */
    async shutdown({ timeoutMs = 30_000 } = {}) {
      const done = events.waitFor((message) => message.type === 'shutdown-complete', { timeoutMs, what: 'shutdown-complete' })
      child.send({ type: 'shutdown' })
      try {
        await done
      } catch {
        child.kill('SIGKILL')
      }
      // THEN WAIT FOR THE PROCESS, BEFORE REMOVING ITS HOME. `shutdown-complete` says
      // the profile's tree tore down; it does not say the process is gone, and on
      // Windows that distinction is observable: a directory holding a file the child
      // still has open cannot be removed, and `force` suppresses only ENOENT, so the
      // `rmSync` below raised EPERM out of `afterAll` and failed a suite whose tests
      // had all passed. Waiting for `exit` removes the cause rather than the symptom,
      // and the short retry absorbs the rest: Windows releases handles asynchronously
      // after the process is reaped.
      await Promise.race([
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => { child.once('exit', resolve) }),
        new Promise((resolve) => { setTimeout(resolve, 5000) }),
      ])
      if (ownsHome) await removeHomeWithRetry(home)
    },
  }
}

/**
 * Remove a throwaway `$DSH_HOME`, tolerating a handle Windows has not released yet.
 *
 * Cleanup runs in `afterAll`, so a throw here replaces the suite's verdict with a
 * tidying-up failure — the same shape of mistake `probe-lifecycle`'s `removeDir`
 * documents. This is a directory under the OS temp directory that nothing else
 * reads, so the last resort is to leave it rather than to fail the run.
 *
 * @param home - the directory to remove.
 */
async function removeHomeWithRetry(home) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(home, { recursive: true, force: true })
      return
    } catch {
      // EPERM/EBUSY: a file the just-exited child held is still closing. Retried
      // rather than reported; the caller has no corrective action available.
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
  }
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Left behind deliberately. It is in the temp directory, and failing the suite
    // over it would be the worse outcome.
  }
}

/**
 * Exchange the Host's tokenized URL for an authority-bound cookie.
 *
 * The Host reports a URL carrying its access token; the shell redeems it once
 * for a cookie and never forwards the token to a renderer. Mirrors
 * `authenticateWebHost` in the shell, including the requirement that the
 * exchange answer with a redirect.
 *
 * @param readyUrl - the `url` from the Host's ready message.
 * @returns the cookie header value to send on subsequent requests.
 */
export async function authenticate(readyUrl) {
  const response = await fetch(readyUrl, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(
      `qialike-desktop: the Host authentication exchange failed: expected 303 with a Set-Cookie, `
      + `received ${String(response.status)}${cookie === null ? ' and no cookie' : ''}.`,
    )
  }
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}
