/**
 * The providers settings API: `qialike.json` as the source of truth, edited over
 * an authenticated HTTP route.
 *
 * WHY THIS IS THE PACKAGE ROOT. A row may only be a client row — one whose
 * package declares `dsh.client` and whose bundle reaches the browser — when its
 * name is the *exact* package specifier: the host half of the client-module
 * scanner takes `exactPackageSpecifier(row.name)` and treats `undefined` as
 * "permanently not a client row" (`packages/client/modules/src/index.ts`,
 * `locatePkgJson`). A subpath such as `@qialike/qialike-desktop-providers/settings`
 * is therefore discovered by nothing, however correct its manifest is. So the
 * settings surface — the half that has a browser counterpart — is the root module,
 * and `./llm`, which has none, is the subpath.
 *
 * WHY AN HTTP ROUTE AND NOT A REMOTE. The harness exposes Host services to the
 * browser through Typert Remotes, whose artifacts are generated on both sides by
 * the harness's own toolchain. A route registered with
 * `ctx.connection.fetch.register` needs no code generation, is authenticated by
 * the same carrier ("after the physical carrier has applied its trust and
 * authentication policy"), and is the mechanism the harness itself uses for
 * `/api/file`. The client half of this package calls it with plain `fetch`.
 *
 * WHY `qialike.json` RATHER THAN A HARNESS SETTINGS NAMESPACE. DESIGN §12.2 R12
 * records the choice. The short version: the harness's settings document belongs
 * to a *profile* (`<profile.home>/settings.yaml`), so anything written there is
 * invisible to the CLI's `tui` profile. `qialike.json` is the file both products
 * already read, so it is the only place a provider profile can be stored once and
 * honoured by both.
 *
 * THE COST OF THAT CHOICE, STATED PLAINLY. `@qialike/qialike-app` does not export
 * its `config.ts`, and that module's code is inlined into each of its consumers by
 * its own build, so there is no built subpath through which its `writeSection()`
 * could be called. This module therefore reads and writes the file itself. The
 * format is small and the rules below mirror the CLI's `persistConfig()` exactly —
 * merge rather than replace, two-space JSON with a trailing newline, mode 0600 —
 * with one deliberate improvement: the write is atomic, which the CLI's is not
 * (DESIGN §12.2 R5 names concurrent writers of this file as a risk). Both
 * products must keep agreeing about this file, so any change to the CLI's writer
 * has to be mirrored here.
 *
 * WHY A WRITE ALSO REMOUNTS A ROW. The CLI's `onSectionChange()` is an in-process
 * callback registry, not a file watcher: it fires only for a `writeSection()` call
 * inside the same process. Our write is a different process writing a file, so
 * nothing notifies the mounted `qialike-llm` row and its adapter would keep
 * serving the previous profile until the Host restarted. The route therefore asks
 * the Loader to restart that one row, which re-runs the CLI's `apply()` against
 * the new file. That is a best-effort step with a reported outcome, never a
 * silent one: the file write is what makes the change durable, and it has already
 * succeeded by the time the remount is attempted.
 *
 * @module @qialike/qialike-desktop-providers
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialOwners, reportsKeyConfigured } from './credential-ownership.js'
import { readActiveModel, type ActiveSelection, type StaticCatalogue } from './active-model.js'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AZURE_TEMPLATES } from '@qialike/qialike-app/azure'
import { CHINA_GATEWAY_TEMPLATES } from '@qialike/qialike-app/china-gateways'
import { FOREIGN_GATEWAY_TEMPLATES } from '@qialike/qialike-app/foreign-gateways'
import { OPENCODE_TEMPLATES } from '@qialike/qialike-app/opencode'
import {
  DEEPSEEK_OFFICIAL_ROUTE,
  PROVIDER_TEMPLATES,
  QIALIKE_BEE_ROUTES,
  TUI_LLM_NS,
  effectiveProfile,
  fetchDynamicModels,
  filterDynamicModels,
  modelReasoning,
  type TuiProviderProfile,
  type TuiProviderTemplate,
} from '@qialike/qialike-app/llm'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-providers'

/** The one route this row serves. */
export const API_PATH = '/api/qialike/providers'

/**
 * Where the composer's own model lookup is served.
 *
 * Separate from {@link API_PATH} on purpose: that one describes the whole catalogue (57 groups,
 * 2,063 models), this one describes a single selection and is cheap enough to answer during
 * startup. One handler per concern is also what keeps the slow one from being accidentally reached
 * on the fast path.
 */
export const ACTIVE_MODEL_PATH = '/api/qialike/active-model'

/** The row whose remount re-reads the file; the CLI's provider catalogue. */
const PROVIDER_ROW_ID = 'qialike-llm'

/**
 * The four loadable gateway groups, as `{ config key, route ids }`.
 *
 * Derived from each group's own exported template list rather than restated here,
 * so a group that gains a route — or a fifth group — is not something this table
 * can silently disagree with.
 *
 * The config key is the CLI's `PluginSectionKey`, which is what its
 * `readSection()` call in each group's `apply()` reads. Those keys are NOT the
 * `qialike-*` namespace names: those are the pre-0.1.7 spellings, kept only as a
 * migration source.
 */
