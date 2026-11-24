/**
 * Boot the composed profile and exercise the providers settings API end to end.
 *
 * NOT a test itself — a child program the settings test spawns, for the same
 * reason as the registry probe: `runProfile` mounts a real profile and takes over
 * process lifetime.
 *
 * It performs a whole edit session rather than one call, because the property
 * that matters is not that any single request answers 200 — it is that
 * `qialike.json` ends up correct and that the *live* adapter follows it. The
 * profile is booted against a throwaway `$DSH_HOME` seeded with a configuration
 * file containing a key this application does not know about, so the report also
 * proves the file is merged rather than replaced.
 *
 * Usage: `node providers-api-probe.mjs <runtimeDir>`; prints one JSON object.
 *
 * @module qialike-desktop/providers-api-probe
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { catalogueExpectation } from './catalogue-expectation.mjs'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  process.stderr.write('usage: providers-api-probe.mjs <runtimeDir>\n')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'qialike-providers-'))
process.env.DSH_HOME = home

/** The key this application must leave alone when it rewrites the file. */
const FOREIGN_KEY = 'sidebar_mode'
const SEEDED_ROUTE = 'seeded-gateway'
const ADDED_ROUTE = 'probe-gateway'

writeFileSync(join(home, 'qialike.json'), `${JSON.stringify({
  [FOREIGN_KEY]: 'off',
  // A gateway group switch, off. The group's own plugin withdraws its routes as
  // it mounts, through the same service this API drives — so this is the case
  // where the two controls meet, and the one that decides whether "enable" on a
  // group-disabled route tells the truth.
  azure: { enabled: false },
  llm: {
    providers: {
      [SEEDED_ROUTE]: { displayName: 'Seeded', baseURL: 'https://seeded.example/v1', apiKeyEnv: 'SEEDED_API_KEY' },
    },
  },
}, null, 2)}\n`)

const configPath = join(home, 'qialike.json')
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))

