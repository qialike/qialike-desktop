/**
 * `qialike-llm` — the provider catalogue, served by the CLI's own adapter.
 *
 * WHAT THIS ROW IS. The qialike CLI already implements everything the desktop
 * needs from a model layer: an OpenAI-compatible adapter covering four wire
 * protocols, a 62-entry provider template catalogue, four loadable gateway
 * groups, and a reasoning-effort catalogue. That implementation is host-side and
 * UI-agnostic — it talks to `ctx.llm` and reads `qialike.json`, never to Ink —
 * so the desktop re-hosts it instead of reimplementing it (DESIGN §7.2, and the
 * reuse contract the `ui-free-shared` gate enforces).
 *
 * WHY THERE IS A WRAPPER AT ALL, rather than the patch row naming
 * `@qialike/qialike-app/llm` directly. Two reasons, one present and one planned:
 *
 *   · The row `id` decides the settings namespace (`SettingsForms.describe()`
 *     reports `ns: entry.options.id`), and the CLI's directory entries advertise
 *     `settingsNs: 'qialike-llm'`. Naming this row `qialike-llm` is what makes
 *     the two agree, and that is a fact about *this profile*, not about the CLI —
 *     so it belongs here rather than in a row that names the CLI's module.
 *   · The desktop's own additions land in `apply()` below. M4's remaining item is
 *     `registerModelDiscovery`, which the CLI does not register (it performs live
 *     model discovery inside its own `/models` dialog instead); that call needs a
 *     plugin body of ours to run in.
 *
 * WHY THIS MODULE IS HERE AND NOT IN THE BUNDLE THAT DECLARES THE ROW. The
 * profile resolver builds its package table from a dependency closure and then
 * removes the bundle layers from it (`collectProfileScopePackages`,
 * `packages/boot/app-boot/src/profile.ts`), so a row may not name a subpath of
 * the bundle that inserted it — the import fails and surfaces only as
 * `warning: 1 entry did not activate`. A row must name a dependency of a bundle,
 * which is what this sibling package is.
 *
 * WHY `name` IS OVERRIDDEN. The CLI registers this plugin as `tui-llm`. The row
 * id, the settings namespace, and this name are deliberately the same string
 * here: a reader tracing a provider row from the Models page back to its
 * configuration should not have to learn a second identity for the same plugin.
 * Cordis plugin names are per-composition, and this profile mounts the plugin
 * once, so there is no collision to avoid.
 *
 * WHAT IT DOES NOT DO YET. It exports no `Config`, which is deliberate and has a
 * visible consequence recorded in DESIGN §12.2 R12: without a schema carrying at
 * least one `.volatile()` field, `settings.describe()` omits the namespace, so
 * the Models page lists these providers without offering to edit them. Provider
 * configuration comes from `qialike.json`, which is what makes it shared with the
 * CLI; making the page editable means either moving that configuration into the
 * profile's own settings document (which would stop the CLI seeing it) or
 * bridging the two, and that is a decision, not an oversight.
 *
 * WHAT `apply` ADDS: `registerModelDiscovery`, which is the one capability the CLI
 * does not offer. The CLI probes a gateway's live `/models` endpoint *inside its
 * own list path* (`TuiLlmAdapter.listModels`), which is enough for a route it
 * already serves — so the desktop's provider page could call it directly, and does.
 * What that cannot do is answer for a provider that is **being added**: a draft has
 * a base URL and a not-yet-stored credential, and the adapter has no route to look
 * up. The harness models exactly that case with `registerModelDiscovery`, which is
 * the seam a configuration surface uses to offer "these are the models this
 * endpoint advertises" before anything is saved. See `./discovery.ts`, which holds that capability
 * and its own reasoning.
 *
 * @module @qialike/qialike-desktop-providers/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  apply as applyProviderCatalogue,
  inject as cliInject,
} from '@qialike/qialike-app/llm'
import { registerModelDiscovery } from './discovery.js'

/**
 * Stable Cordis plugin name.
 *
 * Equal to the row id in `cordis.patch.yml` and to the `settingsNs` the CLI's
 * provider directory advertises; see the module note.
 */
export const name = 'qialike-llm'

/**
 * Everything the CLI's plugin requires, plus nothing.
 *
 * Spread from the CLI's own list rather than restated: the adapter cannot
 * register without exactly those services, and a copy here would be a second
 * place to update when the CLI's requirements change.
 */
export const inject: readonly string[] = [...cliInject]

/**
 * Mount the provider catalogue, and offer discovery for it.
 *
 * @param ctx - the host context this row is mounted in.
 */
export function apply(ctx: Context): void {
  applyProviderCatalogue(ctx)
  // The namespace is this row's own name, which is the row id in `cordis.patch.yml`
  // and the `settingsNs` the CLI's provider directory advertises. Passing it from
  // here rather than letting `./discovery.ts` hold a copy is what keeps the three in
  // step: `tests/provider-discovery.test.mjs` asserts they are one string.
  registerModelDiscovery(ctx, name)
}
