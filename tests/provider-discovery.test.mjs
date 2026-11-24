/**
 * M4 item 4: model discovery as a registered host capability.
 *
 * WHAT THE CAPABILITY IS FOR, so the tests below check the right thing. The CLI
 * probes a gateway's `/models` endpoint inside its own list path, which answers for a
 * route it already serves. It cannot answer for a provider **being added** — a base
 * URL and a credential the user has not saved yet, with no route to look up. The
 * harness models that case with `registerModelDiscovery(settingsNs, discover)`, the
 * seam a configuration surface uses to offer "these are the models this endpoint
 * advertises" before anything is stored.
 *
 * WHY THIS SUITE CAN RUN IN-PROCESS AT ALL. `./llm.ts` imports the CLI's built module,
 * which is not a dependency of this repository, so importing it under `vitest` fails at
 * resolution. The capability therefore lives in `./discovery.ts`, whose only import is
 * a type — the compiled file imports nothing — and this suite drives that directly.
 * The wiring around it (which namespace, which row) is asserted from source text and
 * verified against the running application, because that part genuinely needs a boot.
 *
 * THREE FAILURES ARE POSSIBLE AND TWO OF THEM ARE SILENT:
 *
 *   1. The registration never happens. Nothing errors: `discoverModels` throws
 *      `NO_DISCOVERY` for the namespace and the surface falls back to a bare probe.
 *      Everything keeps working and the capability is inert — the shape that produced
 *      `warning: 1 entry did not activate` twice in this project already.
 *   2. The namespace does not match. Discovery is registered by the `qialike-llm` row,
 *      while the settings API asks under `TUI_LLM_NS`, the constant the CLI's provider
 *      directory advertises. If those strings drift, everything still builds and boots,
 *      and the only symptom is that discovery is never consulted. Asserted directly,
 *      against the CLI's own built module.
 *   3. The duplicate registration. The harness *throws* on a second registration for
 *      one namespace, so a re-`apply` would take the model layer down rather than
 *      degrade. The stub reproduces that throw, so the test is about the real hazard.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { memberDir } from '../apps/desktop-bin/lib/runtime-tree.mjs'

const LIB = join(ROOT, 'packages', 'qialike-desktop-providers', 'lib')
const compiled = existsSync(join(LIB, 'discovery.js'))
const { discoverModels, registerModelDiscovery } = compiled
  ? await import(join(LIB, 'discovery.js'))
  : {}

/** The real `fetch`, restored after every test that replaces it. */
const realFetch = globalThis.fetch

/**
 * A context whose `llm` service is recorded.
 *
 * `get(name)` is how every host-side row in this repository reaches a service (the
 * real `Context` is an index signature of `unknown`), so that is the whole surface
 * this module uses.
 */
function stubContext({ withRegister = true, listModels } = {}) {
  const registrations = new Map()
  const runtime = {
    ...(listModels === undefined ? {} : { listModels }),
    ...(withRegister
      ? {
          registerModelDiscovery: (settingsNs, fn) => {
            if (registrations.has(settingsNs)) {
              throw new Error(`model discovery for "${settingsNs}" is already registered`)
            }
            registrations.set(settingsNs, fn)
            return () => { registrations.delete(settingsNs) }
          },
        }
      : {}),
  }
  return { registrations, ctx: { get: (name) => (name === 'llm' ? runtime : undefined) } }
}

/** Every URL a stubbed `fetch` was asked for, in order. */
const calls = []

/** A `fetch` that answers `/models` with the given ids. */
function stubFetch({ ids = ['a-1', 'a-2'], ok = true, bearers } = {}) {
  return async (url, init) => {
    calls.push(String(url))
    bearers?.push((init?.headers ?? {}).authorization)
    return { ok, json: async () => ({ data: ids.map((id) => ({ id })) }) }
  }
}

