/**
 * The one model the composer is already using, resolved without touching the network.
 *
 * WHY THIS EXISTS. The model picker's trigger shows a name and a reasoning-effort label, and it
 * used to get both from the full catalogue — which meant the composer waited for all 57 provider
 * groups and 2,063 models before it could say anything. Measured: 2,443 ms cold, dominated by the
 * live probes each credentialed route triggers (`qialike-bee-cn` 2,503 ms, `moonshotai-cn` 2,126 ms
 * on a first TLS handshake).
 *
 * IT USED TO CALL `resolveModelInfo`, AND THAT WAS STILL SLOW. Resolving a single model still runs
 * the route's live `/models` probe (`liveModelInfo` in the CLI), so a user who left a Moonshot model
 * selected paid Moonshot's handshake on every restart — 2.1 s measured — and the composer waited
 * for it. The provider's own catalogue is static data: `PROVIDER_TEMPLATES` carries `name` for every
 * shipped model, and `modelReasoning` derives the effort list from the same tables. Both are
 * in-process lookups. So this module reads them and never opens a socket.
 *
 * WHEN IT DOES GO TO THE NETWORK, AND WHY THAT IS THE RIGHT EXCEPTION. A model that exists only in
 * a route's live listing — a gateway that shipped something new — is in no static table. For that
 * one case `resolveModelInfo` is tried, because the alternative is showing a bare id. It is the
 * exception, not the path: every model in the shipped catalogue is answered without it.
 *
 * @module @qialike/qialike-desktop-providers/active-model
 */

/** The selection a session is sending with. */
export interface ActiveSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One static model entry, as the templates and a configured profile both spell it. */
export interface CatalogModel {
  readonly id: string
  readonly name?: string
}

/** A route's static model list, from its configured profile or from the shipped template. */
export interface CatalogRoute {
  readonly models?: readonly CatalogModel[]
}

/** The reasoning metadata a static table can supply for one model. */
export interface ReasoningInfo {
  readonly defaultEffort?: string
  readonly efforts: readonly { readonly id: string, readonly name: string }[]
}

/** What the composer needs to render its trigger. */
export interface ActiveModel {
  readonly provider: string
  readonly model: string
  readonly name: string
  /** The effort ids the model offers; absent when it has no reasoning. */
  readonly reasoning?: ReasoningInfo
  /** Where the answer came from, so a slow startup can be attributed without guesswork. */
  readonly source: 'static' | 'live' | 'fallback'
}

/** The lookup table this module reads; injected so it can be tested without a Host. */
export interface StaticCatalogue {
  /** The route's effective static entry: the configured profile when it has one, else the template. */
  routeOf: (route: string) => CatalogRoute | undefined
  /** The reasoning metadata for one model, or undefined when it has none. */
  reasoningOf: (route: string, model: string) => ReasoningInfo | undefined
}

/** The subset of the `llm` service used for the live-only fallback. */
export interface LlmReader {
  resolveModelInfo?: (provider: string, model: string) => Promise<{
    readonly id?: string
    readonly name?: string
    readonly reasoning?: {
      readonly defaultEffort?: string
      readonly efforts?: readonly { readonly id: string, readonly name?: string }[]
    }
  }>
}

/** Normalise whatever `modelReasoning` returned into this module's shape. */
function toReasoning(value: ReasoningInfo | undefined): ReasoningInfo | undefined {
  if (value === undefined) return undefined
  const efforts = (value.efforts ?? [])
    .filter((effort) => typeof effort?.id === 'string' && effort.id.length > 0)
    .map((effort) => ({ id: effort.id, name: effort.name ?? effort.id }))
  if (efforts.length === 0) return undefined
  return {
    ...(typeof value.defaultEffort === 'string' ? { defaultEffort: value.defaultEffort } : {}),
    efforts,
  }
}

/**
 * Read the display metadata for exactly one model, preferring static tables.
 *
 * @param catalogue - the static tables, when this profile mounts them.
 * @param llm - the host's `llm` service, used only when the model is in no static table.
 * @param selection - the current provider/model pair.
 * @returns the label the trigger should show.
 */
export async function readActiveModel(
  catalogue: StaticCatalogue | undefined,
  llm: LlmReader | undefined,
  selection: ActiveSelection,
): Promise<ActiveModel> {
  const { provider, model } = selection

  // 1. STATIC FIRST. Every model the product ships is in a template, so this is the path taken in
  //    practice — and it costs nothing, which is the whole point.
  const entry = catalogue?.routeOf(provider)?.models?.find((candidate) => candidate.id === model)
  if (entry !== undefined) {
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : model
    const reasoning = toReasoning(catalogue?.reasoningOf(provider, model))
    return { provider, model, name, source: 'static', ...(reasoning === undefined ? {} : { reasoning }) }
  }

  // 2. THE LIVE-ONLY EXCEPTION. A model the static tables do not know about still deserves its
  //    real name, and this is the only way to get it.
  if (llm?.resolveModelInfo !== undefined) {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : model
      const efforts = (info.reasoning?.efforts ?? [])
        .filter((effort) => typeof effort?.id === 'string' && effort.id.length > 0)
        .map((effort) => ({ id: effort.id, name: effort.name ?? effort.id }))
      const reasoning = efforts.length === 0
        ? undefined
        : {
            ...(typeof info.reasoning?.defaultEffort === 'string'
              ? { defaultEffort: info.reasoning.defaultEffort } : {}),
            efforts,
          }
      return { provider, model, name, source: 'live', ...(reasoning === undefined ? {} : { reasoning }) }
    } catch {
      // Falls through: a cosmetic lookup must not take the composer down.
    }
  }

  // 3. NOTHING KNOWS IT. The id is a truthful label, and the menu will show the real catalogue.
  return { provider, model, name: model, source: 'fallback' }
}
