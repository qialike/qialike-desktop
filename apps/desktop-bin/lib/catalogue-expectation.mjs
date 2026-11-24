/**
 * What the mounted provider catalogue *should* contain, derived from the CLI's own route tables.
 *
 * ONE ROW SHIPS OFF, AND THAT IS WHY THE TOTAL IS NOT SIMPLY "EVERY TEMPLATE". The CLI put QiaLike Bee
 * — its own gateway route — behind an off-by-default switch (`c0204…`/`c426202 feat(config): put
 * QiaLike Bee behind an off-by-default switch`): the row works, but its gateway is not serving yet, so
 * offering it means offering a provider whose dialog cannot work. The template row stays in
 * `PROVIDER_TEMPLATES`; the *route* is hidden at mount time. See {@link HIDDEN_BY_SWITCH}.
 *
 * WHY THIS EXISTS INSTEAD OF A NUMBER IN THE TESTS. Two tests asserted the catalogue size as a literal — 62
 * and 63 — with a comment explaining the composition: "44 core templates + the CLI's own `deepseek-official`
 * + 17 group routes". When the CLI added a provider (`785e0b0 feat(models): add QiaLike Bee, qialike's own
 * API route`) both literals fell one behind and the suite went red. Nothing was wrong with the product or
 * with this repository: the tests were counting a moving thing and had written down the old total.
 *
 * That is the worst kind of red — it teaches people to read past the suite. So the numbers are derived here,
 * from the tables that decide them, and a CLI that ships another provider moves the expectation with it.
 *
 * THE COMPOSITION, which is what the tests were describing in prose:
 *
 *   · `PROVIDER_TEMPLATES`            the core catalogue, one route per entry
 *   · `DEEPSEEK_OFFICIAL_ROUTE`       the CLI's own builtin, registered by the adapter rather than a template
 *   · four gateway groups            mounted by our own patch rows, one row each:
 *                                    `OPENCODE_TEMPLATES` / `CHINA_GATEWAY_TEMPLATES` /
 *                                    `FOREIGN_GATEWAY_TEMPLATES` / `AZURE_TEMPLATES`
 *
 * WHY IT RESOLVES BY ABSOLUTE PATH. A bare `@qialike/qialike-app/llm` resolves against the **importing
 * module's** location, which is this repository — and the CLI is not in this repository's `node_modules`, it
 * is in the assembled runtime tree. So the caller passes that tree and the imports are file URLs into it,
 * which is how the probes already reach `@deepseek-ai/dsh-app-boot`.
 *
 * @module qialike-desktop/catalogue-expectation
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The CLI package inside the runtime tree, by its real name — the tree symlinks it there. */
const CLI_PACKAGE = join('node_modules', '@qialike', 'qialike-app', 'lib')

/**
 * Rows the CLI's tables hide unless a switch is turned on.
 *
 * WHY THE RULE IS WRITTEN DOWN HERE INSTEAD OF IMPORTED. The decision lives in the CLI's `config.ts` —
 * `resolveBeeEnabled()` plus `DEFAULT_BEE_ENABLED` — and the compiled tree the tests read **does not
 * carry that module**: `lib/` holds `llm.js`, the gateway tables and the plugins, but no `config.js`.
 * Compiling it into our policy package to read one boolean would drag in `yaml`,
 * `@deepseek-ai/dsh-home-paths` and `./log.ts`; the two modules that package does compile are there
 * because they must *run* inside our profile, which this must not.
 *
 * So what is written down is the **rule** — which row, which variable, which default — not a count:
 *   · the route id is read from the CLI (`llm.QIALIKE_BEE_ROUTE`), never typed;
 *   · the row's presence in `PROVIDER_TEMPLATES` is asserted, so a CLI that removes or renames it
 *     fails loudly instead of quietly shrinking the expectation;
 *   · flipping the default in the CLI turns these tests red, which is the correct outcome — the
 *     catalogue would then genuinely be a different size. The fix is to update `defaultEnabled`.
 */
const HIDDEN_BY_SWITCH = [
  // A LIST, because Bee ships two deployments from CLI 0.11.4 — `.com` and mainland — and one
  // switch governs the pair: the CLI adds every route in `QIALIKE_BEE_ROUTES` to `hiddenRoutes`
  // when `bee.enabled` is off. Reading one name would have counted the mainland row as visible
  // while its switch read "off", which is the half-hidden state that rename was made to avoid.
  { routesExport: 'QIALIKE_BEE_ROUTES', env: 'QIALIKE_BEE', defaultEnabled: false },
]

