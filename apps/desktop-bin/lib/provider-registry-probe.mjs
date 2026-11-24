/**
 * Boot the composed profile in-process and report its live LLM registry.
 *
 * NOT a test itself — a child program the catalogue test spawns. It runs in its
 * own process because `runProfile` installs a proxy from the environment, mounts
 * a real profile, and takes over process lifetime, none of which belongs in a
 * vitest worker.
 *
 * WHY THIS EXISTS AT ALL. Everything else in this repository checks the *build*:
 * that a row is in the patch, that a package was staged, that a file was copied.
 * None of those would have caught the failure this probe was written for — a row
 * whose module the profile resolver cannot reach. That produces a running Host, a
 * served document, and a green build, plus one line of stderr:
 * `warning: 1 entry did not activate`. The registry is the only place the
 * difference shows.
 *
 * The browser surface reads the same registry through a binary RPC, so the
 * settled context is read directly instead.
 *
 * It also reports what the served document carries — its title and the qialike
 * client ids in the boot graph — because those are the other two things a missing
 * or unmounted row costs silently: branding that never reaches the browser, and a
 * settings page that never appears.
 *
 * AND IT ANSWERS ONE QUESTION ONLY A BOOT CAN. `qialike-llm` registers model
 * discovery for its own namespace (M4 item 4). Whether that registration is *live* is
 * not visible in any file: an unregistered namespace throws `NO_DISCOVERY` at the
 * caller, which our settings route catches and turns into a silent fall-back to a bare
 * probe. So the probe asks the assembled runtime — `llm.discoverModels('qialike-llm',
 * …)` — against a `/models` endpoint it serves **itself**, on a loopback port. That
 * makes the check hermetic (no gateway, no network) and makes the interesting parts
 * observable: whether the call throws, whether the one-shot credential arrives as a
 * bearer header, and whether the ids come back in endpoint order.
 *
 * Usage: `node provider-registry-probe.mjs <runtimeDir>`; prints one JSON object.
 *
 * @module qialike-desktop/provider-registry-probe
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { catalogueExpectation } from './catalogue-expectation.mjs'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: provider-registry-probe.mjs <runtimeDir>\n')
  process.exit(2)
}

// A throwaway home: the probe must not read or write the developer's own
// `$DSH_HOME`, or a stale profile would decide what it reports.
const home = mkdtempSync(join(tmpdir(), 'qialike-registry-'))
process.env.DSH_HOME = home

try {
  const appBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
  const profileBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href)

  const profileDir = join(home, 'profiles', 'qialike-desktop')
  appBoot.initProfile(profileDir, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@qialike/qialike-desktop-app',
  ])
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)

  const running = await profileBoot.runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: 'qialike-desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', '0'],
  })

  const ctx = running.ctx
  const llm = ctx.get('llm')
  const official = await llm.listModels('deepseek-official').catch((error) => ({ error: error.message }))

  // What the document the browser receives actually says. Read through the
  // authenticated URL the shell itself redeems, so this is the same document and
  // the same credential the application uses.
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`
  // `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5: the
  // `webserver/entry-url` event and the package that published it were deleted, and
  // `packages/bundle/web-app` announces with this method itself. Calling it here keeps
  // the probe on its own call path rather than importing the code under test.
  const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const raw = handshake.headers.get('set-cookie')
  const cookie = raw.slice(0, raw.indexOf(';'))
  const html = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
  const title = /<title>([^<]*)<\/title>/u.exec(html)
  const clientIds = [...html.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((match) => match[1])

  // ── M4 item 4: is the registered discovery live? ──────────────────────────────
  //
  // Two calls, and the first is the one that would fail silently in production: an
  // unregistered namespace makes `discoverModels` throw, so "it answered at all" is
  // the assertion that the registration reached the assembled runtime.
  const discovery = {}
  try {
    discovery.unregisteredNamespace = await llm
      .discoverModels('no-such-namespace', { baseURL: 'http://127.0.0.1:1/v1' })
      .then(() => 'answered')
      .catch((error) => error.code ?? error.message)
  } catch (error) {
    discovery.unregisteredNamespace = `throw:${String(error?.message)}`
  }

  // The `/models` endpoint the draft branch talks to, served here so the check needs
  // no network and no gateway. It records the request headers, because "the one-shot
  // credential was actually sent" is the difference between this capability and the
  // CLI's probe — and it is invisible from the returned id list.
  const sent = []
  const gateway = createServer((request, response) => {
    sent.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'probe-model-b' }, { id: 'probe-model-a' }, { id: 'probe-model-b' }] }))
  })
  await new Promise((resolve) => { gateway.listen(0, '127.0.0.1', resolve) })
  const gatewayPort = gateway.address().port
  try {
    discovery.models = await llm.discoverModels('qialike-llm', {
      baseURL: `http://127.0.0.1:${String(gatewayPort)}/v1/`,
      apiKey: 'probe-one-shot-key',
    })
    discovery.requests = sent

    // ── And the same capability, reached the way the page reaches it ─────────────
    //
    // Over the real authenticated route, through the same handler the browser calls.
    // This is the link that would otherwise go untested: the settings API could ask a
    // namespace that nothing serves and still return a perfectly good answer from its
    // fall-back probe, so only the reported `source` distinguishes "the capability
    // answered" from "the capability was never consulted".
    const response = await fetch(`${origin}/api/qialike/providers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'discover',
        // No `route`, deliberately: a route would let the adapter answer, and this
        // check is about the draft path — the case the capability exists for.
        baseURL: `http://127.0.0.1:${String(gatewayPort)}/v1`,
      }),
    })
    discovery.route = { status: response.status, ...(await response.json()) }
  } catch (error) {
    discovery.error = error.code ?? error.message
  } finally {
    await new Promise((resolve) => { gateway.close(resolve) })
  }

  process.stdout.write(`__REPORT__${JSON.stringify({
    // The expectation, derived from the CLI's route tables. See catalogue-expectation.mjs for why this is
    // not a number written into the test.
    catalogue: await catalogueExpectation(runtimeDir),
    providers: llm.listProviders().map((provider) => provider.id).sort(),
    configurable: llm.listConfigurableProviders().map((entry) => ({
      provider: entry.provider,
      settingsNs: entry.settingsNs,
    })),
    officialModels: Array.isArray(official) ? official.map((model) => model.id) : [],
    settingsNamespaces: (ctx.get('settings')?.describe({ redactSecrets: true }) ?? []).map((row) => row.ns).sort(),
    documentTitle: title === null ? null : title[1],
    clientIds,
    discovery,
  })}\n`)

  await running.shutdown.shutdown(0)
  process.exit(0)
} finally {
  rmSync(home, { recursive: true, force: true })
}
