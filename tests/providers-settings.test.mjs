/**
 * The providers settings API (`qialike.json` as the source of truth).
 *
 * Two of this module's three load-bearing behaviours were established by
 * measurement, not by reading, because the obvious implementation of each is
 * wrong in a way that looks fine:
 *
 *   · Restarting the provider row. `entry.update({}, false, true)` reads as "force
 *     a restart with unchanged options" and is a **no-op**: the Loader restarts a
 *     fiber only when the changed-key set contains `config`, and an empty set
 *     never gets there. The working call is the fiber update that `_patchContext`
 *     itself performs. A wrong choice here is invisible at runtime — the save
 *     succeeds, the file is right, and the adapter keeps serving the old routes.
 *   · Withdrawing a route. `hidden_providers` in `qialike.json` is read by the
 *     CLI's *interface*, not its adapter, so writing it changes what the page
 *     shows and nothing about what the model layer serves. `hideRoutes()` on the
 *     `tuiLlmTemplates` service is what re-registers the adapter.
 *
 * Both produce a running, plausible-looking application. The probe therefore
 * asserts the live registry at each step, and this suite keeps the probe.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'providers-api-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** Boot once for every assertion: the probe performs the whole edit session. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the settings probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the providers settings API', () => {
  it('reads the shared configuration file and lists the whole catalogue', async () => {
    const { report } = await probe()
    expect(report.before.status).toBe(200)
    // The builtin + EVERY core template + the gateway-group routes + the route the probe seeded. Derived
    // from the CLI's own tables rather than written down here: this was the literal 63, and it went stale
    // the moment the CLI shipped another provider. See catalogue-expectation.mjs.
    //
    // THIS PAGE COUNTS ONE MORE ROW THAN THE PROFILE MOUNTS, and that is the point of the `hiddenBySwitch`
    // term: the CLI keeps the template row for a provider that ships off (QiaLike Bee) so the switch has
    // something to turn back on, and settings is built from that template list. The registry test asserts
    // the route is absent from the *mount*; this one asserts the row is still *offered*. Counting only
    // `catalogue.total` here would say the row had been deleted, which is the opposite of what happened.
    //
    // The gateway routes matter here for a reason the registry test cannot see: they are registered by
    // their own rows, so a page built from the core template list alone would omit all seventeen —
    // selectable in the chat composer, absent from settings, and therefore impossible to turn off.
    expect(report.before.total).toBe(report.catalogue.total + report.catalogue.hiddenBySwitch.length + 1)
    expect(report.before.seeded.route).toBe('seeded-gateway')
    expect(report.before.seeded.source).toBe('configured')
  }, 300_000)

  it('names BOTH deployments of its own gateway, which one switch governs', async () => {
    // CLI 0.11.4 ships Bee twice — `.com` and mainland — behind a single `bee.enabled`. The Host
    // reports the list rather than one name because the page's rule is "hide these while the
    // switch is off", and a rule written against one of two names hides half of it. Measured on
    // the CLI: `if (!resolveBeeEnabled()) for (const route of QIALIKE_BEE_ROUTES) hiddenRoutes.add`.
    const { report } = await probe()
    expect(Array.isArray(report.before.beeRoutes)).toBe(true)
    expect(report.before.beeRoutes).toEqual(['qialike-bee', 'qialike-bee-cn'])
    // Both are off by default, which is the product decision the CLI recorded on 2026-10-25:
    // "Bee still ships OFF. Its gateways serve, but the service is closed to the public."
    for (const route of report.before.beeRoutes) {
      const row = report.before.routes?.find((r) => r.route === route)
      if (row !== undefined) expect(row.enabled, `${route} shipped enabled`).toBe(false)
    }
  })

  it('names its own gateway, and reports it switched off until the user turns it on', async () => {
    // The page lists what is configured plus this one route. It has to come from the Host,
    // because the name is the CLI's constant (`QIALIKE_BEE_ROUTE`) and a second copy of it in
    // the browser would be a second place to change. And it has to arrive switched OFF: the
    // gateway ships as a beta, so a default install shows no provider rows at all rather than
    // offering a route nobody asked for.
    const { report } = await probe()
    expect(report.before.beeRoutes).toEqual(['qialike-bee', 'qialike-bee-cn'])
    for (const row of report.before.beeRows) {
      expect(row.enabled, `${row.route} shipped enabled`).toBe(false)
      expect(row.keyConfigured, `${row.route} reported a key by default`).toBe(false)
    }
  })

  it('merges rather than replaces, keeping keys this application does not own', async () => {
    // The file is shared with the CLI, which stores many keys here. A writer that
    // serialized only its own section would silently delete the user's settings —
    // and the loss would surface in the terminal client, not here.
    const { report } = await probe()
    expect(report.before.foreignKey).toBe('off')
    expect(report.save.foreignKeyKept).toBe('off')
    expect(report.save.seededKept).toBe(true)
    expect(report.remove.seededKept).toBe(true)
  }, 300_000)

  it('saves a provider and reloads the running adapter', async () => {
    const { report } = await probe()
    expect(report.save.ok).toBe(true)
    expect(report.save.remounted).toBe(true)
    expect(report.save.onDisk.baseURL).toBe('https://probe.example/v1')
    expect(report.save.onDisk.api).toBe('anthropic-messages')
    expect(report.save.onDisk.models).toHaveLength(2)
    expect(report.save.listed.modelCount).toBe(2)
    // The assertion the no-op remount would fail: the model layer must actually
    // be serving the new route, not merely have it on disk.
    expect(report.save.registered).toBe(true)
  }, 300_000)

  it('withdraws a disabled route from the adapter, not just from the page', async () => {
    const { report } = await probe()
    expect(report.disable.ok).toBe(true)
    expect(report.disable.onDisk).toEqual(['probe-gateway'])
    expect(report.disable.enabledInList).toBe(false)
    // The whole reason `hideRoutes` is called instead of only writing the key.
    expect(report.disable.stillRegistered).toBe(false)
  }, 300_000)

  it('brings a re-enabled route back', async () => {
    // `hideRoutes` only ever adds to the hidden set, so enabling cannot be its
    // mirror image; it needs the remount, and the persisted set has to agree.
    const { report } = await probe()
    expect(report.enable.ok).toBe(true)
    expect(report.enable.registeredAgain).toBe(true)
    expect(report.enable.stillHiddenOnDisk).toBe(false)
  }, 300_000)

  it('shows a gateway route and names the group that holds it', async () => {
    const { report } = await probe()
    expect(report.group.rowGroup).toBe('azure')
    expect(report.group.rowGroupDisabled).toBe(true)
    expect(report.group.rowEnabled).toBe(false)
  }, 300_000)

  it('honours a group switch at boot', async () => {
    // `azure: { enabled: false }` in the shared file, applied by the azure row's
    // own plugin as it mounts — a second control over the same routes, and the one
    // that outranks this API.
    const { report } = await probe()
    expect(report.group.disabledAtBoot).toBe(true)
  }, 300_000)

  it('refuses to enable a route its group switch holds off, naming the file key', async () => {
    // The failure this replaces: answering `ok: true` for an enable that does not
    // happen. The group's plugin re-reads its switch on every service replacement,
    // so clearing this row's own flag cannot bring the route back — and the page
    // has no way to tell a real success from that one.
    const { report } = await probe()
    expect(report.group.enableOk).toBe(false)
    expect(report.group.enableMessage).toContain('azure')
    expect(report.group.enableMessage).toContain('enabled')
    expect(report.group.enabledAfter).toBe(false)
  }, 300_000)

  it('reports first run from the credential store, not from a seen-it flag', async () => {
    // Derived from the store so that clearing every key brings the page back and
    // configuring one elsewhere keeps it away. A flag would leave someone with no
    // keys looking at an application that appears ready and cannot answer.
    const { report } = await probe()
    expect(report.welcome.firstRunAtBoot).toBe(true)
  }, 300_000)

  it('stores a provider key through the credentials service', async () => {
    const { report } = await probe()
    expect(report.welcome.keyOk).toBe(true)
    // The reference is the profile's own, resolved on the host rather than trusted
    // from the caller, so the key and the profile that reads it agree.
    expect(report.welcome.keyRef).toBe('DEEPSEEK_API_KEY')
    expect(report.welcome.keyConfigured).toBe(true)
    // And the fact that closes the first-run page is the same one it opened on.
    expect(report.welcome.firstRunAfterKey).toBe(false)
  }, 300_000)

  it('sets the default model the profile will start sessions with', async () => {
    // Written to the harness settings document, not to `qialike.json`: this is a
    // preference of this surface's profile, unlike the provider catalogue the two
    // products share.
    const { report } = await probe()
    expect(report.welcome.defaultBefore.provider).toBe('deepseek-official')
    expect(report.welcome.setDefaultOk).toBe(true)
    expect(report.welcome.defaultAfter.model).toBe('deepseek-v4-pro')
  }, 300_000)

  it('refuses a profile the CLI could not load, without writing it', async () => {
    const { report } = await probe()
    expect(report.validation.ok).toBe(false)
    expect(report.validation.message).toContain('baseURL')
  }, 300_000)

  it('removes a provider from the file and from the adapter', async () => {
    const { report } = await probe()
    expect(report.remove.ok).toBe(true)
    expect(report.remove.goneFromList).toBe(true)
    expect(report.remove.goneFromDisk).toBe(true)
    expect(report.remove.routeNoLongerHidden).toBe(true)
  }, 300_000)
})

describe.skipIf(!assembled)('the client half reaches the browser', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'package.json'), 'utf8'),
  )

  it('declares dsh.client with the web platform', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('exports a ./client bundle, which the scanner requires of any dsh.client package', () => {
    expect(typeof manifest.exports['./client']?.default).toBe('string')
  })

  it('names the slot contract owner as a dependency edge, per shipped convention', () => {
    // `inject` is informational (preflight display, HMR diffing); the real
    // ordering comes from `ctx.slots.inject`. It still has to name the package
    // that declares the slot, not the one that declares it at runtime.
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
  })

  it('registers under the row id the boot graph carries, which is the package name', () => {
    // The module loader keys the registered factory by this id and fails the row
    // with "loaded without registering <id>" when the two disagree.
    const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'), 'utf8')
    const id = /id:\s*'([^']+)'/u.exec(bundle)
    expect(id?.[1]).toBe(manifest.name)
  })

  it('offers a search box over the provider list', () => {
    // The page lists 62 rows — the builtin, every template and the gateway groups — and the
    // CLI's own picker has a search field for the same list. This pins that the box exists,
    // that it is labelled for assistive technology, and that it filters on the three things
    // a person remembers: what the provider is called, the config's route id, and the
    // endpoint. A filter that matched only `route` would look broken to anyone typing the
    // display name they see on screen.
    const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'), 'utf8')
    expect(bundle).toContain("type: 'search'")
    expect(bundle).toContain("'aria-label': t('search')")
    expect(bundle).toMatch(/\$\{row\.displayName\} \$\{row\.route\} \$\{row\.baseURL\}/u)
    // And it says so when nothing matches, rather than rendering an empty list that reads as
    // a failed load.
    expect(bundle).toContain("t('searchEmpty')")
  })

  it('lists what is configured plus the product gateway, and nothing else', () => {
    // WHY THIS IS A STATIC ASSERTION. The list rule is a predicate over the Host's rows, and
    // the row shape is fixed by the API tests above. What could regress silently is the rule
    // itself — a page that printed all 63 routes again would still pass every API test and
    // still be the thing this replaced: a wall of mostly-empty rows where the question
    // "which providers do I have?" has to be answered by reading.
    //
    // The two survivors are pinned separately because they come from different reasons: a set
    // credential, and the product's own gateway while it is switched on.
    const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'), 'utf8')
    // Two separate rules, and the order matters: the gateway is decided by its switch ALONE,
    // so a key under a switched-off gateway does not bring it back. That is the CLI's
    // behaviour — the route is withdrawn from the registry, not merely filtered — and a row
    // here for a route the model layer is not serving would be a row no request can use.
    // AND THE GATEWAY IS A LIST, NOT A NAME. CLI 0.11.4 renamed `qialike` to `qialike-bee` and
    // added `qialike-bee-cn`; both sit behind one switch, and the CLI hides them together. A page
    // that matched a single name would leave the mainland row on screen while the switch read
    // "off" — the half-hidden state the CLI's own commit calls out by name.
    expect(bundle).toContain('isBeeRoute')
    expect(bundle).toMatch(/bee\.includes\(route\)/)
    expect(bundle).toMatch(/if \(isBeeRoute\(row\.route\)\) return row\.enabled === true/)
    expect(bundle).toMatch(/return row\.keyConfigured === true/)
    // ...and the switched-off gateway is not offered by the catalogue either. Hiding it from
    // the list alone would leave a way to save a profile under a route the CLI refuses to use.
    expect(bundle).toMatch(/all\.filter\(\(row\) => !\(isBeeRoute\(row\.route\) && row\.enabled !== true\)\)/)
    // And the full catalogue stays reachable, or nothing could ever be added.
    expect(bundle).toContain("t('addProviderFromCatalogue')")
    expect(bundle).toContain("t('addCustomProvider')")
  })

  it('requests the app route document-relative', () => {
    // The served document carries `<base href="./">`, so a root-absolute literal
    // resolves against the origin rather than the document and breaks under a
    // mount prefix. The harness spells every browser-side route this way.
    const bundle = readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'), 'utf8')
    expect(bundle).toContain("const API = 'api/qialike/providers'")
    expect(bundle).not.toMatch(/['"]\/api\/qialike\/providers['"]/u)
  })
})
