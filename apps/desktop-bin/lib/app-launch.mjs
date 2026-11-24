/**
 * Launching the application for a probe — and, the part that matters, stopping it.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN EACH PROBE. The first version spawned
 * the artifact and killed the child it got back. That is wrong for an AppImage: its
 * runtime re-launches the payload as a **separate process**, so signalling the
 * wrapper leaves the real application running, reparented and invisible to the
 * script that thinks it cleaned up. The probes then deleted the user-data directory
 * they had handed to a still-running application; its main process failed to write,
 * and Electron showed the user an "A JavaScript error occurred in the main process"
 * dialog — produced by a test run that had already printed PASS.
 *
 * Three mistakes at once, each with a guard here:
 *
 *   · **the wrong process was signalled.** The application is launched `detached`,
 *     so it leads its own process group, and the *group* is what gets signalled.
 *     A group survives the leader and is what catches re-launched descendants.
 *   · **directories were removed under a live process.** Cleanup waits for the
 *     group to actually disappear before anything is deleted.
 *   · **cleanup ran after the verdict, unguarded.** A cleanup that throws must not
 *     be able to leave the appearance of success, and must not be skippable.
 *
 * A fourth guard is worth naming because it is not about this application at all:
 * `kill(-pid, …)` is only a group signal for a real group leader. At `pid` 1 it is
 * Linux's **broadcast to every process the caller may signal**, and at 0 it is the
 * caller's own group. A group id derived from a failed spawn would therefore take
 * out the user's session. Nothing below 2 is ever signalled.
 *
 * @module qialike-desktop/app-launch
 */

import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

/** How long to wait for a signal to take effect, and how often to look. */
const DEFAULT_GRACE_MS = 5_000
const DEFAULT_POLL_MS = 100

/**
 * Whether this platform signals a process *group*, as POSIX does.
 *
 * WINDOWS DOES NOT, and the difference is not cosmetic — it is the difference
 * between stopping the application and reporting that it was stopped. There is no
 * `kill(-pgid)`; `process.kill` takes a single pid, and a negative one is rejected.
 * So `process.kill(-pid, …)` throws there, and a `groupAlive` that only tried it
 * would answer "the group is gone" for a group that is very much alive. `stopApp`
 * would then return `true` having signalled nothing, and its caller — which trusts
 * that answer before deleting the user-data directory — would delete the directory
 * out from under a running application. That is the exact failure this module was
 * written to prevent, so Windows gets a real implementation rather than a silent
 * "already stopped".
 *
 * The mechanism there is {@link killProcessTree}: `taskkill /T`, which walks the
 * child tree the way the group signal does on POSIX.
 */
const HAS_PROCESS_GROUPS = process.platform !== 'win32'

/**
 * Terminate a process and its descendants, the way Windows spells it.
 *
 * `/T` is the load-bearing flag: it includes the tree, so the descendants an
 * application re-launched are reached exactly as a POSIX group signal reaches them.
 * Without `/F`, `taskkill` asks each window to close first (WM_CLOSE), which is the
 * closest Windows analogue of SIGTERM for a GUI application; `/F` is
 * `TerminateProcess`, the analogue of SIGKILL, and is what the escalation below
 * sends. Chromium refuses to close promptly often enough that the POSIX path always
 * ends in SIGKILL too, so the escalation is the normal case on both platforms.
 *
 * @param pid - the process to kill, with everything below it.
 * @param force - whether to terminate rather than request a close.
 * @returns whether `taskkill` reported success.
 */
function killProcessTree(pid, force) {
  const args = ['/PID', String(pid), '/T']
  if (force) args.push('/F')
  // `taskkill` is a console program on PATH; it exits 128 when the pid is already
  // gone, which is not an error for our callers — they treat "cannot kill" as "already
  // dead" and verify liveness separately.
  const result = spawnSync('taskkill', args, { stdio: 'ignore' })
  return result.status === 0
}

/**
 * Start the application in its own process group.
 *
 * @param options.binary - the artifact: an AppImage, or an unpacked executable.
 * @param options.args - arguments, including any `--appimage-*` runtime flag.
 * @param options.env - variables to add to the inherited environment.
 * @param options.cwd - working directory.
 * @returns the child, and a function returning everything it has logged so far.
 */
export function launchApp({ binary, args = [], env = {}, cwd }) {
  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // The whole point: the child leads a new process group, so every process it
    // spawns can be signalled through it. Without this the group is the caller's,
    // and `kill(-pid)` would signal the harness itself. On Windows `detached` gives
    // the child its own console rather than a group — there is no group to signal —
    // but it still keeps the child out of the runner's console group, which is what
    // keeps a stray window from arriving in the middle of the test run.
    detached: true,
  })
  let log = ''
  const collect = (chunk) => { log += chunk }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return { child, log: () => log }
}

