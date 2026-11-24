/**
 * The derived catalogue expectation.
 *
 * WHY THIS SUITE EXISTS SEPARATELY. `catalogue-expectation.mjs` replaced two literals (62 and 63) that went
 * stale when the CLI shipped another provider. A derivation that is itself wrong is worse than the literal
 * it replaced — it would make the catalogue tests agree with a wrong number, quietly — so the arithmetic and
 * the guards are checked against a synthetic runtime tree rather than only through the real one.
 *
 * The real tree is covered by `provider-catalogue.test.mjs`, which is skipped when nothing is assembled. This
 * one always runs, and it is the only place the guards can be exercised: the real CLI always has all five
 * tables, so the "a table went missing" branch is unreachable there.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalogueExpectation } from '../apps/desktop-bin/lib/catalogue-expectation.mjs'

/** Where the module looks for the CLI, inside a tree it is given. */
const CLI_LIB = join('node_modules', '@qialike', 'qialike-app', 'lib')

/**
 * The five tables. Counts are chosen so a mix-up in the sum would show: 3 templates (one of them hidden by
 * its switch, so 2 mount) + 1 builtin + (2 + 1 + 1 + 1) = 8.
 *
 * `QIALIKE_BEE_ROUTE` points at `'c'` **on purpose**: the hidden-row rule must name a row that really
 * exists, and a fixture where it named nothing would leave that guard untested.
 */
const TABLES = {
  // BOTH EXPORTS, because the module reads the list. `QIALIKE_BEE_ROUTES` holds one row here and
  // that row is `c` ON PURPOSE: the hidden-row rule must name a row that really exists, and a
  // fixture where it named nothing would leave that guard untested. The real CLI ships two rows
  // behind one switch; a second entry would change the arithmetic without testing anything new,
  // which is why the plural case is asserted in `providers-settings` against the real tables.
  llm: `export const PROVIDER_TEMPLATES = [{ route: 'a' }, { route: 'b' }, { route: 'c' }]
export const DEEPSEEK_OFFICIAL_ROUTE = 'builtin-route'
export const QIALIKE_BEE_ROUTE = 'c'
export const QIALIKE_BEE_ROUTES = ['c']
`,
  opencode: `export const OPENCODE_TEMPLATES = [{ route: 'oc-1' }, { route: 'oc-2' }]
`,
  'china-gateways': `export const CHINA_GATEWAY_TEMPLATES = [{ route: 'cn-1' }]
`,
  'foreign-gateways': `export const FOREIGN_GATEWAY_TEMPLATES = [{ route: 'fg-1' }]
`,
  azure: `export const AZURE_TEMPLATES = [{ route: 'az-1' }]
`,
}

let root

