/**
 * Stopping the application a probe started.
 *
 * This suite exists because a probe left an application running on someone's
 * desktop, showing a JavaScript error dialog, after printing PASS.
 *
 * The mechanism is worth stating precisely, because it is not obvious from reading
 * the code that caused it. An AppImage's runtime is a *launcher*: it extracts the
 * payload and starts it as a **separate process**. So `spawn(appImage)` returns a
 * handle to the launcher, and `child.kill()` kills the launcher — leaving the real
 * application running, reparented to init and absent from any list the script
 * looks at. The probe then deleted the user-data directory it had passed to that
 * still-running application; its main process failed to write, and Electron's
 * default uncaught-exception handler put a modal dialog on screen.
 *
 * The test below builds that shape deliberately — a launcher that spawns a
 * grandchild, which is the part that must die — using nothing but `node`. It needs
 * no display, no Electron and no artifact, which is the point: the failure is about
 * process groups, so it can be reproduced and guarded anywhere.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  groupAlive, launchApp, pidAlive, removeDir, sleep, stopApp, waitForPidDeath,
} from '../apps/desktop-bin/lib/app-launch.mjs'

/** A launcher that starts a grandchild and then waits, like an AppImage runtime. */
const LAUNCHER = `
import { spawn } from 'node:child_process'
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log('GRANDCHILD=' + String(grandchild.pid))
setInterval(() => {}, 1000)
`

/** A launcher that starts nothing, for the simple cases. */
const IDLE = `setInterval(() => {}, 1000)\n`