const GATEWAY_GROUPS: readonly { key: string, routes: readonly string[] }[] = [
  { key: 'opencode', routes: OPENCODE_TEMPLATES.map((template) => template.route) },
  { key: 'china_gateways', routes: CHINA_GATEWAY_TEMPLATES.map((template) => template.route) },
  { key: 'foreign_gateways', routes: FOREIGN_GATEWAY_TEMPLATES.map((template) => template.route) },
  { key: 'azure', routes: AZURE_TEMPLATES.map((template) => template.route) },
]

/**
 * Every template the profile can serve: the core catalogue plus all four groups.
 *
 * The page has to walk this rather than `PROVIDER_TEMPLATES` alone. The group
 * routes are registered in the adapter by their own plugins, so they appear in
 * `llm.listProviders()` — but they are not in the core list, and a page built
 * from the core list alone therefore shows 45 providers while the model layer
 * serves 62. The seventeen in between would be selectable in the chat composer
 * and absent from the settings page.
 */
const ALL_TEMPLATES: readonly TuiProviderTemplate[] = [
  ...PROVIDER_TEMPLATES,
  ...OPENCODE_TEMPLATES,
  ...CHINA_GATEWAY_TEMPLATES,
  ...FOREIGN_GATEWAY_TEMPLATES,
  ...AZURE_TEMPLATES,
]

/** The group a route belongs to, when it belongs to one. */
function groupOf(route: string): { key: string, routes: readonly string[] } | undefined {
  return GATEWAY_GROUPS.find((group) => group.routes.includes(route))
}

/** Whether a group's own `enabled: false` switch is set in the document. */
function groupDisabled(config: QialikeConfig, key: string): boolean {
  const section = config[key]
  return typeof section === 'object' && section !== null
    && (section as { enabled?: unknown }).enabled === false
}

/** The six wire protocols a profile may name, as the CLI's schema spells them. */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative'] as const

/** A route id usable as a JSON key and as the stem of a credential name. */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** The qialike config document, as this module sees it: only the keys it owns are typed. */
interface QialikeConfig {
  llm?: { providers?: Record<string, TuiProviderProfile> }
  hidden_providers?: readonly string[]
  [key: string]: unknown
}

/** The path of the shared configuration file. */
export function configPath(): string {
  return dshHomePath('qialike.json')
}

/**
 * Read the configuration document.
 *
 * Absent or unparsable is `{}` rather than an error, matching the CLI: a
 * half-written file must not take the settings page down, and every consumer
 * treats a missing key as a default.
 *
 * @returns the parsed document, or an empty one.
 */
function readConfig(): QialikeConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as QialikeConfig
  } catch {
    // Missing or malformed -> defaults.
  }
  return {}
}

/**
 * Persist the configuration document atomically.
 *
 * A temporary file in the same directory, then a rename: a reader either sees the
 * previous document or the next one, never a truncated one. The mode is set on
 * the temporary file and the result is chmod-ed as well, because `mode` only
 * applies at creation — an existing 0644 file would otherwise keep its bits, and
 * this file holds provider configuration for a shared home.
 *
 * @param next - the complete document to write.
 * @returns whether the write landed.
 */
function writeConfig(next: QialikeConfig): boolean {
  const path = configPath()
  const temporary = join(dirname(path), `.qialike.json.${String(process.pid)}.tmp`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The cleanup is best-effort; the write failure is what matters.
    }
    return false
  }
}

/** Configured provider profiles, keyed by route. */
function configuredProfiles(config: QialikeConfig = readConfig()): Record<string, TuiProviderProfile> {
  const providers = config.llm?.providers
  return typeof providers === 'object' && providers !== null ? providers : {}
}

/** Routes the user has switched off. */
function hiddenRoutes(config: QialikeConfig = readConfig()): readonly string[] {
  const list = config.hidden_providers
  return Array.isArray(list) ? list.filter((route): route is string => typeof route === 'string') : []
}

/**
 * The CLI's template service, as `ctx.provide('tuiLlmTemplates', …)` exposes it.
 *
 * This is the only handle on the *live* route set. `hideRoutes()` re-registers the
 * adapter as a side effect, which is what makes a disable take effect without a
 * restart; `hiddenRoutes()` reports what is currently withdrawn.
 */
interface TemplateService {
  /** Withdraw routes from the adapter and the directory, immediately. */
  hideRoutes(routes: readonly string[]): void
  /** The routes currently withdrawn. */
  hiddenRoutes(): readonly string[]
}

/** Read the template service, when the provider row has provided it. */
function templateServiceOf(ctx: Context): TemplateService | undefined {
  const service = ctx.get('tuiLlmTemplates') as Partial<TemplateService> | undefined
  if (service === undefined) return undefined
  if (typeof service.hideRoutes !== 'function' || typeof service.hiddenRoutes !== 'function') return undefined
  return service as TemplateService
}

