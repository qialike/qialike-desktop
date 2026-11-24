/**
 * Model discovery: the one model-layer capability the CLI does not already have.
 *
 * WHY THIS IS ITS OWN MODULE, IN TWO PARTS.
 *
 * *By responsibility.* Everything else in this package re-hosts something the CLI
 * already built — its adapter, its 62-provider catalogue, its four gateway groups.
 * This is the one piece that is ours: the CLI probes a gateway's live `/models`
 * endpoint inside its own list path, which answers for a route it already serves and
 * cannot answer for a provider **being added**. The harness models that case with
 * `registerModelDiscovery(settingsNs, discover)`, the seam a configuration surface
 * uses to offer "these are the models this endpoint advertises" before anything is
 * saved. A capability with its own contract deserves its own file.
 *
 * *Because it is testable there.* `./llm.ts` imports the CLI's built module, and the
 * CLI's package is not a dependency of this repository — `tsc` sees it through
 * `types/qialike-app.d.ts`, and the runtime sees it only inside the assembled farm.
 * So a module that imports it cannot be loaded by `vitest` at all, and the discovery
 * logic would be reachable only through a child process booting the whole profile.
 * This module's only import is a *type*, which erases at compile time: the compiled
 * `lib/discovery.js` imports nothing, so `tests/provider-discovery.test.mjs` can drive
 * it directly and assert the behaviour rather than the wiring.
 *
 * WHAT IT DOES NOT DO: it does not know its own namespace. The caller passes it,
 * because the namespace is the row id and the row id is a fact about the composition
 * in `./llm.ts` — keeping that string in one place is what stops the registration and
 * the lookup from drifting apart.
 *
 * @module @qialike/qialike-desktop-providers/discovery
 */

import type { Context } from '@deepseek-ai/cordis'

/** How long a draft-endpoint probe waits before giving up. */
const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * One model as the harness's discovery contract describes it.
 *
 * Declared here rather than imported: the harness's `LlmDiscoveredModel` belongs to a
 * package this repository does not depend on at build time (see `types/harness.d.ts`
 * for the whole reasoning), and this is the subset we produce.
 */
export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/** The draft a discovery call is asked about, as the harness defines it. */
export interface DiscoveryRequest {
  readonly provider?: string
  readonly baseURL?: string
  readonly api?: string
  readonly apiKey?: string
}

/**
 * The `ctx.llm` surface this module uses.
 *
 * Structural, and narrow on purpose: the real `LlmRuntime` has thirty members and
 * this is the two we call. A wider copy would be a claim about the harness that
 * nothing verifies (the rule `types/harness.d.ts` states), and a *narrow* one is what
 * lets a test pass a stub without reproducing a model layer.
 */
export interface LlmRuntime {
  listModels?: (provider: string) => Promise<readonly {
    id: string
    name?: string
    inputModalities?: readonly ('text' | 'image')[]
  }[]>
  registerModelDiscovery?: (
    settingsNs: string,
    discover: (request: DiscoveryRequest, signal?: AbortSignal) => Promise<readonly DiscoveredModel[]>,
  ) => () => void
}

