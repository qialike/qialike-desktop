/**
 * A shared credential reference is one key, not one route.
 *
 * THE BUG THIS PINS. Adding `Moonshot AI (China)` in the provider page stores the key under
 * `MOONSHOT_API_KEY`, and `moonshotai` resolves the same name — so `moonshotai` reported a key it
 * could not use and appeared in the list beside the row the user actually added. Measured with a
 * mainland key: `api.moonshot.cn` answers 200 with six models, `api.moonshot.ai` answers 401.
 *
 * WHY THE CASES BELOW ARE ENUMERATED RATHER THAN SAMPLED. Eight groups in the CLI's catalogue share
 * one reference, and the page has no per-vendor code — a rule that fixed Moonshot by name would
 * leave the other seven. The groups are read from the shipped catalogue when it is present, so a
 * group that appears in a later CLI release is covered without editing this file.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { credentialOwners, reportsKeyConfigured } from '../packages/qialike-desktop-providers/lib/credential-ownership.js'
import { DIST_DIR } from '../apps/desktop-bin/lib/paths.mjs'

const CATALOGUE = join(DIST_DIR, 'runtime', 'dsh', 'node_modules', '@qialike', 'qialike-app', 'lib', 'llm.js')

/** A page row, defaulting to what "the user added this one" looks like. */
const row = (route, apiKeyEnv, source = 'template') => ({ route, apiKeyEnv, source })

describe('credential ownership', () => {
  it('keeps a shared reference with the route the user configured', () => {
    // The reported case, reduced to its essentials.
    const rows = [
      row('moonshotai-cn', 'MOONSHOT_API_KEY', 'configured'),
      row('moonshotai', 'MOONSHOT_API_KEY'),
    ]
    const owners = credentialOwners(rows)
    expect(reportsKeyConfigured(rows[0], owners, true), 'the configured route lost its own key').toBe(true)
    expect(reportsKeyConfigured(rows[1], owners, true), 'an unconfigured route claimed the key').toBe(false)
  })

  it('keeps both when the user configured both', () => {
    const rows = [
      row('moonshotai-cn', 'MOONSHOT_API_KEY', 'configured'),
      row('moonshotai', 'MOONSHOT_API_KEY', 'configured'),
    ]
    const owners = credentialOwners(rows)
    for (const r of rows) expect(reportsKeyConfigured(r, owners, true), r.route).toBe(true)
  })

  it('still reports for every route when nothing is explicit', () => {
    // A key set outside this page — the TUI writes the same store — leaves no entry to attribute.
    // Hiding it would send a user who has a working key back to the first-run screen, so the old
    // behaviour survives exactly here and nowhere else.
    const rows = [row('moonshotai-cn', 'MOONSHOT_API_KEY'), row('moonshotai', 'MOONSHOT_API_KEY')]
    const owners = credentialOwners(rows)
    expect(owners.size, 'an unconfigured group was attributed').toBe(0)
    for (const r of rows) expect(reportsKeyConfigured(r, owners, true), r.route).toBe(true)
  })

  it('reports nothing when the store holds no value', () => {
    const rows = [row('moonshotai-cn', 'MOONSHOT_API_KEY', 'configured')]
    const owners = credentialOwners(rows)
    expect(reportsKeyConfigured(rows[0], owners, false)).toBe(false)
  })

  it('treats a route with no reference as unconfigured, whatever the store says', () => {
    // `deepseek-official` is the route this page deliberately leaves reference-less; it must not
    // borrow anyone else's answer.
    const owners = credentialOwners([row('deepseek-official', undefined, 'builtin')])
    expect(reportsKeyConfigured(row('deepseek-official', undefined, 'builtin'), owners, true)).toBe(false)
  })

  it('decides independent references independently', () => {
    const rows = [
      row('moonshotai-cn', 'MOONSHOT_API_KEY', 'configured'),
      row('moonshotai', 'MOONSHOT_API_KEY'),
      row('deepseek-official', 'DEEPSEEK_API_KEY', 'configured'),
    ]
    const owners = credentialOwners(rows)
    expect(reportsKeyConfigured(rows[2], owners, true), 'unrelated reference was withheld').toBe(true)
    expect(reportsKeyConfigured(rows[1], owners, true), 'shared reference leaked').toBe(false)
  })

  describe.skipIf(!existsSync(CATALOGUE))('every group the shipped catalogue shares', () => {
    it('withholds the key from every sibling but the configured route', async () => {
      const catalogue = await import(CATALOGUE)
      const byRef = new Map()
      for (const template of catalogue.PROVIDER_TEMPLATES) {
        if (template.apiKeyEnv === undefined) continue
        if (!byRef.has(template.apiKeyEnv)) byRef.set(template.apiKeyEnv, [])
        byRef.get(template.apiKeyEnv).push(template.route)
      }
      const shared = [...byRef.entries()].filter(([, routes]) => routes.length > 1)
      // If upstream stops sharing references this becomes vacuous rather than wrong — but it must
      // not silently pass on an empty set while the problem is still real.
      expect(shared.length, 'the catalogue no longer ships a shared reference').toBeGreaterThan(0)

      for (const [ref, routes] of shared) {
        // Configure the FIRST route of the group only; every sibling must stay quiet.
        const chosen = routes[0]
        const rows = routes.map((route) => row(route, ref, route === chosen ? 'configured' : 'template'))
        const owners = credentialOwners(rows)
        for (const r of rows) {
          expect(reportsKeyConfigured(r, owners, true), `${ref}: ${r.route} when only ${chosen} was added`)
            .toBe(r.route === chosen)
        }
      }
    })
  })
})
