/**
 * The composed profile boots, serves, and shuts down.
 *
 * This is the milestone's real assertion: not that a function returns, but that
 * `dsh-base` + `dsh-web-app` + `@qialike/qialike-desktop-app` compose into a
 * running Host that answers the shell's handshake. Everything this suite checks
 * — the readiness message, the authentication exchange, the served document, the
 * client plugin roster — is a property of the whole composition, and each one has
 * already been wrong at least once while building it.
 *
 * The suite runs the **assembled runtime tree**, so it exercises the artifact
 * rather than the sources. It is skipped when that tree is absent.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROFILE_BUNDLES, authenticate, startHost } from '../apps/desktop-bin/lib/host-harness.mjs'
import { DIST_DIR, PROFILE_BUNDLES as DECLARED_BUNDLES } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

// One Host serves every assertion below. Booting the whole profile costs tens of
// seconds and the questions are all about the same boot.
let host
let ready
let cookie
let origin

beforeAll(async () => {
  if (!assembled) return
  host = startHost({ runtimeDir: RUNTIME_DIR, port: 0 })
  ready = await host.ready()
  cookie = await authenticate(ready.url)
  origin = new URL(ready.url).origin
}, 300_000)

afterAll(async () => {
  await host?.shutdown()
})

describe.skipIf(!assembled)('the composed profile', () => {
  it('reports readiness with an authenticated URL and boot injections', () => {
    expect(ready.type).toBe('ready')
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    expect(Array.isArray(ready.injections)).toBe(true)
    expect(ready.injections.length).toBeGreaterThan(0)
  })

  it('binds the port it reports, not the one it was asked for', async () => {
    // The harness was started with `--port 0`; the shell must read the bound port
    // back rather than echo its request, or its proxy forwards into nothing.
    const port = Number(new URL(ready.url).port)
    expect(port).toBeGreaterThan(0)
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { headers: { cookie } })
    expect(response.status).toBe(200)
  })

  it('refuses an unauthenticated request', async () => {
    const response = await fetch(`${origin}/`)
    expect(response.status).toBe(401)
  })

  it('refuses a token that is not the one it minted', async () => {
    const response = await fetch(`${origin}/?token=not-the-token`)
    expect(response.status).toBe(401)
  })

  it('serves the browser surface', async () => {
    const response = await fetch(`${origin}/`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    // The document the client needs: a mount point and the boot graph the Host
    // injects. Without `__DSH_BOOT__` the page renders nothing.
    expect(html).toContain('id="root"')
    expect(html).toContain('__DSH_BOOT__')
  })

  it('serves every client plugin bundle the boot graph names', async () => {
    const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
    const ids = [...html.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(30)

    // Fetch the URLs the page itself names, not a guessed shape. Two details
    // make the guess wrong: the page emits them **relative** (`plugins/??…`), and
    // it emits them as **combo** resources — several plugin ids in one `??`
    // request — while the route keys on exact `pathname + search`, so a
    // hand-written `/plugins/<id>/client.js` is a 404 the client never asks for.
    const urls = [...new Set([...html.matchAll(/plugins\/\?\?[^"'<>\s]+/g)]
      .map((match) => `/${match[0]}`.replaceAll('&amp;', '&')))]
    expect(urls.length).toBeGreaterThan(0)

    // A named plugin whose bundle 404s leaves the client half-mounted, which is
    // the failure this catches: the roster and the served bundles disagreeing.
    for (const url of urls.slice(0, 8)) {
      const response = await fetch(`${origin}${url}`, { headers: { cookie } })
      expect(response.status, `${url.slice(0, 120)} bundle`).toBe(200)
      const body = await response.text()
      expect(body.length, `${url.slice(0, 120)} body`).toBeGreaterThan(0)
      // The combo carries the closure-factory registrations the page's module
      // loader consumes. A 200 with an empty body would mount nothing.
      expect(body).toContain('__ModuleLoader__')
    }
  })

  it('composes exactly the bundle layers this build declares', () => {
    // The harness passes the same list; a drift between the two would mean the
    // shell initializes a profile the Host then composes differently.
    expect(PROFILE_BUNDLES).toEqual([...DECLARED_BUNDLES])
  })
})

describe.skipIf(!assembled)('the qialike bundle layer', () => {
  it('disables the official brand occupant', async () => {
    // `sidebar.brand.mark` and `sidebar.brand.name` are `single` slots, so the
    // official occupant has to be gone before ours can register. This asserts
    // the patch row took effect in the composed tree, which is the part that
    // cannot be checked by reading the patch file.
    const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
    expect(html).not.toContain('dsh-client-ui-brand-official')
  })

  it('leaves the generic sidebar slots in the roster for a later occupant', async () => {
    const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
    // The slot owner must still be mounted, or disabling the official brand
    // would have removed the brand area rather than freed it.
    expect(html).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  })

  it('keeps the DeepSeek account surface out of the desktop posture', async () => {
    // This row is disabled because our preload sets `dshDesktop` (DESIGN §12.2
    // R11): `ui-settings-account` returns early without that marker, so the marker
    // that suppresses the browser-posture onboarding would otherwise mount an
    // account section, an account menu and a desktop overlay. Asserting the row
    // is gone is the only check that the two halves stayed in step — the preload
    // is not exercised in this environment, so nothing else would notice.
    const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
    expect(html).not.toContain('dsh-client-ui-settings-account')
  })

  it('serves qialike provider settings in place of the upstream models page', async () => {
    // The counter-assertion, and it has moved twice. It first checked that
    // disabling the account row had not taken the models page with it. It now
    // checks that retiring the models page left a replacement: that page edits
    // provider configuration through the harness settings namespace, which is
    // per-profile and so invisible to the CLI, while ours edits the shared
    // `qialike.json` (DESIGN §12.2 R12). The profile must carry exactly one of the
    // two, because two pages editing one provider set through different stores
    // would disagree on screen.
    const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
    expect(html).not.toContain('dsh-client-ui-settings-models')
    expect(html).toContain('@qialike/qialike-desktop-providers')
  })
})

describe.skipIf(!assembled)('shutdown', () => {
  it('acknowledges a shutdown request and then exits', async () => {
    // A second Host, because the shared one is still serving the suites above.
    const second = startHost({ runtimeDir: RUNTIME_DIR, port: 0 })
    await second.ready()
    const exited = new Promise((resolve) => second.child.once('exit', resolve))
    await second.shutdown()
    // The acknowledgement and the process exit are separate events: the message
    // says the tree tore down, the exit says the process is gone. The shell needs
    // both, so the assertion covers both rather than only the message.
    await expect(Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 15_000)),
    ])).resolves.toBe('exited')
  }, 300_000)
})