/**
 * Interrogate one endpoint for the models it advertises.
 *
 * TWO BRANCHES, AND THE FIRST IS THE IMPORTANT ONE. When the request names a route
 * the adapter already serves, the answer comes from **the adapter**, through the
 * harness's own `ctx.llm.listModels`. That is not a convenience: the harness's
 * contract says so in its own words — *"A route whose adapter already knows its models
 * answers from that knowledge instead of asking the endpoint — the adapter's own
 * registry is the better answer, and it costs no network call"* — and the CLI's
 * adapter does know, because its `listModels` merges the template catalog, the stored
 * profile, the route's prefix filters and a live probe. Reimplementing any of that
 * here would produce a second answer that can disagree with the one the model picker
 * itself uses.
 *
 * The second branch exists because a provider **being added** has no route: only a
 * base URL and a credential the user just typed. Nothing can look it up, so this asks
 * the endpoint directly. It is deliberately not the CLI's `fetchDynamicModels`, and
 * the reason is concrete rather than stylistic: that function takes a base URL and
 * nothing else, while the contract hands us a one-shot credential and an `AbortSignal`
 * we are required to honour. Calling it would silently drop both — an authenticated
 * gateway would answer 401 and be reported to the user as "no models", and a cancelled
 * dialog would keep its request alive against a gateway that is already timing out.
 *
 * @param ctx - the host context, for `ctx.llm`.
 * @param request - the draft to interrogate.
 * @param signal - caller cancellation, honoured on both branches.
 * @returns the advertised models, deduplicated in endpoint order. Never throws: a
 *   missing endpoint, a 401, a timeout and a cancellation are one answer, because the
 *   reply is a candidate list a surface may offer and not an operation that can fail.
 */
export async function discoverModels(
  ctx: Context,
  request: DiscoveryRequest,
  signal?: AbortSignal,
): Promise<readonly DiscoveredModel[]> {
  const llm = ctx.get('llm') as LlmRuntime | undefined

  // Branch 1: a route the adapter serves. `listModels` throws for a route no adapter
  // claims, which is precisely the "being added" case the next branch is for — so a
  // failure here is a signal to fall through, not an error to report.
  if (typeof request.provider === 'string' && request.provider !== '' && typeof llm?.listModels === 'function') {
    try {
      const models = await llm.listModels(request.provider)
      if (models.length > 0) {
        return models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
        }))
      }
    } catch {
      // Fall through to the endpoint probe below.
    }
  }

  // Branch 2: a draft. The endpoint is all we have.
  const baseURL = request.baseURL
  if (typeof baseURL !== 'string' || baseURL === '') return []
  const root = baseURL.replace(/\/+$/u, '')

  // Two aborts, one signal: the caller's, and a deadline. `AbortSignal.any` needs
  // Node 20, which the harness's own runtime fingerprint already requires.
  const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  try {
    const response = await fetch(`${root}/models`, {
      headers: {
        accept: 'application/json',
        // Sent only when the draft carries one. An empty bearer would turn "no
        // credential yet" into "wrong credential" at the gateway.
        ...(typeof request.apiKey === 'string' && request.apiKey !== ''
          ? { authorization: `Bearer ${request.apiKey}` }
          : {}),
      },
      signal: combined,
    })
    if (!response.ok) return []
    const body = (await response.json()) as { data?: readonly { id?: unknown; name?: unknown }[] } | undefined
    const seen = new Set<string>()
    const out: DiscoveredModel[] = []
    for (const entry of body?.data ?? []) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : undefined
      out.push(name === undefined ? { id } : { id, name })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Offer discovery for one settings namespace.
 *
 * THE NAMESPACE IS THE ROW ID, deliberately, because that is the key a configuration
 * surface already holds from the adapter's configurable-provider directory, and
 * because a provider being added has no route to name.
 *
 * WHY THE SERVICE IS CHECKED RATHER THAN ASSUMED. `inject` covers the services the
 * CLI's plugin needs, and `llm` is among them — but a *capability* must degrade, not
 * crash: this returns undefined instead of throwing, so a composition whose LLM
 * service predates `registerModelDiscovery` still mounts the provider catalogue. The
 * harness itself throws on a duplicate registration for one namespace
 * (`DUPLICATE_DISCOVERY`), which is why the caller must not register twice.
 *
 * @param ctx - the host context.
 * @param settingsNs - the namespace whose drafts this discovery serves.
 * @returns a disposer, or undefined when the service cannot offer discovery.
 */
export function registerModelDiscovery(
  ctx: Context,
  settingsNs: string,
): (() => void) | undefined {
  const llm = ctx.get('llm') as LlmRuntime | undefined
  if (typeof llm?.registerModelDiscovery !== 'function') return undefined
  return llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(ctx, request, signal))
}