describe('launchApp and stopApp', () => {
  let root
  /** Everything started by a test, so a failing assertion cannot leak a process. */
  let started
  /** Every pid a test learned about directly. */
  let grandchildPids

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-launch-'))
    started = []
    grandchildPids = []
  })

  afterEach(async () => {
    // Belt and braces. A test that fails mid-way must not leave what this whole
    // suite is about on the machine.
    for (const child of started) await stopApp(child, { graceMs: 3000 })
    for (const pid of grandchildPids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    removeDir(root)
  })

  /** Write a script and launch it. */
  function launch(source) {
    const file = join(root, `launcher-${String(started.length)}.mjs`)
    writeFileSync(file, source)
    const app = launchApp({ binary: process.execPath, args: [file] })
    started.push(app.child)
    return app
  }

  /** Wait for the launcher to report its grandchild's pid. */
  async function grandchildOf(app) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const match = /GRANDCHILD=(\d+)/u.exec(app.log())
      if (match !== null) {
        const pid = Number(match[1])
        grandchildPids.push(pid)
        return pid
      }
      await sleep(50)
    }
    throw new Error('the launcher never reported a grandchild')
  }

  it('starts the application in its own process group', () => {
    // Load-bearing: without its own group the group signal below would target the
    // test runner's group, and `stopApp` would kill the tests themselves.
    //
    // On Windows there is no group to belong to. `groupAlive` there reports the only
    // handle this module holds — the leader — so what this asserts on Windows is that
    // the child is running and therefore still reachable by `taskkill /T`, which is
    // what `stopApp` actually kills with.
    const app = launch(IDLE)
    expect(groupAlive(app.child)).toBe(true)
    expect(app.child.pid).toBeGreaterThan(0)
  })

  it('kills a grandchild that outlived its launcher', async () => {
    // The regression test. Signalling the child we hold is not enough, because the
    // application is the grandchild.
    const app = launch(LAUNCHER)
    const grandchild = await grandchildOf(app)
    expect(pidAlive(grandchild)).toBe(true)

    expect(await stopApp(app.child)).toBe(true)

    // Gone, not merely signalled: a zombie would still answer signal 0 on the way
    // out, so this waits rather than checking once.
    expect(await waitForPidDeath(grandchild, { graceMs: 4000 })).toBe(true)
  })

  // POSIX-ONLY, because it asserts a property of process GROUPS rather than of this
  // module: that killing the leader leaves the group alive and still reaping. Windows
  // has no group to outlive anything — `stopApp` there kills the tree with
  // `taskkill /T` while the leader is alive, and a tree orphaned by an earlier leader
  // death would need a Job Object with `KILL_ON_JOB_CLOSE` to bind, which no part of
  // this repository creates. Recorded rather than hidden: on Windows a leader that
  // died first leaves descendants this module cannot reach.
  it.skipIf(process.platform === 'win32')('kills the grandchild even when the launcher has already exited', async () => {
    // The actual shape of the failure: the launcher was killed and reaped, and the
    // application kept running with nothing pointing at it.
    const app = launch(LAUNCHER)
    const grandchild = await grandchildOf(app)
    app.child.kill('SIGKILL')
    await sleep(500)
    // The handle is dead; the group is not — which is the entire distinction.
    expect(app.child.killed || app.child.exitCode !== null || app.child.signalCode !== null).toBe(true)
    expect(pidAlive(grandchild)).toBe(true)

    expect(await stopApp(app.child)).toBe(true)
    expect(await waitForPidDeath(grandchild, { graceMs: 4000 })).toBe(true)
  })

  it('refuses a pid that would broadcast instead of targeting a group', async () => {
    // `kill(-1, sig)` is Linux's signal-every-process-I-may-signal, not "group 1",
    // and `kill(0, sig)` is the caller's own group. A probe that computed a group id
    // from a failed spawn and signalled it would take out the user's session.
    //
    // This is not hypothetical: writing these very tests with `{ pid: 1 }` killed the
    // test runner, because -1 broadcast SIGTERM to the whole session.
    for (const pid of [1, 0, -1, undefined, 1.5, Number.NaN]) {
      expect(groupAlive({ pid }), `pid ${String(pid)}`).toBe(false)
      expect(await stopApp({ pid }, { graceMs: 50, pollMs: 10 }), `pid ${String(pid)}`).toBe(true)
    }
    // And the runner is still here to assert it.
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // Chromium's processes do not always act on SIGTERM, so the escalation is the
    // path that actually stops an application rather than a fallback that never runs.
    const app = launch(`
      process.on('SIGTERM', () => { console.log('IGNORED-TERM') })
      setInterval(() => {}, 1000)
    `)
    expect(await stopApp(app.child, { graceMs: 1500, pollMs: 50 })).toBe(true)
  })

  it('is safe to stop twice, and safe on a process that already exited', async () => {
    const app = launch(IDLE)
    expect(await stopApp(app.child)).toBe(true)
    expect(await stopApp(app.child)).toBe(true)

    const quick = launchApp({ binary: process.execPath, args: ['-e', 'process.exit(0)'] })
    await sleep(500)
    expect(await stopApp(quick.child)).toBe(true)
  })

  // The same POSIX group property as the test above, from the other side: a killed
  // leader must NOT be read as a dead group. On Windows `groupAlive` answers about the
  // leader, so the distinction this asserts does not exist there; `stopApp`'s safety on
  // Windows comes from always running `taskkill /T` while the leader lives instead.
  it.skipIf(process.platform === 'win32')('reports a group as dead only once every member is', async () => {
    const app = launch(LAUNCHER)
    const grandchild = await grandchildOf(app)
    expect(groupAlive(app.child)).toBe(true)

    // Killing only the leader must leave the group alive — the precise state the
    // original code mistook for "clean".
    app.child.kill('SIGKILL')
    await sleep(300)
    expect(groupAlive(app.child)).toBe(true)
    expect(pidAlive(grandchild)).toBe(true)

    await stopApp(app.child)
    expect(groupAlive(app.child)).toBe(false)
  })
})

describe('removeDir', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-removedir-'))
  })

  it('removes a tree, and reports that it did', () => {
    expect(removeDir(root)).toBe(true)
  })

  it('does not throw when the path is already gone', () => {
    // Cleanup runs after the verdict. Throwing here would replace the exit status of
    // the thing under test with the status of the tidying up — which is how a
    // crashed cleanup came to look like a passing run.
    expect(removeDir(join(root, 'never-existed'))).toBe(true)
  })
})

describe('process liveness helpers', () => {
  it('distinguishes a live pid from a dead one', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    expect(pidAlive(child.pid)).toBe(true)
    child.kill('SIGKILL')
    expect(await waitForPidDeath(child.pid, { graceMs: 4000 })).toBe(true)
    expect(pidAlive(child.pid)).toBe(false)
  })

  it('treats an impossible pid as dead rather than throwing', () => {
    // 2^30 is above any pid Linux will hand out, so signal 0 raises ESRCH.
    expect(pidAlive(1_073_741_824)).toBe(false)
  })
})