/** Write a synthetic runtime tree, overriding or omitting individual tables. */
function tree(overrides = {}) {
  mkdirSync(join(root, CLI_LIB), { recursive: true })
  for (const [name, source] of Object.entries({ ...TABLES, ...overrides })) {
    if (source === null) continue
    writeFileSync(join(root, CLI_LIB, `${name}.js`), source)
  }
  return root
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-catalogue-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the derived catalogue expectation', () => {
  it('sums the core templates, the builtin and the four gateway groups', async () => {
    const expected = await catalogueExpectation(tree())
    // `'c'` is the hidden row, so it is a template but not an expected mount.
    expect(expected.allTemplateIds).toEqual(['a', 'b', 'c'])
    expect(expected.coreTemplateIds).toEqual(['a', 'b'])
    expect(expected.hiddenBySwitch).toEqual(['c'])
    expect(expected.catalogueOnlyRoutes).toEqual(['c'])
    expect(expected.builtin).toBe('builtin-route')
    expect(expected.groups).toEqual({ opencode: ['oc-1', 'oc-2'], china: ['cn-1'], foreign: ['fg-1'], azure: ['az-1'] })
    expect(expected.gatewayRouteCount).toBe(5)
    // 2 mounting core (3 templates minus the hidden one) + 1 builtin + 5 gateway.
    expect(expected.total).toBe(8)
  })

  it('mounts the hidden row when its switch is turned on, which is what the switch is for', async () => {
    // The precedence rule the CLI uses: the environment beats the file, and the file beats the default.
    // This test is the reason `hiddenBySwitch` is derived rather than a constant: a run with the switch on
    // legitimately expects one more route, and the suite must not go red over a supported configuration.
    const saved = process.env.QIALIKE_BEE
    try {
      process.env.QIALIKE_BEE = '1'
      const on = await catalogueExpectation(tree())
      expect(on.hiddenBySwitch).toEqual([])
      expect(on.coreTemplateIds).toEqual(['a', 'b', 'c'])
      expect(on.total).toBe(9)

      process.env.QIALIKE_BEE = '0'
      const off = await catalogueExpectation(tree())
      expect(off.hiddenBySwitch).toEqual(['c'])
    } finally {
      if (saved === undefined) delete process.env.QIALIKE_BEE
      else process.env.QIALIKE_BEE = saved
    }
  })

  it('refuses when the hidden row is not a template row, rather than shrinking the expectation', async () => {
    // A renamed row would otherwise read as "one route fewer to mount", which is indistinguishable from the
    // CLI having removed it — and the point of this module is that those two must not look alike.
    await expect(catalogueExpectation(tree({
      llm: `export const PROVIDER_TEMPLATES = [{ route: 'a' }]
export const DEEPSEEK_OFFICIAL_ROUTE = 'builtin-route'
export const QIALIKE_BEE_ROUTES = ['not-a-template']
`,
    }))).rejects.toThrow(/QIALIKE_BEE_ROUTE/u)
  })

  it('refuses a missing hidden-row route export', async () => {
    await expect(catalogueExpectation(tree({
      llm: `export const PROVIDER_TEMPLATES = [{ route: 'a' }]
export const DEEPSEEK_OFFICIAL_ROUTE = 'builtin-route'
`,
    }))).rejects.toThrow(/QIALIKE_BEE_ROUTE/u)
  })

  it('moves the total when the CLI adds a provider, which is the whole point', async () => {
    // The drift that motivated the module: a table one entry longer must move the expectation, not break it.
    const grown = await catalogueExpectation(tree({
      llm: `export const PROVIDER_TEMPLATES = [{ route: 'a' }, { route: 'b' }, { route: 'c' }, { route: 'd' }]
export const DEEPSEEK_OFFICIAL_ROUTE = 'builtin-route'
export const QIALIKE_BEE_ROUTES = ['c']
`,
    }))
    // 4 templates minus the one hidden row, + builtin, + 5 gateway.
    expect(grown.total).toBe(9)
  })

  it('refuses rather than shrinking the expectation when a table is missing', async () => {
    // The failure this guard exists for: a renamed export reads as "this group mounted nothing", the
    // expected total quietly loses its routes, and the catalogue test then passes while the group is gone.
    await expect(catalogueExpectation(tree({ 'china-gateways': null }))).rejects.toThrow(/china-gateways/u)
  })

  it('refuses an empty table, not only a missing one', async () => {
    await expect(catalogueExpectation(tree({ azure: 'export const AZURE_TEMPLATES = []\n' })))
      .rejects.toThrow(/AZURE_TEMPLATES/u)
  })

  it('refuses a missing or empty core template list', async () => {
    await expect(catalogueExpectation(tree({ llm: 'export const DEEPSEEK_OFFICIAL_ROUTE = "x"\n' })))
      .rejects.toThrow(/PROVIDER_TEMPLATES/u)
    await expect(catalogueExpectation(tree({ llm: 'export const PROVIDER_TEMPLATES = []\nexport const DEEPSEEK_OFFICIAL_ROUTE = "x"\n' })))
      .rejects.toThrow(/PROVIDER_TEMPLATES/u)
  })

  it('refuses a missing builtin route id', async () => {
    await expect(catalogueExpectation(tree({ llm: 'export const PROVIDER_TEMPLATES = [{ route: "a" }]\n' })))
      .rejects.toThrow(/DEEPSEEK_OFFICIAL_ROUTE/u)
  })

  it('names the table it could not read, so the report says what moved', async () => {
    // The message is the whole diagnosis a reader gets, and it should say which export and which package.
    await expect(catalogueExpectation(tree({ opencode: 'export const SOMETHING_ELSE = [{ route: "x" }]\n' })))
      .rejects.toThrow(/opencode.*OPENCODE_TEMPLATES/su)
  })
})
