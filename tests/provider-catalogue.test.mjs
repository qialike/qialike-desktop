/**
 * The provider catalogue the composed profile actually mounts (M4 item 1).
 *
 * The failure this suite exists for is not a broken build. A row whose module the
 * profile resolver cannot reach still composes, still boots, still serves the
 * browser surface, and reports one line to stderr — `warning: 1 entry did not
 * activate` — which is easy to read past. What changes is the registry: the
 * profile ends up with **no** model layer at all, and the Models page renders an
 * empty catalogue.
 *
 * The row that failed that way named a subpath of its own bundle. The resolver
 * removes bundle packages from its table (`collectProfileScopePackages` in
 * `packages/boot/app-boot/src/profile.ts`), so `@qialike/qialike-desktop-app/llm`
 * could never resolve; the rows now name a sibling package. These tests hold that
 * shape in place, because the next row added is the one likely to repeat it.
 *
 * The probe boots the real profile in a child process, so it runs against the
 * assembled runtime tree and is skipped when that tree is absent.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'provider-registry-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** Boot once for every assertion below: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, DSH_HOME: undefined },
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
        reject(new Error(`the registry probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the mounted provider catalogue', () => {
  it('activates every entry, so no row silently failed to resolve', async () => {
    // The assertion that would have caught the bundle-subpath failure. Any row the
    // resolver cannot reach is reported here rather than passing as a smaller
    // catalogue.
    const { stderr } = await probe()
    expect(stderr).not.toMatch(/did not activate/u)
    expect(stderr).not.toMatch(/failed to import/u)
  }, 300_000)

  it('registers everything that ships on: the core templates minus the switched-off row, the builtin, and four gateway groups', async () => {
    const { report } = await probe()
    const { catalogue, providers } = report
    // THE EXPECTATION IS DERIVED, NOT WRITTEN DOWN. It used to be the literal 62 with a comment explaining
    // the composition as "44 core templates + the CLI's own `deepseek-official` + 17 group routes" — and
    // when the CLI shipped another provider the literal was one behind and this suite went red over a
    // correct change. `catalogue-expectation.mjs` derives the same numbers from the tables that decide them.
    //
    // Every one of the four groups is a separate patch row, so the total is the assertion that all four
    // mounted — a row that failed to resolve costs its routes and nothing else. The per-group names are
    // checked too, by the test below, rather than the total alone.
    expect(providers).toHaveLength(catalogue.total)
    // THE ROWS THAT SHIP OFF ARE ASSERTED ABSENT, not merely subtracted from the total. QiaLike Bee is
    // hidden while its gateway is not serving (`c426202` in the CLI), and "the total is one lower" would
    // also be true if the row had been dropped from the templates altogether — which is a different thing
    // and would mean the switch had nothing to switch on. `catalogue.hiddenBySwitch` derives this from
    // the CLI's own route export, so a run with `QIALIKE_BEE=1` legitimately expects it mounted instead.
    for (const route of catalogue.catalogueOnlyRoutes) {
      expect(catalogue.allTemplateIds, `${route} is hidden but is not a template row`).toContain(route)
    }
    // A total can be right while its parts are wrong — one row mounting twice and another not at all would
    // cancel out — so the composition is asserted as well, which is the part a count cannot see.
    expect(new Set(providers).size, 'the registry lists a route twice').toBe(providers.length)
    const mounted = new Set(providers)
    for (const route of catalogue.hiddenBySwitch) {
      expect(mounted.has(route), `${route} ships off by default but the profile mounted it`).toBe(false)
    }
    for (const route of catalogue.coreTemplateIds) {
      expect(mounted.has(route), `core template ${route} did not mount`).toBe(true)
    }
    for (const [group, routes] of Object.entries(catalogue.groups)) {
      for (const route of routes) {
        expect(mounted.has(route), `${group} route ${route} did not mount`).toBe(true)
      }
    }
    expect(mounted.has(catalogue.builtin), 'the builtin route did not mount').toBe(true)
    // The registry should hold nothing beyond those three sources — an unexpected route is either a stray
    // registration or a table this test has stopped accounting for.
    const expected = new Set([...catalogue.coreTemplateIds, catalogue.builtin, ...Object.values(catalogue.groups).flat()])
    expect(providers.filter((route) => !expected.has(route))).toEqual([])
    expect(mounted.has('anthropic')).toBe(true)
    expect(mounted.has('openai')).toBe(true)
  }, 300_000)

  it('mounts each gateway group', async () => {
    const { report } = await probe()
    const providers = new Set(report.providers)
    // One route from each group, chosen so a group cannot pass by another group's
    // route: the four rows mount independently and fail independently.
    for (const route of ['opencode-zen', 'qiniu-ai', 'openrouter', 'azure']) {
      expect(providers.has(route), `${route} (gateway row missing?)`).toBe(true)
    }
  }, 300_000)

  it("serves the adapter's own model list for a route it ships", async () => {
    // A route name is not a working adapter: this asserts the registered adapter
    // answers `listModels` for the built-in profile, which is what the browser's
    // model catalog is built from.
    const { report } = await probe()
    expect(report.officialModels.length).toBeGreaterThan(0)
    expect(report.officialModels).toContain('deepseek-v4-pro')
  }, 300_000)

  it('registers model discovery for its own namespace, live (M4 item 4)', async () => {
    // WHY A BOOT IS THE ONLY WAY TO KNOW. An unregistered namespace fails no build, no
    // boot and no page: `discoverModels` throws `NO_DISCOVERY`, our settings route
    // catches it, and the button silently falls back to a bare `/models` probe. So the
    // probe asks the assembled runtime — and the first assertion is what makes the
    // second mean anything, because a namespace nothing serves must throw.
    const { report } = await probe()
    expect(report.discovery.unregisteredNamespace).toMatch(/NO_DISCOVERY|no model discovery is registered/u)
    // The registered one answered, from a `/models` endpoint the probe served itself on
    // loopback: hermetic, with no gateway and no network.
    expect(report.discovery.error).toBeUndefined()
    expect(report.discovery.models.map((model) => model.id)).toEqual(['probe-model-b', 'probe-model-a'])
    // The one-shot credential actually being sent is the difference between this
    // capability and the CLI's probe, and it is invisible in the returned id list.
    // The second request is the route call below, which carries no key — and is
    // therefore also the assertion that an absent credential is not sent as an empty
    // bearer, which a gateway would read as "wrong key" rather than "no key".
    expect(report.discovery.requests).toEqual([
      { url: '/v1/models', authorization: 'Bearer probe-one-shot-key' },
      { url: '/v1/models' },
    ])
  }, 300_000)

  it('is what the settings route consults, not its own probe', async () => {
    // THE LINK THAT WOULD OTHERWISE GO UNTESTED. The settings route has a fall-back
    // probe, so it can answer correctly while never consulting the capability at all —
    // and the returned id list would look identical. Only `source` distinguishes them.
    // Reached over the real authenticated route, through the same handler the browser
    // calls, with no `route` so the draft path is the one exercised.
    const { report } = await probe()
    expect(report.discovery.route.status).toBe(200)
    expect(report.discovery.route).toMatchObject({
      ok: true,
      source: 'discovery',
      models: ['probe-model-b', 'probe-model-a'],
      discovered: 2,
      filtered: 0,
    })
  }, 300_000)

  it('advertises the row id as the settings namespace for every provider', async () => {
    // The three-way agreement the row id carries: the CLI's `TUI_LLM_NS`, the row
    // id in `cordis.patch.yml`, and the namespace `settings.describe()` reports.
    // A rename that breaks one of the three detaches provider configuration from
    // the Models page without failing anything.
    const { report } = await probe()
    expect(report.configurable.length).toBeGreaterThan(0)
    expect(new Set(report.configurable.map((entry) => entry.settingsNs)))
      .toEqual(new Set(['qialike-llm']))
  }, 300_000)

  it('does not yet mount that namespace, which is why the page cannot edit', async () => {
    // Records the present limitation rather than asserting it is desirable
    // (DESIGN §12.2 R12). A namespace exists only for a row whose module exports a
    // volatile `Config`; the catalogue's configuration lives in `qialike.json`
    // instead, which is what makes it shared with the CLI. When that changes, this
    // test should fail and be rewritten deliberately.
    const { report } = await probe()
    expect(report.settingsNamespaces).not.toContain('qialike-llm')
  }, 300_000)

  it('leaves the base bundle with no provider of its own', async () => {
    // The displaced rows: `llm-pi-ai`, `llm-deepseek`, `llm-deepseek-account`.
    // Each would otherwise register routes competing with the CLI's adapter for
    // the same ids — `deepseek-official` especially, which the CLI serves itself.
    const { report } = await probe()
    const namespaces = report.settingsNamespaces
    expect(namespaces).not.toContain('llm-pi-ai')
    expect(namespaces).not.toContain('llm-deepseek')
    expect(namespaces).not.toContain('llm-deepseek-account')
  }, 300_000)
})
