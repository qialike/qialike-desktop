/**
 * The boot gate: the one thing this shell still injects into the page.
 *
 * SIXTY LINES OF INTERPRETER BECAME ONE LINE, and this file is mostly about that. The
 * shell used to inject a hand-written applier for the Host's boot rows — mirroring
 * `applyIndexInjections` (`@deepseek-ai/dsh-client-web`) row for row, because an inline
 * classic script cannot import it, and waiting on `DOMContentLoaded` because one row
 * targets `document.body`. Every line of that was necessary only because the preload
 * exposed its bridge under a name the harness's own browser entry does not look for.
 *
 * That entry (`apps/web/src/main.ts`) contains a desktop branch that fetches the rows,
 * applies them through the **real** interpreter, sets `__DSH_TRANSPORT__` and resolves the
 * gate — and it runs when it finds a global named `dshDesktopBoot`, which is now the name
 * this shell uses. So the shell's remaining job is the one thing the entry cannot do for
 * itself: create the gate it reads.
 *
 * WHAT THAT MEANS FOR THESE TESTS. The old suite executed the injected script against a
 * stub DOM and asserted the row interpreter's behaviour: order, DOM-ready waiting,
 * unknown-row rejection, failure reporting. None of that is this shell's code any more, so
 * asserting it here would be testing a fixture. What is asserted instead is the *contract
 * with the entry*, in four parts:
 *
 *   1. The gate exists, before the page's own module script, and is a valid classic script.
 *      A gate that is absent or malformed is total and quiet: the entry throws
 *      `desktop web: boot readiness is missing`, the loading page stays, and nothing says
 *      why.
 *   2. The gate's rejection is pre-handled, which is the one deliberate difference from
 *      upstream's version of the line.
 *   3. The bridge name the preload installs is the name the entry looks for. A preload
 *      cannot import the constant, so the string is duplicated and this is what keeps the
 *      copies in step — and getting it wrong is precisely the defect that cost this product
 *      its live connection.
 *   4. **The shell does not apply boot rows at all.** The absence is the assertion: if a row
 *      applier reappears in the served document, the harness's branch has been bypassed
 *      again and the duplication is back.
 *
 * The rendering itself still needs a real desktop, and the end-to-end proof that the
 * entry's branch actually ran is in `apps/desktop-bin/e2e.mjs` — it reads
 * `__DSH_TRANSPORT__` out of a live window.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRIDGE_GLOBAL } from '../apps/desktop/src/ipc.ts'
import { APP_ORIGIN, SHELL_ORIGIN, serveStatic } from '../apps/desktop/src/web-document.ts'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-boot-'))
  writeFileSync(join(root, 'index.html'), [
    '<!doctype html><html><head>',
    '<title>fixture</title>',
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Read the injected script out of the document the shell actually serves.
 *
 * Deliberately not read from the source file: the splice is part of the contract — it has
 * to land before the page's own module script — so a test that grabbed the constant could
 * pass while the served document never carried it.
 */
async function servedGate() {
  const response = await serveStatic(new Request(`${APP_ORIGIN}/`), root, { gateBoot: true })
  const html = await response.text()
  const headAt = html.indexOf('<head>')
  const open = html.indexOf('<script>', headAt)
  const close = html.indexOf('</script>', open)
  expect(open, 'the served document carries no gate').toBeGreaterThan(headAt)
  return { html, headAt, open, script: html.slice(open + '<script>'.length, close) }
}

/** Execute the gate in a context with only `globalThis`, and report what it left behind. */
function runGate(script) {
  const context = createContext({})
  new Script(script).runInContext(context)
  return context
}

describe('the served document', () => {
  it('splices the gate before the page names its own scripts', async () => {
    // Ordering is not actually load-bearing — the page's entry is a module script, so it is
    // deferred until after parsing — but the gate must be in the document *before* the
    // browser reaches that script, and asserting the position is what keeps a future
    // "optimisation" from moving it after.
    const { html, headAt, open } = await servedGate()
    const moduleAt = html.indexOf('<script type="module"')
    expect(open).toBeGreaterThan(headAt)
    expect(open).toBeLessThan(moduleAt)
  })

  it('carries exactly one injected script, so nothing is smuggled in beside the gate', async () => {
    // The count is the assertion, not the content: this shell's whole remaining script
    // surface is one line, and a second one appearing here is the duplication coming back.
    const { html } = await servedGate()
    const scripts = [...html.matchAll(/<script(?![^>]*type="module")[^>]*>/gu)]
    expect(scripts).toHaveLength(1)
  })

  it('is a syntactically valid classic script', async () => {
    const { script } = await servedGate()
    expect(() => new Script(script)).not.toThrow()
  })

  it('is absent from the shell’s own documents', async () => {
    // The shell's loading and error pages are static documents whose job is to render when
    // the rest of the application cannot. They have no client to wait for anything and no
    // Host to fetch rows from, so a gate there would be a promise nobody settles.
    const plain = await (await serveStatic(new Request(`${SHELL_ORIGIN}/`), root)).text()
    expect(plain).not.toContain('__DSH_BOOT_READY__')
  })
})