/** The four gateway groups, in the order the comment in the test used to name them. */
const GATEWAY_GROUPS = [
  ['opencode', 'opencode', 'OPENCODE_TEMPLATES'],
  ['china', 'china-gateways', 'CHINA_GATEWAY_TEMPLATES'],
  ['foreign', 'foreign-gateways', 'FOREIGN_GATEWAY_TEMPLATES'],
  ['azure', 'azure', 'AZURE_TEMPLATES'],
]

/**
 * Read the CLI's route tables out of an assembled runtime tree.
 *
 * @param runtimeDir - the assembled `dist/runtime/dsh` (or a packaged equivalent).
 * @returns the expected catalogue: the core and group route ids, the builtin's id, the group sizes, and the
 *   total that a fully mounted catalogue should register.
 */
export async function catalogueExpectation(runtimeDir) {
  const load = async (subpath) => await import(pathToFileURL(join(runtimeDir, CLI_PACKAGE, `${subpath}.js`)).href)

  const llm = await load('llm')
  const groups = {}
  for (const [key, subpath, exportName] of GATEWAY_GROUPS) {
    const module = await load(subpath)
    const entries = module[exportName]
    // A renamed export would otherwise read as "this group mounted nothing" and quietly shrink the expected
    // total, which is exactly the failure mode this module was written to remove.
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`@qialike/qialike-app/${subpath} no longer exports a non-empty ${exportName}`)
    }
    groups[key] = entries.map((entry) => entry.route)
  }

  const core = llm.PROVIDER_TEMPLATES
  if (!Array.isArray(core) || core.length === 0) {
    throw new Error('@qialike/qialike-app/llm no longer exports a non-empty PROVIDER_TEMPLATES')
  }
  const builtin = llm.DEEPSEEK_OFFICIAL_ROUTE
  if (typeof builtin !== 'string' || builtin === '') {
    throw new Error('@qialike/qialike-app/llm no longer exports DEEPSEEK_OFFICIAL_ROUTE')
  }

  const allTemplateIds = core.map((entry) => entry.route)
  const hiddenBySwitch = []
  for (const rule of HIDDEN_BY_SWITCH) {
    const routes = llm[rule.routesExport]
    if (!Array.isArray(routes) || routes.length === 0 || routes.some((r) => typeof r !== 'string' || r === '')) {
      throw new Error(`@qialike/qialike-app/llm no longer exports a usable ${rule.routesExport}`)
    }
    for (const route of routes) {
      if (!allTemplateIds.includes(route)) {
        throw new Error(`the CLI hides ${rule.routesExport} row "${route}" by default, but no such template exists`)
      }
    }
    // Precedence mirrors the CLI's own: an environment override wins over the file, and an unparsable
    // value falls through to the default (the CLI's `parseBool` returns undefined for those).
    const raw = (process.env[rule.env] ?? '').trim()
    const enabled = raw === '' ? rule.defaultEnabled : /^(1|true|yes|on)$/iu.test(raw)
    if (!enabled) hiddenBySwitch.push(...routes)
  }
  const hidden = new Set(hiddenBySwitch)
  const gatewayRoutes = Object.values(groups).flat()
  return {
    /** Rows that exist in the CLI's catalogue but are hidden, so they do not mount. */
    hiddenBySwitch,
    /** The same rows, by another name: present in the catalogue and absent from the mount. */
    catalogueOnlyRoutes: [...hiddenBySwitch],
    /** Every template row the CLI declares, including the hidden ones. */
    allTemplateIds,
    /** Core templates a fully mounted catalogue registers: `allTemplateIds` minus the hidden rows. */
    coreTemplateIds: allTemplateIds.filter((route) => !hidden.has(route)),
    builtin,
    groups,
    gatewayRouteCount: gatewayRoutes.length,
    /** Every route a fully mounted catalogue registers: the core, the builtin, and the four groups. */
    total: allTemplateIds.length - hiddenBySwitch.length + 1 + gatewayRoutes.length,
  }
}