/**
 * Withdraw every route the configuration file lists as disabled.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE FILE. `hidden_providers` in `qialike.json`
 * is read by the CLI's *interface* (`store.seedHiddenProviders` in `index.tsx`),
 * not by its adapter: the mounted route set only changes when something calls
 * `hideRoutes()`. So a persisted disable would otherwise be forgotten on every
 * boot — the file would say the route is off while the model layer kept serving
 * it, which is the same silent disagreement this module exists to remove.
 *
 * Runs on every (re)appearance of the service, so a restart of the provider row —
 * which builds a fresh, empty hidden set — is followed by the same withdrawal.
 * Additive and idempotent: it only adds what is missing.
 *
 * @param ctx - a context carrying the template service.
 */
function applyPersistedHides(ctx: Context): void {
  const service = templateServiceOf(ctx)
  if (service === undefined) return
  const current = new Set(service.hiddenRoutes())
  const missing = hiddenRoutes().filter((route) => !current.has(route))
  if (missing.length > 0) service.hideRoutes(missing)
}

/** The credential reference a route resolves its key through. */
function keyRefOf(route: string, profile: TuiProviderProfile | undefined): string {
  return profile?.apiKeyEnv ?? `${route.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

/**
 * The credential reference a route's profile names, or an empty string when the
 * profile names one the credentials service cannot be asked about.
 *
 * @param route - the provider route.
 * @param profile - its effective profile.
 * @returns the reference, or `undefined` when the profile names none.
 */
function profileKeyRef(route: string, profile: TuiProviderProfile | undefined): string | undefined {
  const named = profile?.apiKeyEnv
  if (typeof named === 'string' && named.length > 0) return named
  return route === DEEPSEEK_OFFICIAL_ROUTE ? undefined : keyRefOf(route, profile)
}

/**
 * One row of the settings page.
 *
 * `source` is what the page needs to decide which actions are available: a
 * `builtin` route exists whether or not the file mentions it, a `template` route
 * is one the catalogue ships but this profile has not configured, and a
 * `configured` route is one the user added. Only the last can be removed.
 */
interface ProviderRouteState {
  route: string
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string | undefined
  modelCount: number
  source: 'builtin' | 'configured' | 'template' | 'unlisted'
  enabled: boolean
  /**
   * The gateway group this route belongs to, when it belongs to one, and whether
   * that group's own switch is off. A route can be withdrawn for either reason,
   * and the page has to say which: its own toggle cannot override a group switch,
   * so offering one without saying so is a control that does nothing.
   */
  group: string | undefined
  groupDisabled: boolean
  registered: boolean
  keyConfigured: boolean
}

/** Query credentials for a set of references, tolerating an absent service. */
async function keyStates(ctx: Context, refs: readonly string[]): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>()
  const credentials = ctx.get('credentials') as {
    describe?: (ref: unknown) => Promise<{ configured: boolean }>
  } | undefined
  if (credentials?.describe === undefined) return states
  for (const ref of refs) {
    try {
      states.set(ref, (await credentials.describe(credentialRef(ref))).configured)
    } catch {
      // An unreadable credential store reports "not configured" rather than
      // failing the whole page.
      states.set(ref, false)
    }
  }
  return states
}

/**
 * Build the state the page renders.
 *
 * @param ctx - the row's context; `llm` and `credentials` are used when present.
 * @returns the route rows and the template catalogue.
 */
async function describeProviders(ctx: Context): Promise<{
  configPath: string
  writable: boolean
  llmNamespace: string
  routes: ProviderRouteState[]
  templates: TuiProviderTemplate[]
  /**
   * The routes of the product's own gateway — both deployments, behind one switch.
   *
   * See the note at the return site for why this is a list and not a name.
   */
  beeRoutes: readonly string[]
  /** No provider can serve a request yet; the first-run page keys on this. */
  firstRun: boolean
  /** The selection this profile would use before a session picks its own. */
  defaultModel: { provider: string, model: string, reasoningEffort?: string } | null
}> {
  const config = readConfig()
  const configured = configuredProfiles(config)
  const hidden = new Set(hiddenRoutes(config))
  const llm = ctx.get('llm') as { listProviders?: () => { id: string }[] } | undefined
  const registered = new Set((llm?.listProviders?.() ?? []).map((provider) => provider.id))
  // The live withdrawal set is authoritative when it is reachable; the file is
  // what the next boot will read. They agree except in the window between a write
  // and the remount that applies it.
  const service = templateServiceOf(ctx)
  const live = service === undefined ? hidden : new Set(service.hiddenRoutes())
  const disabledGroups = new Set(GATEWAY_GROUPS.filter((group) => groupDisabled(config, group.key)).map((group) => group.key))

  const routes: ProviderRouteState[] = []
  const seen = new Set<string>()
  const add = (route: string, source: ProviderRouteState['source']): void => {
    if (seen.has(route)) return
    seen.add(route)
    const profile = effectiveProfile(route, configured, ALL_TEMPLATES)
    const group = groupOf(route)
    routes.push({
      route,
      displayName: profile?.displayName ?? route,
      api: profile?.api ?? 'openai-completions',
      baseURL: profile?.baseURL ?? '',
      apiKeyEnv: profileKeyRef(route, profile),
      modelCount: profile?.models?.length ?? 0,
      source,
      enabled: !live.has(route),
      group: group?.key,
      groupDisabled: group === undefined ? false : disabledGroups.has(group.key),
      registered: registered.has(route),
      keyConfigured: false,
    })
  }
  add(DEEPSEEK_OFFICIAL_ROUTE, 'builtin')
  for (const route of Object.keys(configured)) add(route, 'configured')
  for (const template of ALL_TEMPLATES) add(template.route, 'template')
  // Anything the adapter serves that no list above names — a route a user overlay
  // declared, say. Listed rather than dropped: a provider the model layer offers
  // and the page does not show is a provider the user cannot turn off.
  for (const route of registered) add(route, 'unlisted')

  const refs = [...new Set(routes.flatMap((row) => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
  const states = await keyStates(ctx, refs)
  // A REFERENCE NAME IS NOT A ROUTE, AND EIGHT GROUPS SHARE ONE. Adding `Moonshot AI (China)`
  // stores its key under `MOONSHOT_API_KEY`, which `moonshotai` also resolves — so asking the
  // store by name alone made `moonshotai` report a key and appear in the list, for a provider the
  // user never added and that a mainland key cannot even reach (measured: `.cn` 200 with six
  // models, `.ai` 401 with the same key). `credentialOwners` attributes a shared reference to the
  // route the user actually configured; see that module for why explicit configuration is the
  // disambiguator and why an unattributable reference still reports for every route sharing it.
  const owners = credentialOwners(routes)
  for (const row of routes) {
    const stored = row.apiKeyEnv === undefined ? false : states.get(row.apiKeyEnv) === true
    row.keyConfigured = reportsKeyConfigured(row, owners, stored)
  }
  routes.sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
    return left.displayName.localeCompare(right.displayName)
  })
  const model = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string, model: string, reasoningEffort?: string } } | undefined
  let defaultModel: { provider: string, model: string, reasoningEffort?: string } | null = null
  try {
    defaultModel = model?.currentSelection?.() ?? null
  } catch {
    // A profile without a resolvable default model reports none rather than
    // failing the page; the field is informational.
    defaultModel = null
  }

  return {
    configPath: configPath(),
    writable: true,
    llmNamespace: TUI_LLM_NS,
    routes,
    templates: [...ALL_TEMPLATES],
    /**
     * The route of qialike's own gateway, so the page does not restate a name the CLI owns.
     *
     * The shipped page lists what the user HAS — a route whose credential is set — plus this
     * one, which is the product's own gateway and is offered before it is configured so its key
     * can be entered at all. Every other route reaches the page through "Add provider". The
     * rule is the CLI's (`listConfigured`, whose entry survives being keyless); the name is read
     * from the CLI's constant rather than written here, because a copy of it would be a second
     * place to change.
     */
    beeRoutes: [...QIALIKE_BEE_ROUTES],
    /**
     * Whether *no* provider can serve a request yet.
     *
     * This is what the first-run page keys on, and it is deliberately derived
     * from the credential store rather than from a "has the user seen this
     * screen" flag: a flag would leave someone who cleared their keys looking at
     * a working-looking application that cannot answer, and someone who
     * configured a key outside this page looking at an onboarding screen they do
     * not need.
     */
    firstRun: routes.every((row) => !row.keyConfigured),
    defaultModel,
  }
}

/**
 * Restart the provider row so the CLI's `apply()` re-reads the file.
 *
 * WHY THIS IS A FIBER UPDATE AND NOT AN ENTRY UPDATE. The obvious call is
 * `entry.update({}, false, true)` — pass a forced update with unchanged options,
 * expecting the row to restart. It does nothing. `Entry.update` computes the set
 * of changed option keys and hands that set to `_patchContext`, which restarts
 * the fiber only when the set contains `config`:
 *
 *     _patchContext(diff) {
 *       this.context.waterfall('loader/patch-context', this, () => {
 *         Object.setPrototypeOf(this.ctx, this.parent.ctx)
 *         if (this.fiber?.uid && (diff.includes('config') || this.options.group))
 *           this.fiber.update(this.options.config, true)
 *       })
 *     }
 *
 * An empty diff therefore reaches `_patchContext` and stops there; the `force`
 * flag only gets the call past the earlier "nothing changed" return. Calling the
 * fiber directly is what `_patchContext` itself does for a real config change, so
 * this is the same restart the Loader performs, entered one level lower.
 *
 * WHAT ALSO DOES NOT WORK, and is worse. Disposing the fiber and re-creating the
 * entry leaves the row unapplied rather than merely stale: measured on this
 * harness, the provider registry went from 45 routes to **zero** and stayed
 * there. The row is not restarted, it is removed.
 *
 * Both facts were established by running the three candidates against a booted
 * profile and reading `llm.listProviders()`; the probe is `remountProviderRow`'s
 * only real test, and `tests/providers-settings.test.mjs` keeps it.
 *
 * @param ctx - a context carrying the Loader.
 * @returns whether a row was restarted.
 */
async function remountProviderRow(ctx: Context): Promise<boolean> {
  const loader = ctx.get('loader') as {
    entries?: () => Iterable<{
      options?: { id?: string }
      fiber?: { update?: (config: unknown, noSave?: boolean) => unknown }
    }>
  } | undefined
  if (loader?.entries === undefined) return false
  for (const entry of loader.entries()) {
    if (entry.options?.id !== PROVIDER_ROW_ID) continue
    const update = entry.fiber?.update
    if (typeof update !== 'function') return false
    // `noSave` keeps the restart out of the profile's persisted config: the row's
    // own options did not change, so writing them back would be a spurious edit to
    // a file the user owns.
    await update.call(entry.fiber, entry.options, true)
    return true
  }
  return false
}

/** Normalize one profile from the wire, rejecting anything the CLI would not load. */
function profileFromWire(route: string, raw: unknown): TuiProviderProfile | string {
  if (typeof raw !== 'object' || raw === null) return 'the profile must be an object'
  const input = raw as Record<string, unknown>
  const baseURL = typeof input.baseURL === 'string' ? input.baseURL.trim() : ''
  if (baseURL.length === 0) return 'baseURL is required'
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    return 'baseURL must be an absolute http(s) URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'baseURL must be an http(s) URL'
  const api = input.api
  if (api !== undefined && !(APIS as readonly unknown[]).includes(api)) {
    return `api must be one of ${APIS.join(', ')}`
  }
  const profile: TuiProviderProfile = {
    baseURL,
    ...(typeof input.displayName === 'string' && input.displayName.trim().length > 0
      ? { displayName: input.displayName.trim() } : {}),
    ...(typeof api === 'string' ? { api: api as NonNullable<TuiProviderProfile['api']> } : {}),
    ...(typeof input.apiKeyEnv === 'string' && input.apiKeyEnv.trim().length > 0
      ? { apiKeyEnv: input.apiKeyEnv.trim() } : {}),
  }
  if (Array.isArray(input.models) && input.models.length > 0) {
    // THE TEMPLATE'S METADATA IS CARRIED OVER, NOT DISCARDED. Writing `{ id }` alone was a real
    // defect: the CLI's `resolveModel` reads `contextWindow` from this profile's model entry and
    // falls back to the live catalogue, which does not publish one — so a model added here had no
    // context capacity at all and every switch to it failed with
    // "compaction-basic: no context capacity for moonshotai-cn/kimi-k3". The template already
    // declares `name`, `contextWindow` and `maxTokens` for the same id; dropping them made a
    // configured route strictly worse than an unconfigured one.
    const template = ALL_TEMPLATES.find((candidate) => candidate.route === route)
    const known = new Map<string, Record<string, unknown>>()
    for (const model of template?.models ?? []) {
      if (typeof model?.id === 'string') known.set(model.id, model as unknown as Record<string, unknown>)
    }
    const models = input.models.flatMap((entry) => {
      const id = typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string'
          ? (entry as { id: string }).id
          : ''
      if (id.length === 0) return []
      const fromTemplate = known.get(id)
      // An explicit `contextWindow`/`maxTokens` on the wire wins: this page lets a user correct a
      // limit the gateway reports differently, and overwriting that with the template would make
      // the field unusable.
      const given = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
      const contextWindow = typeof given.contextWindow === 'number'
        ? given.contextWindow
        : typeof fromTemplate?.contextWindow === 'number' ? fromTemplate.contextWindow : undefined
      const maxTokens = typeof given.maxTokens === 'number'
        ? given.maxTokens
        : typeof fromTemplate?.maxTokens === 'number' ? fromTemplate.maxTokens : undefined
      const name = typeof given.name === 'string' && given.name.length > 0
        ? given.name
        : typeof fromTemplate?.name === 'string' ? fromTemplate.name : undefined
      return [{
        id,
        ...(name === undefined ? {} : { name }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }]
    })
    if (models.length === 0) return 'models must contain ids'
    return { ...profile, models }
  }
  return profile
}

/** Read a JSON body, bounded so a malformed request cannot exhaust memory. */
async function readBody(request: Request): Promise<Record<string, unknown> | string> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the body must be a JSON object'
    return parsed as Record<string, unknown>
  } catch {
    return 'the body must be valid JSON'
  }
}

/**
 * Apply one mutation and report what happened.
 *
 * @param ctx - the row's context.
 * @param body - the parsed request body.
 * @returns the response payload.
 */
async function mutate(ctx: Context, body: Record<string, unknown>, scope: () => Context): Promise<Record<string, unknown>> {
  const op = body.op
  const config = readConfig()
  const providers = { ...configuredProfiles(config) }
  const hidden = new Set(hiddenRoutes(config))

  /** Persist the document with the current provider set and hidden list. */
  const persist = (): boolean => writeConfig({
    ...config,
    llm: { ...(typeof config.llm === 'object' && config.llm !== null ? config.llm : {}), providers },
    hidden_providers: [...hidden],
  })

  if (op === 'discover') {
    const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
    if (baseURL.length === 0) return { ok: false, message: 'baseURL is required' }
    const route = typeof body.route === 'string' ? body.route : ''

    // THE REGISTERED DISCOVERY FIRST, THE CLI'S PROBE SECOND, AND THE ORDER IS THE
    // POINT. `qialike-llm` registers model discovery for this namespace (see its
    // `registerDiscovery`), so there is now a *host capability* for answering "what
    // models does this endpoint advertise" — and asking it is how this page and any
    // other surface get one answer from one implementation. Going straight to the
    // CLI's `fetchDynamicModels` would leave two discovery paths in one product, and
    // the one the harness can see would be the one nothing calls.
    //
    // The difference is observable: for a route the adapter serves, the capability
    // answers from the adapter — live catalog, stored profile, template fallback and
    // prefix rules merged — while the bare probe reports only what the endpoint
    // happens to list, and nothing at all for a route with no `/models` endpoint.
    //
    // The fallback is not dead code: discovery is registered by a *different row*
    // from this one, so a composition that mounts this package without it still has
    // a working button, and `tests/provider-discovery.test.mjs` exercises that shape
    // as well as the preferred one.
    const discovery = (ctx.get('llm') as {
      discoverModels?: (
        settingsNs: string,
        request: { provider?: string, baseURL?: string },
        signal?: AbortSignal,
      ) => Promise<readonly { id: string }[]>
    } | undefined)

    let ids: readonly string[] | undefined
    let source = 'probe'
    if (typeof discovery?.discoverModels === 'function') {
      try {
        const found = await discovery.discoverModels(TUI_LLM_NS, {
          ...(route.length > 0 ? { provider: route } : {}),
          baseURL,
        })
        if (found.length > 0) {
          ids = found.map((model) => model.id)
          source = 'discovery'
        }
      } catch {
        // Fall through. An unregistered namespace and a refused draft mean the same
        // thing here, and the probe below answers either way.
      }
    }
    if (ids === undefined) ids = await fetchDynamicModels(baseURL)
    if (ids === undefined) {
      return { ok: false, message: `no model list at ${baseURL.replace(/\/+$/u, '')}/models` }
    }
    const profile = route.length > 0 ? effectiveProfile(route, providers, ALL_TEMPLATES) : undefined
    const kept = profile === undefined ? ids : filterDynamicModels(ids, profile)
    // The filter and the discovery are reported separately: a gateway that lists
    // forty models and is reduced to four by the route's prefix rules is a fact
    // the page should show, not a silently smaller list. `source` is reported for
    // the same reason — "the adapter knew" and "the endpoint answered" can see
    // different things, so a surprising list stays explainable.
    return { ok: true, models: kept, discovered: ids.length, filtered: ids.length - kept.length, source }
  }

  if (op === 'save') {
    const route = typeof body.route === 'string' ? body.route : ''
    if (!ROUTE_PATTERN.test(route) && route !== DEEPSEEK_OFFICIAL_ROUTE) {
      return { ok: false, message: 'route must be a lowercase id such as "my-gateway"' }
    }
    const profile = profileFromWire(route, body.profile)
    if (typeof profile === 'string') return { ok: false, message: profile }
    providers[route] = profile
    // Saving a route is also how a disabled one comes back: keeping it hidden
    // after an explicit save would make the save look like it did nothing.
    hidden.delete(route)
    if (!persist()) return { ok: false, message: `could not write ${configPath()}` }
    return { ok: true, remounted: await remountProviderRow(ctx) }
  }

  if (op === 'remove' || op === 'reset') {
    const route = typeof body.route === 'string' ? body.route : ''
    delete providers[route]
    if (op === 'remove') hidden.delete(route)
    // `reset` on the builtin route drops the override but keeps the route, which
    // is the only way back to the shipped profile without editing the file.
    if (!persist()) return { ok: false, message: `could not write ${configPath()}` }
    return { ok: true, remounted: await remountProviderRow(ctx) }
  }

  if (op === 'setEnabled') {
    const route = typeof body.route === 'string' ? body.route : ''
    if (route === DEEPSEEK_OFFICIAL_ROUTE) return { ok: false, message: 'the built-in DeepSeek route cannot be disabled' }
    const service = templateServiceOf(ctx)
    if (service === undefined) {
      return { ok: false, message: 'the provider row is not mounted, so its routes cannot be withdrawn' }
    }
    if (body.enabled === true) {
      // A group switch is a second, coarser control over the same routes, and its
      // plugin re-reads it on every service replacement — so clearing this row's
      // own flag would not bring the route back, and reporting success would be a
      // lie the page cannot detect. Name the file key instead.
      const group = groupOf(route)
      if (group !== undefined && groupDisabled(config, group.key)) {
        return {
          ok: false,
          message: `${group.key} is switched off in ${configPath()} ({"${group.key}": {"enabled": false}}); `
            + 'that switch covers the whole group and has to be changed there.',
        }
      }
      hidden.delete(route)
      if (!persist()) return { ok: false, message: `could not write ${configPath()}` }
      // There is no counterpart to `hideRoutes`: the service only ever adds to its
      // hidden set, so a route comes back only when the provider row is rebuilt.
      // That is also why enabling needs the remount and disabling does not.
      const remounted = await remountProviderRow(ctx)
      // Verify rather than assume. The remount is best-effort (it needs a Loader),
      // and a route can stay withdrawn for a reason this module did not foresee;
      // either way the page must not report an enable that did not happen.
      const after = templateServiceOf(scope())
      if (after !== undefined && after.hiddenRoutes().includes(route)) {
        return { ok: false, message: `the route stayed disabled after the reload${remounted ? '' : ' (the provider row could not be restarted)'}` }
      }
      return { ok: true, remounted }
    }
    hidden.add(route)
    if (!persist()) return { ok: false, message: `could not write ${configPath()}` }
    const current = new Set(service.hiddenRoutes())
    if (!current.has(route)) service.hideRoutes([route])
    return { ok: true, remounted: false }
  }

  if (op === 'setKey') {
    const route = typeof body.route === 'string' ? body.route : ''
    const value = typeof body.value === 'string' ? body.value : ''
    if (route.length === 0) return { ok: false, message: 'route is required' }
    if (value.trim().length === 0) return { ok: false, message: 'the key is empty' }
    const credentials = ctx.get('credentials') as { set?: (ref: unknown, value: string) => Promise<void> } | undefined
    if (credentials?.set === undefined) return { ok: false, message: 'the credentials service is unavailable' }
    // The reference is the profile's own, or the one the CLI derives from the
    // route name — resolving it here rather than trusting the caller keeps the
    // key and the profile that will read it in agreement.
    const profile = effectiveProfile(route, providers, ALL_TEMPLATES)
    const ref = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.length > 0
      ? body.apiKeyEnv
      : keyRefOf(route, profile)
    try {
      await credentials.set(credentialRef(ref), value.trim())
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, apiKeyEnv: ref }
  }

  if (op === 'setDefaultModel') {
    const provider = typeof body.provider === 'string' ? body.provider : ''
    const model = typeof body.model === 'string' ? body.model : ''
    if (provider.length === 0 || model.length === 0) return { ok: false, message: 'provider and model are required' }
    const settings = ctx.get('settings') as {
      update?: (ns: string, patch: object, expectedRevision?: number) => Promise<void>
    } | undefined
    if (settings?.update === undefined) return { ok: false, message: 'the settings service is unavailable' }
    try {
      // `agent-default-model`'s provider/model/effort fields are declared volatile,
      // which is what makes them writable through the settings document. This is
      // the one preference the desktop writes *there* rather than to
      // `qialike.json`: it is a property of this surface's profile, not of the
      // provider catalogue both products share.
      await settings.update('agent-default-model', { provider, model })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true }
  }

  return { ok: false, message: `unknown op "${String(op)}"` }
}

/** JSON response helper. */
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Mount the route.
 *
 * Registered through `ctx.inject` rather than a hard `inject` entry: a profile
 * without a connection has no browser surface to serve, and the row should stay
 * mountable there rather than being held pending forever.
 *
 * @param ctx - the host context this row is mounted in.
 */
/**
 * The model this deployment is currently sending with.
 *
 * TWO SOURCES, IN THIS ORDER. `agentDefaultModel` is the live selection and the only one that
 * reflects a change made in this session. It is a *default*, though: a Session that has already
 * chosen carries its own projection in its history, and that is what `modelDirectories` resolves
 * when the composer asks. Startup has no session yet in the desktop's flow, so the default is the
 * answer there.
 *
 * @param ctx - the host context.
 * @returns the selection, or undefined before one exists.
 */
function currentSelectionOf(ctx: Context): ActiveSelection | undefined {
  const model = ctx.get('agentDefaultModel') as {
    currentSelection?: () => { provider?: unknown, model?: unknown, reasoningEffort?: unknown }
  } | undefined
  try {
    const selection = model?.currentSelection?.()
    if (selection === undefined) return undefined
    const provider = selection.provider
    const id = selection.model
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof id !== 'string' || id.length === 0) return undefined
    return {
      provider,
      model: id,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
        ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  } catch {
    // A profile without a resolvable default reports none rather than failing the request.
    return undefined
  }
}

/**
 * Fill in model metadata that an earlier version of this page failed to write.
 *
 * WHAT WENT WRONG. `profileFromWire` used to persist each model as `{ id }` alone, so every route
 * added through the page lost the template's `contextWindow` and `maxTokens`. The CLI reads those
 * from the profile's own entry and falls back to the live catalogue, which does not publish them —
 * so the route ended up with no context capacity, and switching to one of its models failed with
 * `compaction-basic: no context capacity for moonshotai-cn/kimi-k3`. The write path is fixed, but a
 * profile already on disk stays broken until something rewrites it, so this repairs in place.
 *
 * WHAT IT WILL AND WILL NOT TOUCH. It only ADDS a field that is missing, only for a model id the
 * route's own template declares, and only with the value the template states. A value the user or
 * the gateway already set is left alone — this must never overwrite a deliberate limit, and a
 * repair pass that quietly changed a number would be worse than the bug it fixes.
 *
 * @param config - the parsed `qialike.json`.
 * @returns whether anything changed, so the caller can decide to write.
 */
function repairModelMetadata(config: QialikeConfig): boolean {
  const providers = config.llm?.providers
  if (typeof providers !== 'object' || providers === null) return false
  let changed = false
  for (const [route, profile] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof profile !== 'object' || profile === null) continue
    const models = (profile as { models?: unknown }).models
    if (!Array.isArray(models)) continue
    const template = ALL_TEMPLATES.find((candidate) => candidate.route === route)
    const known = new Map<string, Record<string, unknown>>()
    for (const model of template?.models ?? []) {
      if (typeof model?.id === 'string') known.set(model.id, model as unknown as Record<string, unknown>)
    }
    if (known.size === 0) continue
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue
      const model = entry as Record<string, unknown>
      const source = known.get(typeof model.id === 'string' ? model.id : '')
      if (source === undefined) continue
      for (const field of ['contextWindow', 'maxTokens', 'name'] as const) {
        if (model[field] !== undefined) continue
        const value = source[field]
        if (value === undefined) continue
        model[field] = value
        changed = true
      }
    }
  }
  return changed
}

/**
 * The static tables {@link readActiveModel} reads instead of the network.
 *
 * `effectiveProfile` already resolves "configured profile, else shipped template" — the same
 * precedence the CLI uses when it answers a request — so the name shown here is the name the
 * adapter would use. `modelReasoning` derives the effort list from the same static data.
 *
 * @param ctx - the host context.
 * @returns the lookup table.
 */
function staticCatalogueOf(ctx: Context): StaticCatalogue {
  const configured = configuredProfiles(readConfig())
  const effective = (route: string): ReturnType<typeof effectiveProfile> =>
    effectiveProfile(route, configured, ALL_TEMPLATES)
  return {
    routeOf: (route) => effective(route),
    reasoningOf: (route, model) => {
      const profile = effective(route)
      if (profile === undefined) return undefined
      return modelReasoning(profile, route, model) as ReturnType<StaticCatalogue['reasoningOf']>
    },
  }
}

/** The host's `llm` service, when this profile mounts one. */
function llmOf(ctx: Context): Parameters<typeof readActiveModel>[1] {
    return ctx.get('llm') as Parameters<typeof readActiveModel>[1]
}

export function apply(ctx: Context): void {
  // Both services, because both are needed and they arrive independently: the
  // connection carries the HTTP surface, `tuiLlmTemplates` is the live route set
  // the provider row provides. Waiting on the latter is also what makes this
  // callback re-run after that row restarts, which is when the persisted
  // withdrawals have to be re-applied.
  ctx.inject(['connection', 'tuiLlmTemplates'], (scope) => {
    // Heal profiles written by the version that dropped model metadata, before anything reads them
    // — the CLI resolves `contextWindow` from this file at request time.
    try {
      const config = readConfig()
      if (repairModelMetadata(config)) {
        writeConfig(config)
        console.log('qialike-providers: restored missing model metadata from the templates')
      }
    } catch {
      // A config that cannot be read or written is not this pass's problem; the page reports it.
    }
    applyPersistedHides(scope)
    const connection = scope.get('connection') as {
      fetch: { register: (route: {
        path: string
        methods: readonly string[]
        requestBody: string
        fetch: (request: Request) => Promise<Response>
      }) => () => Promise<void> }
    }
    scope.effect(() => connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') return json(await describeProviders(scope))
          const body = await readBody(request)
          if (typeof body === 'string') return json({ ok: false, message: body }, 400)
          return json(await mutate(scope, body, () => scope))
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-providers: settings API')
    // THE CHEAP LOOKUP THE COMPOSER USES AT STARTUP. Registered separately so the slow catalogue
    // route and this one cannot be confused: this answers in one `resolveModelInfo`, and the
    // composer needs it before anything else is ready.
    scope.effect(() => connection.fetch.register({
      path: ACTIVE_MODEL_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const selection = currentSelectionOf(scope)
          if (selection === undefined) return json({ ok: false, message: 'no model is selected yet' }, 404)
          return json({ ok: true, value: await readActiveModel(staticCatalogueOf(scope), llmOf(scope), selection) })
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-providers: active model')
  })
}
