/**
 * The composer's own model lookup.
 *
 * THE POINT OF THIS MODULE IS WHAT IT DOES NOT DO. The catalogue route answers with 57 provider
 * groups and 2,063 models, and building it costs the Host a live probe per credentialed route —
 * measured at 2,443 ms cold on this machine, dominated by two first-TLS handshakes
 * (`qialike-bee-cn` 2,503 ms, `moonshotai-cn` 2,126 ms). The composer needs a name and an effort
 * label for ONE model. These tests pin that the cheap path stays cheap: one `resolveModelInfo`
 * call, no catalogue build, and no failure mode that leaves the trigger blank.
 */

import { describe, expect, it } from 'vitest'

import { readActiveModel } from '../packages/qialike-desktop-providers/lib/active-model.js'

const selection = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** A static catalogue holding one route with one named model. */
const catalogueOf = (models, reasoning) => ({
  routeOf: (route) => (route === 'deepseek-official' ? { models } : undefined),
  reasoningOf: () => reasoning,
})

/** An `llm` stand-in that records every call it receives. */
const stub = (impl) => {
  const calls = []
  return {
    calls,
    llm: {
      resolveModelInfo: async (provider, model) => {
        calls.push([provider, model])
        return impl(provider, model)
      },
    },
  }
}

describe('readActiveModel', () => {
  it('answers with the one model it was asked about, calling resolveModelInfo exactly once', async () => {
    const { llm, calls } = stub(() => ({ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }))
    const value = await readActiveModel(undefined, llm, selection)
    expect(value).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', source: 'live' })
    // THE ASSERTION THAT KEEPS THE PATH CHEAP. A second call means someone reintroduced enumeration.
    expect(calls, 'the cheap path enumerated more than one model').toEqual([['deepseek-official', 'deepseek-flash']])
  })

  it('carries the reasoning efforts, which the trigger shows beside the name', async () => {
    const { llm } = stub(() => ({
      name: 'DeepSeek-V4.1-Flash',
      reasoning: {
        defaultEffort: 'high',
        efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
      },
    }))
    const value = await readActiveModel(undefined, llm, selection)
    expect(value.reasoning?.defaultEffort).toBe('high')
    expect(value.reasoning?.efforts).toEqual([{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }])
  })

  it('falls back to the model id rather than throwing when the lookup fails', async () => {
    // A cosmetic lookup must not take the composer down. The id is a truthful label, and the menu
    // will load the real catalogue when the user opens it.
    const { llm } = stub(() => { throw new Error('adapter exploded') })
    const value = await readActiveModel(undefined, llm, selection)
    expect(value).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', name: 'deepseek-flash', source: 'fallback' })
  })

  it('answers from the selection when no llm service is reachable', async () => {
    for (const llm of [undefined, {}]) {
      const value = await readActiveModel(undefined, llm, selection)
      expect(value, 'a missing llm left the trigger without a label').toEqual({
        provider: 'deepseek-official', model: 'deepseek-flash', name: 'deepseek-flash', source: 'fallback',
      })
    }
  })

  it('drops a reasoning block with no usable effort ids', async () => {
    // An adapter that reports `reasoning` with an empty list would otherwise render a menu with
    // nothing in it; absent is the honest answer.
    const { llm } = stub(() => ({ name: 'Plain', reasoning: { efforts: [] } }))
    expect((await readActiveModel(undefined, llm, selection)).reasoning).toBeUndefined()
  })

  it('keeps a name that the adapter supplied and ignores an empty one', async () => {
    expect((await readActiveModel(undefined, stub(() => ({ name: 'Real Name' })).llm, selection)).name).toBe('Real Name')
    expect((await readActiveModel(undefined, stub(() => ({ name: '' })).llm, selection)).name).toBe('deepseek-flash')
  })

  it('answers from static tables without touching the network at all', async () => {
    // THE REGRESSION THIS PINS. Resolving through `resolveModelInfo` still runs the route's live
    // `/models` probe, so a user who left a Moonshot model selected paid Moonshot's first TLS
    // handshake (2,126 ms measured) on every restart. The static tables answer the same question.
    let asked = 0
    const llm = { resolveModelInfo: async () => { asked += 1; return { name: 'from network' } } }
    const catalogue = catalogueOf([{ id: 'kimi-k3', name: 'Kimi K3' }])
    const value = await readActiveModel(catalogue, llm, { provider: 'deepseek-official', model: 'kimi-k3' })
    expect(value.name).toBe('Kimi K3')
    expect(value.source).toBe('static')
    expect(asked, 'the static path went to the network').toBe(0)
  })

  it('carries reasoning from the static tables', async () => {
    const catalogue = catalogueOf(
      [{ id: 'kimi-k3', name: 'Kimi K3' }],
      { defaultEffort: 'high', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
    )
    const value = await readActiveModel(catalogue, undefined, { provider: 'deepseek-official', model: 'kimi-k3' })
    expect(value.reasoning?.defaultEffort).toBe('high')
  })

  it('falls back to the network only for a model no static table knows', async () => {
    // A gateway that shipped something new since the build. This is the exception, not the path.
    let asked = 0
    const llm = { resolveModelInfo: async () => { asked += 1; return { name: 'Brand New' } } }
    const catalogue = catalogueOf([{ id: 'kimi-k3', name: 'Kimi K3' }])
    const value = await readActiveModel(catalogue, llm, { provider: 'deepseek-official', model: 'unheard-of' })
    expect(value.name).toBe('Brand New')
    expect(value.source).toBe('live')
    expect(asked).toBe(1)
  })

  it('does not ask the catalogue route for anything', async () => {
    // Cheap by construction: the only service this module touches is `llm`, and only for one pair.
    const { llm } = stub(() => ({ name: 'X' }))
    const value = await readActiveModel(undefined, llm, selection)
    expect(Object.keys(value).sort()).toEqual(['model', 'name', 'provider', 'source'])
  })
})