try {
  const appBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
  const profileBoot = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href)

  const profileDir = join(home, 'profiles', 'qialike-desktop')
  appBoot.initProfile(profileDir, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@qialike/qialike-desktop-app',
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
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`
  // `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5: the
  // `webserver/entry-url` event and the package that published it were deleted, and
  // `packages/bundle/web-app` announces with this method itself. Calling it here keeps
  // the probe on its own call path rather than importing the code under test.
  const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const raw = handshake.headers.get('set-cookie')
  const cookie = raw.slice(0, raw.indexOf(';'))

  const list = async () => {
    const response = await fetch(`${origin}/api/qialike/providers`, { headers: { cookie } })
    return { status: response.status, body: await response.json() }
  }
  const post = async (payload) => {
    const response = await fetch(`${origin}/api/qialike/providers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() }
  }
  const routeOf = (body, route) => body.routes.find((row) => row.route === route)

  const before = await list()
  // The group switch must have taken effect before anything else is measured.
  const groupDisabledAtBoot = !ctx.get('llm').listProviders().some((provider) => provider.id === 'azure')
  const groupRouteRow = routeOf(before.body, 'azure')
  const groupEnable = await post({ op: 'setEnabled', route: 'azure', enabled: true })
  const groupEnabledAfter = ctx.get('llm').listProviders().some((provider) => provider.id === 'azure')
  const saved = await post({
    op: 'save',
    route: ADDED_ROUTE,
    profile: {
      displayName: 'Probe Gateway',
      baseURL: 'https://probe.example/v1',
      api: 'anthropic-messages',
      apiKeyEnv: 'PROBE_API_KEY',
      models: ['probe-small', 'probe-large'],
    },
  })
  const afterSave = await list()
  const afterSaveConfig = readConfig()

  const registered = ctx.get('llm').listProviders().map((provider) => provider.id)
  const disabled = await post({ op: 'setEnabled', route: ADDED_ROUTE, enabled: false })
  const afterDisable = await list()
  const registeredAfterDisable = ctx.get('llm').listProviders().map((provider) => provider.id)
  // Read the file BEFORE the re-enable: capturing it afterwards would report the
  // state the next step produced, not the one this step did.
  const afterDisableConfig = readConfig()
  const reEnabled = await post({ op: 'setEnabled', route: ADDED_ROUTE, enabled: true })
  const registeredAfterEnable = ctx.get('llm').listProviders().map((provider) => provider.id)

  const rejected = await post({
    op: 'save',
    route: ADDED_ROUTE,
    profile: { baseURL: 'not-a-url' },
  })
  // ── the first-run flow, last so it does not disturb the steps above ────────
  //
  // Nothing in this probe sets a credential before here, so the boot report's
  // `firstRun` is the pristine one.
  const firstRunAtBoot = before.body.firstRun
  const defaultBefore = before.body.defaultModel
  // A value that cannot be mistaken for a real key: this writes to a throwaway
  // $DSH_HOME, and a plausible-looking string in a test is a liability.
  const keyed = await post({ op: 'setKey', route: 'deepseek-official', value: 'sk-probe-not-a-real-key' })
  const afterKey = await list()
  const setDefault = await post({ op: 'setDefaultModel', provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const afterDefault = await list()

  const removed = await post({ op: 'remove', route: ADDED_ROUTE })
  const afterRemove = await list()
  const afterRemoveConfig = readConfig()

  process.stdout.write(`__REPORT__${JSON.stringify({
    // What the catalogue should contain, derived from the CLI's own route tables rather than written down
    // here: a literal went stale the moment the CLI shipped another provider (see catalogue-expectation.mjs).
    catalogue: await catalogueExpectation(runtimeDir),
    // Baseline: the seeded file was read, and its unknown key rode along.
    before: {
      status: before.status,
      total: before.body.routes.length,
      // The route of the product's own gateway, which the page lists before it is configured
      // so its key can be entered. Reported so the client's rule is pinned to a fact the Host
      // states rather than to a name either side might restate.
      // BOTH DEPLOYMENTS. Bee ships as `.com` and mainland rows from CLI 0.11.4 behind one
      // switch; a probe that reported one name could not tell whether the mainland row was
      // leaking into the list while the switch read "off".
      beeRoutes: before.body.beeRoutes,
      beeRows: (before.body.beeRoutes ?? []).map((route) => {
        const row = before.body.routes.find((entry) => entry.route === route)
        return { route, enabled: row?.enabled, keyConfigured: row?.keyConfigured }
      }),
      seeded: routeOf(before.body, SEEDED_ROUTE),
      foreignKey: readConfig()[FOREIGN_KEY],
    },
    save: {
      status: saved.status,
      ok: saved.body.ok,
      remounted: saved.body.remounted,
      listed: routeOf(afterSave.body, ADDED_ROUTE),
      onDisk: afterSaveConfig.llm.providers[ADDED_ROUTE],
      foreignKeyKept: afterSaveConfig[FOREIGN_KEY],
      seededKept: afterSaveConfig.llm.providers[SEEDED_ROUTE] !== undefined,
      registered: registered.includes(ADDED_ROUTE),
    },
    disable: {
      ok: disabled.body.ok,
      enabledInList: routeOf(afterDisable.body, ADDED_ROUTE)?.enabled,
      onDisk: afterDisableConfig.hidden_providers,
      // The point of driving `hideRoutes` rather than only writing the file: the
      // ADAPTER must stop serving the route, or the model picker still offers it.
      stillRegistered: registeredAfterDisable.includes(ADDED_ROUTE),
    },
    enable: {
      ok: reEnabled.body.ok,
      registeredAgain: registeredAfterEnable.includes(ADDED_ROUTE),
      stillHiddenOnDisk: (readConfig().hidden_providers ?? []).includes(ADDED_ROUTE),
    },
    group: {
      disabledAtBoot: groupDisabledAtBoot,
      rowEnabled: groupRouteRow?.enabled,
      rowGroup: groupRouteRow?.group,
      rowGroupDisabled: groupRouteRow?.groupDisabled,
      // Refused, with the file key named: the group switch outranks this API, and
      // an "ok" here would be a success the page cannot verify.
      enableOk: groupEnable.body.ok,
      enableMessage: groupEnable.body.message,
      enabledAfter: groupEnabledAfter,
    },
    welcome: {
      firstRunAtBoot,
      firstRunAfterKey: afterKey.body.firstRun,
      keyOk: keyed.body.ok,
      keyRef: keyed.body.apiKeyEnv,
      keyConfigured: routeOf(afterKey.body, 'deepseek-official')?.keyConfigured,
      defaultBefore,
      setDefaultOk: setDefault.body.ok,
      defaultAfter: afterDefault.body.defaultModel,
    },
    validation: { ok: rejected.body.ok, message: rejected.body.message },
    remove: {
      ok: removed.body.ok,
      goneFromList: routeOf(afterRemove.body, ADDED_ROUTE) === undefined,
      goneFromDisk: afterRemoveConfig.llm.providers[ADDED_ROUTE] === undefined,
      routeNoLongerHidden: !(afterRemoveConfig.hidden_providers ?? []).includes(ADDED_ROUTE),
      seededKept: afterRemoveConfig.llm.providers[SEEDED_ROUTE] !== undefined,
    },
  })}\n`)

  await running.shutdown.shutdown(0)
  process.exit(0)
} finally {
  rmSync(home, { recursive: true, force: true })
}
