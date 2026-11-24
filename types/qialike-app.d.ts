/**
 * The qialike CLI surface this application consumes, declared explicitly.
 *
 * The same reasoning as `harness.d.ts`, for the same reason: the CLI is a
 * read-only checkout that this repository does not depend on at build time, so
 * `tsc` cannot resolve its declarations and must not be made to. Pointing
 * `tsconfig.paths` at the checkout would make `pnpm test` require a built CLI
 * before it could say why.
 *
 * WHY THE BUILT SUBPATH AND NOT `src/**`. The design consumes the CLI as a
 * *built* artifact (DESIGN §5.1): its own build already compiles `src/llm.ts`
 * with esbuild, and the result — `lib/llm.js` — is a single self-contained
 * module whose only remaining imports are `node:fs`, `yaml`, and four
 * `@deepseek-ai/*` packages the runtime tree already carries. Recompiling that
 * source here would duplicate the CLI's build and produce a second artifact that
 * can disagree with the one the CLI itself ships.
 *
 * WHAT THIS BUYS. This file is the complete list of CLI APIs this application
 * depends on, in one reviewable place. When the CLI moves, a changed signature
 * surfaces here as a mismatch against a declaration someone must intentionally
 * update, rather than as a runtime failure inside a boot. The build's patches
 * achieve the same for the files they edit by asserting their anchors; this
 * achieves it for the API surface.
 *
 * Keep each declaration to what is actually called. A speculative member is a
 * claim about the CLI that nothing verifies.
 *
 * Verified against `@qialike/qialike-app` 0.10.0 at CLI commit `~/deepseek/qialike`
 * (`e4960c4`), the build that followed the CLI's own harness 0.2.1-alpha.2 rebuild.
 *
 * That rebuild was a breaking release for the CLI (`5a13a70 feat!:`), so this file's
 * claim was re-checked rather than assumed: every member declared below is still
 * exported by 0.10.0, with the same kinds. The application does not consume the
 * members the rebuild added, so nothing here needed to change.
 *
 * Re-checked against 0.11.1, the patch release this application's 0.4.1 re-hosts.
 * All twelve `llm` members and the four gateway tables are still exported with the
 * same kinds. 0.11.1 adds `keyUrlFor` (a provider's console URL) and
 * `fetchDynamicModelInfo` (a gateway model's limits), neither of which is declared
 * or consumed here yet — the add-provider dialog has no key link and
 * `providers/src/discovery.ts` probes `/models` itself. Both are candidates, not
 * dependencies.
 */

declare module '@qialike/qialike-app/llm' {
  import type { Context } from '@deepseek-ai/cordis'

  /**
   * Stable Cordis plugin name the CLI registers.
   *
   * The CLI calls this plugin `tui-llm`. This application re-hosts it under a row
   * whose id — and therefore whose settings namespace — is `qialike-llm`, so the
   * declared name here is the CLI's, not ours; see `src/llm.ts` for why the two
   * deliberately differ.
   */
  export const name: string

  /**
   * Services the plugin needs before it can register anything.
   *
   * Re-exported rather than restated: the adapter cannot register without the
   * same two services the CLI requires, and a hand-copied list here would drift.
   */
  export const inject: readonly string[]

  /**
   * The identifier the CLI's provider directory reports as `settingsNs`.
   *
   * This is the string that has to match a mounted settings namespace for the
   * Models page to treat those rows as configurable. The CLI chose it to be the
   * row id, so the desktop row below is named to match (DESIGN §7.2).
   */
  export const TUI_LLM_NS: string

  /** The route the CLI serves DeepSeek's own endpoint under. */
  export const DEEPSEEK_OFFICIAL_ROUTE: string

  /** The first of the Beat deployments — `.com`. Declared for completeness; pages want the list. */
  export const QIALIKE_BEE_ROUTE: string

  /**
   * BOTH Bee deployments, behind one switch.
   *
   * Bee ships as `qialike-bee` (`.com`) and `qialike-bee-cn` (mainland) from CLI 0.11.4, and a
   * single `bee.enabled` governs the pair — the CLI adds every route in this list to
   * `hiddenRoutes` when the switch is off. A page that named only the first would leave the
   * mainland row visible while the switch read "off".
   */
  export const QIALIKE_BEE_ROUTES: readonly string[]

