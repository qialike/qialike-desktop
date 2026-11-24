/**
 * The shutdown ladder, which no test covered until it mattered.
 *
 * WHY THIS EXISTS NOW. The suite deliberately avoided this path: with the real deadlines
 * the escalation costs fifteen seconds, so covering it meant a slow suite *and* a test of
 * the uninteresting branch. But the reason to cover it was never the escalation itself —
 * it is that `stop()` is what a quit waits on, so anything unbounded inside it is a way
 * for the application to refuse to close. That is exactly what happened: a shell was
 * found still running thirteen hours after it was asked to quit, holding the lock that
 * made every later launch exit silently. The deadlines are injectable now (see
 * `ShutdownTimeouts`), so the ladder is cheap to assert on.
 *
 * WHAT EACH CASE PINS DOWN. A Host that acknowledges is signalled by nothing. A Host that
 * does not is escalated until it is gone. And in both cases `stop()` resolves — the
 * guarantee the quit depends on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_PROTOCOL_VERSION, startHost } from '../apps/desktop/src/host-process.ts'

const cleanups = []

/** A fake runtime whose Host behaves as the body says. */
function fakeRuntime(body) {
  const runtime = mkdtempSync(join(tmpdir(), 'qialike-ladder-'))
  cleanups.push(runtime)
  const dir = join(runtime, 'node_modules', '@qialike', 'qialike-desktop-host', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), body)
  return runtime
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop(), { recursive: true, force: true })
})

const READY = `process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'ready', url: 'http://127.0.0.1:1/', injections: [] })`

/** Long enough that the escalation cannot finish first, short enough to stay fast. */
const FAST = { gracefulMs: 150, termMs: 100, exitMs: 1_000 }

async function start(runtime) {
  return await startHost({ runtime, profile: runtime, port: 0 })
}

describe('the shutdown ladder', () => {
  it('resolves without signalling a Host that acknowledges', async () => {
    const runtime = fakeRuntime(`
${READY}
process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    process.send({ protocol: ${String(HOST_PROTOCOL_VERSION)}, type: 'shutdown-complete' })
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
`)
    const host = await start(runtime)
    await host.stop({ timeouts: FAST })
    expect(host.child.signalCode).toBeNull()
    expect(host.child.exitCode).toBe(0)
  }, 30_000)

  it('escalates to a signal, and still resolves, when the Host never acknowledges', async () => {
    // THE CASE THAT MATTERS. This Host ignores the shutdown request entirely — it keeps
    // its event loop alive and never replies — so the only way `stop()` can return is by
    // killing it. A promise that resolves here is the whole reason a quit completes.
    const runtime = fakeRuntime(`
${READY}
process.on('message', () => { /* deliberately never acknowledges */ })
setInterval(() => {}, 1000)
`)
    const host = await start(runtime)
    await host.stop({ timeouts: FAST })
    // Gone, and gone by a signal we sent: not by anything the child decided.
    expect(host.child.signalCode === 'SIGTERM' || host.child.signalCode === 'SIGKILL').toBe(true)
  }, 30_000)

  it('throws instead of escalating when the caller cannot lose a flush', async () => {
    // An update and a relaunch need the Host's session log; a quit does not. The
    // distinction is the whole point of `requireGraceful`, and it is worth pinning down
    // that asking for it does NOT quietly fall back to killing the child.
    const runtime = fakeRuntime(`
${READY}
process.on('message', () => { /* never acknowledges */ })
setInterval(() => {}, 1000)
`)
    const host = await start(runtime)
    await expect(host.stop({ requireGraceful: true, timeouts: FAST })).rejects.toThrow(/did not acknowledge shutdown/u)
    // Still alive: the escalation must not have run.
    expect(host.child.signalCode).toBeNull()
    await host.stop({ timeouts: FAST })
  }, 30_000)

  it('returns immediately for a Host that is already gone', async () => {
    const runtime = fakeRuntime(`
${READY}
setTimeout(() => { process.exit(3) }, 50)
`)
    const host = await start(runtime)
    await new Promise((resolve) => { host.child.once('exit', resolve) })
    // No deadline can matter here, so a long one proves nothing was awaited.
    await host.stop({ timeouts: { gracefulMs: 30_000, termMs: 30_000, exitMs: 30_000 } })
    expect(host.child.exitCode).toBe(3)
  }, 30_000)
})