describe.skipIf(!compiled)('registering the capability', () => {
  it('registers under the namespace the CLI’s provider directory advertises', () => {
    // Failure 2, asserted against the CLI's own build rather than a restated copy —
    // a copy is exactly what would drift. The row id, the plugin name and the
    // advertised namespace are one string by design, and this is what keeps it true.
    // `memberDir`: the runtime tree is de-linked after assembly, so the staged CLI
    // package is at `node_modules/@qialike/qialike-app`, not under pnpm's `packages/`.
    const cliLlvm = join(memberDir(join(DIST_DIR, 'runtime', 'dsh'), '@qialike/qialike-app'), 'lib', 'llm.js')
    if (!existsSync(cliLlvm)) {
      // Without the assembled farm the CLI's constant cannot be read. The other half
      // of the assertion — that our own module and the row agree — still runs.
      const source = readFileSync(join(ROOT, 'packages', 'qialike-desktop-providers', 'src', 'llm.ts'), 'utf8')
      expect(source).toContain('registerModelDiscovery(ctx, name)')
      return
    }
    const advertised = /TUI_LLM_NS\s*=\s*["']([^"']+)["']/u.exec(readFileSync(cliLlvm, 'utf8'))?.[1]
    expect(advertised, 'the CLI build should declare TUI_LLM_NS').toBeTypeOf('string')
    const { ctx, registrations } = stubContext()
    registerModelDiscovery(ctx, advertised)
    expect([...registrations.keys()]).toEqual([advertised])
  })

  it('is inert, not fatal, when the service cannot offer discovery', () => {
    const { ctx } = stubContext({ withRegister: false })
    expect(registerModelDiscovery(ctx, 'qialike-llm')).toBeUndefined()
    expect(registerModelDiscovery({ get: () => undefined }, 'qialike-llm')).toBeUndefined()
  })

  it('withdraws its registration when disposed', () => {
    const { ctx, registrations } = stubContext()
    const dispose = registerModelDiscovery(ctx, 'qialike-llm')
    expect(registrations.size).toBe(1)
    dispose()
    expect(registrations.size).toBe(0)
  })

  it('reports the duplicate rather than swallowing it', () => {
    // Failure 3. The module must not paper over the harness's throw: a second
    // registration is a composition mistake, and the harness's error names it. This
    // asserts we do not catch it, so the mistake stays visible.
    const { ctx } = stubContext()
    registerModelDiscovery(ctx, 'qialike-llm')
    expect(() => registerModelDiscovery(ctx, 'qialike-llm')).toThrow(/already registered/u)
  })
})