  /** One model entry in a provider profile. */
  export interface TuiModelProfile {
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxTokens?: number
    readonly inputModalities?: readonly ('text' | 'image')[]
    readonly reasoningEfforts?: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly disablesThinking?: boolean
    }[]
  }

  /**
   * One provider route profile, as `qialike.json` stores it under `llm.providers`.
   *
   * Only the fields the settings page edits are declared. The real interface has
   * a dozen more (`modelsApi`, `excludeModelPrefixes`, `effortWire`, …) which this
   * application reads through the CLI's own helpers and never constructs by hand —
   * a speculative member here would be a claim nothing verifies.
   */
  export interface TuiProviderProfile {
    readonly displayName?: string
    readonly api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative'
    readonly baseURL: string
    readonly apiKeyEnv?: string
    readonly models?: readonly TuiModelProfile[]
  }

  /** A shipped provider template: a profile plus the route it is addressed by. */
  export interface TuiProviderTemplate extends TuiProviderProfile {
    readonly route: string
    readonly name: string
  }

  /**
   * The shipped provider catalogue, validated at module load by the CLI.
   *
   * Read-only, and the reason the desktop settings page can offer 44 providers
   * before the user has configured anything.
   */
  export const PROVIDER_TEMPLATES: readonly TuiProviderTemplate[]

  /**
   * Resolve one route's effective profile exactly as the adapter does: the
   * built-in DeepSeek route first, then a settings-provided override, then a
   * template route.
   */
  export function effectiveProfile(
    route: string,
    section: Record<string, TuiProviderProfile> | undefined,
    templates: readonly TuiProviderTemplate[],
  ): TuiProviderProfile | undefined

  /**
   * The reasoning metadata a route declares for one model, or `undefined` when it has none.
   *
   * Statically derived from the templates — no network. Added here because the desktop's provider
   * row labels the composer's model trigger from it without probing the gateway; the CLI exports it
   * (measured: `typeof modelReasoning === 'function'`) but this declaration file omitted it.
   */
  export function modelReasoning(
    profile: TuiProviderProfile | undefined,
    provider: string,
    model: string,
  ): {
    readonly defaultEffort?: string
    readonly efforts: readonly { readonly id: string, readonly name: string }[]
  } | undefined

  /**
   * Probe an OpenAI-compatible gateway's live catalog (`GET {baseURL}/models`).
   * @returns the model ids, or undefined when the endpoint is missing,
   *   unauthorized or slow. Cached per endpoint root with a TTL.
   */
  export function fetchDynamicModels(baseURL: string): Promise<readonly string[] | undefined>

  /** Apply a route's prefix rules to a discovered id list. */
  export function filterDynamicModels(
    ids: readonly string[],
    profile: TuiProviderProfile,
  ): readonly string[]

  /**
   * Register the OpenAI-compatible adapter and the configurable-provider
   * directory, and keep both in step with `qialike.json`.
   *
   * Returns early — without throwing — when `ctx.llm` is absent, so the row is
   * inert rather than fatal in a composition that has no LLM service.
   *
   * @param ctx - the host context the row is mounted in.
   */
  export function apply(ctx: Context): void
}

/**
 * The four loadable gateway groups.
 *
 * Each is a sibling plugin of `./llm` that registers its templates through the
 * `tuiLlmTemplates` service, and each reads its own switch from `qialike.json`.
 * Only the route lists are declared: the settings API needs them to know which
 * group a route belongs to, and `apply` is not called from here — the bundle's
 * patch rows mount these modules directly.
 *
 * The switch keys are the CLI's `PluginSectionKey` spellings (`opencode`,
 * `azure`, `china_gateways`, `foreign_gateways`), not the `qialike-*` namespace
 * names that predate harness 0.1.7.
 */
declare module '@qialike/qialike-app/opencode' {
  import type { TuiProviderTemplate } from '@qialike/qialike-app/llm'
  /** The two OpenCode routes this group adds. */
  export const OPENCODE_TEMPLATES: readonly TuiProviderTemplate[]
}

declare module '@qialike/qialike-app/china-gateways' {
  import type { TuiProviderTemplate } from '@qialike/qialike-app/llm'
  /** The Chinese gateway routes this group adds. */
  export const CHINA_GATEWAY_TEMPLATES: readonly TuiProviderTemplate[]
}

declare module '@qialike/qialike-app/foreign-gateways' {
  import type { TuiProviderTemplate } from '@qialike/qialike-app/llm'
  /** The Western gateway routes this group adds. */
  export const FOREIGN_GATEWAY_TEMPLATES: readonly TuiProviderTemplate[]
}

declare module '@qialike/qialike-app/azure' {
  import type { TuiProviderTemplate } from '@qialike/qialike-app/llm'
  /** The single Azure route this group adds. */
  export const AZURE_TEMPLATES: readonly TuiProviderTemplate[]
}