/**
 * Whether a pid is safe to use as a negative (process-group) target.
 *
 * `kill(-pid, signal)` means "signal the group led by `pid`", which is only true
 * for a real leader. The degenerate values are not errors — they are *broader*
 * targets, and both are catastrophic here:
 *
 *   · `kill(-1, …)` signals **every process the caller may signal**. Linux defines
 *     it as a broadcast, not as "group 1".
 *   · `kill(0, …)` and `kill(-0, …)` signal the **caller's own process group**.
 *
 * A probe that computed a group id from a failed spawn and then signalled it would
 * take out the user's session — or, as happened while this guard was being written,
 * the test runner itself. So the rule is absolute: nothing below 2 is ever signalled.
 *
 * @param pid - the candidate.
 * @returns whether it may be used as a group target.
 */
function safeGroupTarget(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

/**
 * Whether any process remains in the child's group.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything, so this is the reliable liveness test for a *group* — `child.exitCode`
 * only ever describes the leader, which is precisely the distinction that caused
 * the stray window.
 *
 * ON WINDOWS THERE IS NO GROUP TO ASK ABOUT, so the honest answer is about the only
 * handle this module holds: the leader. That is weaker than the POSIX answer — a
 * descendant that outlived a killed leader is invisible to it — and the weakness is
 * recorded rather than papered over, because callers use the answer to decide whether
 * it is safe to delete a directory. What makes it *safe* on Windows is that
 * {@link stopApp} does not rely on this to do the killing: it always runs
 * `taskkill /T` while the leader is alive, which reaches the same tree the POSIX
 * group signal reaches. The case it cannot cover is a leader that died before
 * `stopApp` was called — an orphaned tree, which Windows would need a Job Object to
 * bind, and which this module therefore does not claim to reap.
 *
 * @param child - a child from {@link launchApp}.
 * @returns whether the group still has members.
 */
export function groupAlive(child) {
  if (!safeGroupTarget(child.pid)) return false
  if (!HAS_PROCESS_GROUPS) return pidAlive(child.pid)
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    // ESRCH: the group is empty. EPERM would mean it exists but is not ours, which
    // cannot happen for a group we created — and is still "not ours to reap".
    return false
  }
}

/** Whether a single pid exists; signal 0, so nothing is delivered. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Send a signal to the child's group, tolerating a group that is already gone. */
function signalGroup(child, signal) {
  if (!safeGroupTarget(child.pid)) return
  if (!HAS_PROCESS_GROUPS) {
    killProcessTree(child.pid, signal === 'SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Already dead, or everything in it is. Either way there is nothing to signal.
  }
}

/** Poll until the group is empty or the deadline passes. */
async function waitForGroupDeath(child, graceMs, pollMs) {
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!groupAlive(child)) return true
    await sleep(pollMs)
  }
  return !groupAlive(child)
}

/** Poll until a pid is gone, for a process outside any group this module owns. */
export async function waitForPidDeath(pid, { graceMs = DEFAULT_GRACE_MS, pollMs = DEFAULT_POLL_MS } = {}) {
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(pollMs)
  }
  return !pidAlive(pid)
}

/** Promise-based sleep. */
export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Stop the application and everything it started.
 *
 * `SIGTERM` first, because a clean shutdown is how the profile lock is released and
 * the Host's children are reaped; `SIGKILL` only for a group that ignored it.
 *
 * @param child - a child from {@link launchApp}.
 * @param options.graceMs - how long each signal gets.
 * @param options.pollMs - how often to check.
 * @returns whether the group is gone. Callers must treat `false` as a failure: it
 *   means something is still running, and deleting its files next would be the
 *   original bug.
 */
export async function stopApp(child, options = {}) {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  // A pid that is not a usable group target is reported as already stopped. There is
  // no group to wait for, and the alternative — signalling it — is a broadcast.
  if (!safeGroupTarget(child.pid)) return true
  if (!groupAlive(child)) return true

  signalGroup(child, 'SIGTERM')
  if (await waitForGroupDeath(child, graceMs, pollMs)) return true

  // Chromium's processes do not always act on SIGTERM, so this is expected rather
  // than exceptional.
  signalGroup(child, 'SIGKILL')
  return await waitForGroupDeath(child, graceMs, pollMs)
}

/**
 * Remove a directory, reporting rather than throwing.
 *
 * A probe's cleanup runs after its verdict. An exception here would replace the
 * exit status of the thing being tested with the status of the tidying up — which
 * is exactly how a crashed cleanup read as a passing run.
 *
 * @param path - the directory.
 * @returns whether it is gone.
 */
export function removeDir(path) {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Abort the run with a message, having first made sure nothing is left running.
 *
 * A probe that fails halfway is exactly when a stray application is most likely, so
 * the exit path is the same one success takes.
 *
 * @param message - what went wrong.
 * @param cleanup - steps to run before exiting.
 * @returns never.
 */
export async function fail(message, cleanup = []) {
  console.error(message)
  for (const step of cleanup) {
    try {
      await step()
    } catch { /* a failing cleanup must not hide the original message */ }
  }
  process.exit(1)
}