describe('the gate', () => {
  it('installs a deferred the entry can await and resolve', async () => {
    // The entry reads this global and, when the bridge is present, calls `.resolve()` on the
    // promise after applying the rows. Both halves are asserted because the entry needs both:
    // a global without `resolve` throws inside its branch, which is the failure mode that
    // looks like "the page never finishes loading".
    const { script } = await servedGate()
    const context = runGate(script)
    const gate = context.__DSH_BOOT_READY__
    expect(gate, 'the gate global was not installed').toBeDefined()
    expect(typeof gate.resolve).toBe('function')
    expect(typeof gate.reject).toBe('function')
    // `typeof .then === 'function'` rather than `instanceof Promise`: the vm context has its
    // own realm and its own Promise constructor, so an identity check across the boundary
    // fails for a correct gate.
    expect(typeof gate.promise.then).toBe('function')
    // Unsettled on arrival: the entry is what settles it, and a gate that arrived resolved
    // would let the client start before the rows existed.
    let settled = false
    void gate.promise.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await gate.promise
    expect(settled).toBe(true)
  })

  it('marks a rejection handled without consuming it', async () => {
    // The entry rejects this deferred when the rows cannot be fetched, and the client only
    // awaits it once its own bundle has loaded — strictly later. Rejecting a promise nobody
    // is awaiting yet is reported as an unhandled rejection, so the gate attaches a no-op
    // catch. The client must still see the rejection, which is the second assertion: a
    // `.catch()` that swallowed it would leave the client waiting forever on a promise that
    // had already failed.
    const { script } = await servedGate()
    const context = runGate(script)
    const rejection = new Error('the rows could not be fetched')
    context.__DSH_BOOT_READY__.reject(rejection)
    await expect(context.__DSH_BOOT_READY__.promise).rejects.toThrow('the rows could not be fetched')
  })

  it('does not apply boot rows, because the harness’s entry does', async () => {
    // THE ASSERTION THAT THE DUPLICATION IS GONE. The interpreter was deleted, and a
    // deletion is only durable if something fails when it comes back. These are the row
    // kinds it handled (`applyIndexInjections` in `@deepseek-ai/dsh-client-web`), and none
    // of them may be recognised by anything the shell injects.
    const { script } = await servedGate()
    // Matched on the dispatch the interpreter performed, not on bare words: a row kind like
    // `global` also appears inside `globalThis`, and a substring check that loose would fail
    // on a correct one-line gate.
    for (const marker of ['row.kind', 'injections', 'script-src', 'unknown index injection row']) {
      expect(script, `the gate mentions "${marker}", so a row applier has reappeared`).not.toContain(marker)
    }
    // And the module the agent of those rows lives in is not reached from here either.
    expect(script).not.toContain('applyIndexInjections')
    expect(script).not.toContain('__DSH_TRANSPORT__')
    expect(script).not.toContain('DOMContentLoaded')
  })
})

describe('the bridge name', () => {
  it('is the name the harness’s browser entry looks for', () => {
    // THE DEFECT THIS WHOLE FILE EXISTS FOR, ASSERTED AS A NAME. The entry's desktop branch
    // — the only code that sets `__DSH_TRANSPORT__` for a shell-owned page — is gated on
    // finding this global. Under any other name it is dormant, the stream carrier falls back
    // to `document.baseURI`, and the client retries forever behind a window that renders
    // correctly and logs nothing.
    expect(BRIDGE_GLOBAL).toBe('dshDesktopBoot')
  })

  it('is the string the preload actually installs, which cannot import it', () => {
    // A sandboxed preload resolves only `electron`, `events`, `timers` and `url`, so it
    // cannot import the constant and the string is duplicated there. This is the check that
    // keeps the two copies from drifting — and it is exactly the drift that would be silent,
    // because a mismatch produces no error anywhere.
    const preload = readFileSync(join(ROOT, 'apps', 'desktop', 'preload', 'preload.cjs'), 'utf8')
    expect(preload).toContain(`exposeInMainWorld('${BRIDGE_GLOBAL}'`)
    // The old name must be gone from the tree, not merely unused: a stale expose would leave
    // two globals, one of which is a bridge nothing reads.
    expect(preload).not.toContain('qialikeDesktopBoot')
  })

  it('is not the desktop marker, which upstream plugins read', () => {
    // Two globals with different audiences. `dshDesktop` is the harness's marker and adding
    // a member to it changes how upstream plugins behave — the shell deliberately exposes
    // only `protocolVersion` there. The bridge is this shell's contract with the client
    // entry, and conflating them would make every bridge change a behaviour change upstream.
    expect(BRIDGE_GLOBAL).not.toBe('dshDesktop')
    const preload = readFileSync(join(ROOT, 'apps', 'desktop', 'preload', 'preload.cjs'), 'utf8')
    expect(preload).toContain("exposeInMainWorld('dshDesktop'")
  })
})