describe.skipIf(!compiled)('what discovery answers', () => {
  /** The registered function, for a context built for one test. */
  const registered = (options) => {
    const { ctx, registrations } = stubContext(options)
    registerModelDiscovery(ctx, 'qialike-llm')
    return [...registrations.values()][0]
  }

  it('asks the adapter for a route it already serves, and never the endpoint', async () => {
    // The harness's contract in its own words: a route whose adapter knows its models
    // answers from that knowledge instead of asking the endpoint. The CLI's adapter
    // merges the template catalog, the stored profile, the prefix filters and a live
    // probe, so its answer is better than a bare `/models` — and costs no network.
    const asked = []
    const discover = registered({
      listModels: async (provider) => {
        asked.push(provider)
        return [{ id: 'known-1', name: 'Known One' }, { id: 'known-2' }]
      },
    })
    calls.length = 0
    globalThis.fetch = vi.fn(stubFetch())
    const models = await discover({ provider: 'opencode-zen', baseURL: 'https://gw.example/v1' })

    expect(asked).toEqual(['opencode-zen'])
    expect(models).toEqual([{ id: 'known-1', name: 'Known One' }, { id: 'known-2', name: 'known-2' }])
    expect(calls, 'the adapter answered, so nothing should have been fetched').toEqual([])
    globalThis.fetch = realFetch
  })

  it('falls through to the endpoint when the adapter does not claim the route', async () => {
    // The "provider being added" case, which is the reason the capability exists.
    const discover = registered({ listModels: async () => { throw new Error('unknown provider') } })
    calls.length = 0
    globalThis.fetch = stubFetch({ ids: ['draft-1', 'draft-2'] })
    const models = await discover({ provider: 'not-yet', baseURL: 'https://new.example/v1/' })

    expect(models).toEqual([{ id: 'draft-1' }, { id: 'draft-2' }])
    // The trailing slash is trimmed, so a pasted one does not produce a double slash
    // that some gateways 404 on.
    expect(calls).toEqual(['https://new.example/v1/models'])
    globalThis.fetch = realFetch
  })

  it('also falls through when the adapter claims the route but knows no models', async () => {
    // An empty adapter answer and a refusal mean the same thing to a caller offering
    // candidates, so both reach the endpoint.
    const discover = registered({ listModels: async () => [] })
    calls.length = 0
    globalThis.fetch = stubFetch({ ids: ['from-endpoint'] })
    expect(await discover({ provider: 'odd-route', baseURL: 'https://gw.example/v1' }))
      .toEqual([{ id: 'from-endpoint' }])
    expect(calls).toEqual(['https://gw.example/v1/models'])
    globalThis.fetch = realFetch
  })

  it('sends the draft’s own credential, and only when there is one', async () => {
    // The reason this is not the CLI's `fetchDynamicModels`: that function takes a base
    // URL and nothing else, so an authenticated gateway would be probed bare, answer
    // 401, and be reported to the user as "no models".
    const bearers = []
    const discover = registered({ listModels: async () => [] })
    globalThis.fetch = stubFetch({ ids: ['m'], bearers })
    await discover({ baseURL: 'https://gw.example/v1', apiKey: 'sk-secret' })
    await discover({ baseURL: 'https://gw.example/v1' })
    await discover({ baseURL: 'https://gw.example/v1', apiKey: '' })
    expect(bearers).toEqual(['Bearer sk-secret', undefined, undefined])
    globalThis.fetch = realFetch
  })

  it('honours the caller’s cancellation signal', async () => {
    // The other thing the CLI's probe cannot do: an abandoned dialog must not keep a
    // request alive against a gateway that is timing out.
    const seen = []
    const discover = registered({ listModels: async () => [] })
    globalThis.fetch = async (_url, init) => {
      seen.push(init.signal)
      return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }
    }
    const controller = new AbortController()
    await discover({ baseURL: 'https://gw.example/v1' }, controller.signal)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    // A signal that aborts when either the caller aborts or the deadline passes, so
    // it is live before the caller does anything.
    expect(seen[0].aborted).toBe(false)
    controller.abort()
    expect(seen[0].aborted).toBe(true)
    globalThis.fetch = realFetch
  })

  it('deduplicates, because a gateway may list one id twice', async () => {
    const discover = registered({ listModels: async () => [] })
    globalThis.fetch = stubFetch({ ids: ['m-1', 'm-1', 'm-2'] })
    expect((await discover({ baseURL: 'https://gw.example/v1' })).map((m) => m.id)).toEqual(['m-1', 'm-2'])
    globalThis.fetch = realFetch
  })

  it('keeps the endpoint’s own name when it supplies one', async () => {
    // The harness's `LlmDiscoveredModel` carries a name, and a gateway that humanises
    // its ids is the one place a better label than the id exists.
    const discover = registered({ listModels: async () => [] })
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-x', name: 'GPT X' }, { id: 'plain' }] }),
    })
    expect(await discover({ baseURL: 'https://gw.example/v1' }))
      .toEqual([{ id: 'gpt-x', name: 'GPT X' }, { id: 'plain' }])
    globalThis.fetch = realFetch
  })

  it('answers “nothing” rather than throwing, for every shape of failure', async () => {
    // The contract is a candidate list a surface may offer, so a missing endpoint, a
    // 401, a timeout and a cancelled dialog are one answer. Throwing would turn a
    // probe into an error dialog for something the user can simply type past.
    const discover = registered({ listModels: async () => { throw new Error('no') } })

    globalThis.fetch = stubFetch({ ok: false })
    expect(await discover({ baseURL: 'https://gw.example/v1' })).toEqual([])

    globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError') }
    expect(await discover({ baseURL: 'https://gw.example/v1' })).toEqual([])

    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
    expect(await discover({ baseURL: 'https://gw.example/v1' })).toEqual([])

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 42 }, { name: 'no id' }] }) })
    expect(await discover({ baseURL: 'https://gw.example/v1' })).toEqual([])

    // Nothing to interrogate at all.
    globalThis.fetch = vi.fn()
    expect(await discover({})).toEqual([])
    expect(await discover({ baseURL: '' })).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
    globalThis.fetch = realFetch
  })

  it('is reachable as a bare function too, for a caller that has a context but no registration', async () => {
    // `discoverModels` is exported separately because the settings route may want to
    // ask without going through the harness's namespace lookup. Kept honest by
    // exercising it directly rather than only through the registration.
    const { ctx } = stubContext({ listModels: async () => [{ id: 'direct' }] })
    expect(await discoverModels(ctx, { provider: 'any' })).toEqual([{ id: 'direct', name: 'direct' }])
  })
})
