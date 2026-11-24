/**
 * Who notices when the Host stops, and whether they are told the truth about why.
 *
 * THE OBSERVER IS THE FEATURE. Everything else about a crash report is formatting;
 * the part that was missing is that *nothing watched the child after startup*.
 * `waitForReady` detaches its listeners when readiness arrives, so from that moment
 * the only exit listener in the process belonged to `stopHost` — which runs when the
 * shell asked for a stop. A Host that died mid-session was therefore observed by
 * nobody, and the window kept rendering over a backend that was gone.
 *
 * WHY THIS SUITE SPAWNS A REAL CHILD. The thing under test is an event listener on a
 * `ChildProcess`, and the two facts that matter are both about *ordering*: that the
 * listener survives `waitForReady`'s cleanup, and that it reports `expected: false`
 * for a death nobody asked for while reporting `true` for a stop that was requested.
 * A hand-rolled `EventEmitter` would let me assert exactly the sequence I wrote, which
 * is the one thing I already believe; a real process over the real `ipc` channel
 * exercises the cleanup and the ordering as they actually are.
 *
 * The fake Host is a handful of lines — it sends the readiness message the shell
 * expects and then does whatever the test asked for — so this needs no runtime tree,
 * no profile and no Electron. `host-process.ts` imports only `node:child_process`,
 * `node:path` and the bundle list, which is what makes that possible.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const LIB = join(ROOT, 'apps', 'desktop', 'lib')
const compiled = existsSync(join(LIB, 'host-process.js'))
const { startHost, HOST_PROTOCOL_VERSION } = compiled ? await import(join(LIB, 'host-process.js')) : {}

/**
 * A scratch runtime whose Host is this test's script.
 *
 * `startHost` resolves its entry as
 * `<runtime>/node_modules/@qialike/qialike-desktop-host/lib/index.js`, so the fake has
 * to sit at exactly that path — which is also an assertion in itself: if that
 * resolution ever changes, this test fails loudly instead of silently testing nothing.
 */
function fakeRuntime(body) {
  const runtime = mkdtempSync(join(tmpdir(), 'qialike-host-'))
  const dir = join(runtime, 'node_modules', '@qialike', 'qialike-desktop-host', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), body)
  return runtime
}

/**
 * Report readiness exactly as the real Host does, then idle until asked to stop —
 * and acknowledge the stop, as the real Host does after tearing its tree down.
 *
 * ACKNOWLEDGING IS NOT A CONVENIENCE. Without it `stop()` waits out
 * `SHUTDOWN_TIMEOUT_MS` (ten seconds) before escalating to SIGKILL, which would make
 * this suite slow *and* would test the escalation path rather than the ordinary one.
 * The graceful path is the one a quit takes.
 */
const readyThenIdle = `
process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'ready', url: 'http://127.0.0.1:1/', injections: [] })
process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'shutdown-complete' })
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
`

describe.skipIf(!compiled)('the exit observer', () => {
  it('is not called when the shell asked the Host to stop', async () => {
    // THE REGRESSION THIS EXISTS FOR. `stop()` runs on quit, on update and on every
    // relaunch. An observer keyed off "the child exited" would fire each time, put a
    // crash dialog in front of every normal quit, and teach the user to dismiss the
    // one that matters. `expected` is the whole defence.
    const runtime = fakeRuntime(readyThenIdle)
    try {
      const exits = []
      const host = await startHost({
        runtime,
        profile: runtime,
        port: 0,
        onExit: (exit) => exits.push(exit),
      })
      await host.stop()
      expect(exits).toHaveLength(1)
      expect(exits[0].expected).toBe(true)
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  }, 30_000)

  it('is called, and says so, when the Host dies on its own', async () => {
    // The bug: this produced nothing at all before, in any log, ever.
    const runtime = fakeRuntime(`
process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'ready', url: 'http://127.0.0.1:1/', injections: [] })
setTimeout(() => { process.stderr.write('the last thing it ever said\\n'); process.exit(7) }, 120)
`)
    try {
      const exits = []
      const host = await startHost({
        runtime,
        profile: runtime,
        port: 0,
        onExit: (exit) => exits.push(exit),
      })
      // Wait for the child's own timer rather than polling a predicate: there is
      // exactly one event to wait for, and a poll would only add a sleep.
      await new Promise((resolve) => { setTimeout(resolve, 2000) })
      expect(exits).toHaveLength(1)
      expect(exits[0]).toMatchObject({ code: 7, signal: null, expected: false })
      // The tail survives the child, which is the other half of the fix: the report is
      // built from this after the process is gone.
      expect(host.stderrTail()).toContain('the last thing it ever said')
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  }, 30_000)

  it('reports a signal as a signal, which is the more specific fact', async () => {
    const runtime = fakeRuntime(`
process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'ready', url: 'http://127.0.0.1:1/', injections: [] })
setInterval(() => {}, 1000)
`)
    try {
      const exits = []
      const host = await startHost({ runtime, profile: runtime, port: 0, onExit: (exit) => exits.push(exit) })
      // Reap it by PID, the way a crash would: nothing asked it to stop.
      //
      // BY PID, NOT BY PATTERN, AND THE FIRST VERSION OF THIS TEST GOT IT WRONG IN A
      // WAY WORTH RECORDING. It ran `pkill -KILL -f qialike-desktop-host/lib/index.js`
      // — which matches every Host on the machine, including the real one that
      // `profile-boot.test.mjs` had spawned in a parallel vitest worker. That suite
      // failed with "the Host exited early (code null, signal SIGKILL)", pointing at
      // the application rather than at this file, and the whole run went red for a
      // reason that had nothing to do with what it was testing. A pattern kill is a
      // broadcast, and a test that broadcasts is a test that breaks its neighbours.
      process.kill(host.child.pid, 'SIGKILL')
      await new Promise((resolve) => { setTimeout(resolve, 1500) })
      expect(exits).toHaveLength(1)
      // WINDOWS HAS NO SIGNALS TO REPORT. `process.kill(pid, 'SIGKILL')` there is
      // `TerminateProcess`, and Node reports the death as an exit code with
      // `signal: null` — there is no signal name for the observer to preserve. The
      // property this test exists for is that a Host reaped without being asked is
      // reported as *unexpected*, with the most specific fact the host can give: the
      // signal on POSIX, the code on Windows.
      if (process.platform === 'win32') {
        expect(exits[0].signal).toBe(null)
        expect(typeof exits[0].code).toBe('number')
      } else {
        expect(exits[0].signal).toBe('SIGKILL')
      }
      expect(exits[0].expected).toBe(false)
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps only the tail of a long log', async () => {
    // A Host that has run for hours has an stderr nobody will read; the lines that
    // explain a death are the ones next to it.
    const runtime = fakeRuntime(`
process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'ready', url: 'http://127.0.0.1:1/', injections: [] })
for (let i = 0; i < 300; i += 1) process.stderr.write('filler ' + i + '\\n')
setTimeout(() => { process.stderr.write('THE LAST LINE\\n'); process.exit(2) }, 300)
`)
    try {
      const host = await startHost({ runtime, profile: runtime, port: 0 })
      await new Promise((resolve) => { setTimeout(resolve, 2500) })
      const tail = host.stderrTail(5)
      expect(tail).toContain('THE LAST LINE')
      expect(tail).not.toContain('filler 0')
      expect(tail.split('\n').length).toBeLessThanOrEqual(6)
    } finally {
      rmSync(runtime, { recursive: true, force: true })
    }
  }, 30_000)
})
