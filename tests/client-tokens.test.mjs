/**
 * The tokens our own client bundles reference.
 *
 * THE FAILURE THIS CATCHES IS INVISIBLE BY CONSTRUCTION. A CSS custom property that
 * the harness does not define is not an error: with no fallback it resolves to
 * nothing, and with a fallback it uses the fallback forever. Either way the styling
 * looks deliberate, the theme picker appears to work, and one surface quietly never
 * follows the theme. No build, type-check or runtime check can see it.
 *
 * This suite found exactly that in the providers settings page — five references to
 * `--dsw-alias-border-secondary` and one to `--dsw-alias-bg-accent`, neither of which
 * the harness defines, each carrying a hardcoded hex fallback. The settings page was
 * therefore pinned to `#333` and `#1f6feb` in all sixteen themes, and nothing said so.
 *
 * The check is deliberately one-directional: every token we reference must exist. It
 * does NOT assert that we reference particular tokens — which tokens a page needs is
 * that page's business, and a list here would have to be maintained against every
 * edit to a bundle.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectHarnessTokens, referencedTokens } from '../apps/desktop-bin/lib/harness-tokens.mjs'
import { ROOT, harnessRoot } from '../apps/desktop-bin/lib/paths.mjs'

/** Every hand-written client bundle this repository ships. */
const BUNDLES = [
  'packages/qialike-desktop-providers/lib/client.js',
  'packages/qialike-desktop-brand/lib/client.js',
  'packages/qialike-desktop-theme/lib/client.js',
]

/** The harness's own token vocabulary, scanned once. */
const harness = harnessRoot()
const tokens = collectHarnessTokens(harness)

describe('the harness token vocabulary', () => {
  it('is read from the checkout, and is not empty', () => {
    // A scan that found nothing would make every assertion below vacuously true.
    expect(tokens.size).toBeGreaterThan(200)
    // Spot checks against names the bundles are known to use, so a scan that broke
    // in a way which still returned *some* names cannot pass.
    expect(tokens.has('--dsw-alias-label-primary')).toBe(true)
    expect(tokens.has('--dsw-alias-border-l2')).toBe(true)
  })

  it('does not contain the two names that were wrong', () => {
    // Recorded as a fact rather than left implicit: if the harness ever *adds*
    // `--dsw-alias-border-secondary`, the fix below becomes an override rather than
    // a correction, and the next person should see that from the test.
    expect(tokens.has('--dsw-alias-border-secondary')).toBe(false)
    expect(tokens.has('--dsw-alias-bg-accent')).toBe(false)
  })
})

describe.each(BUNDLES)('%s', (relative) => {
  const source = readFileSync(join(ROOT, relative), 'utf8')

  it('references no token the harness does not define', () => {
    const unknown = referencedTokens(source).filter((token) => !tokens.has(token))
    expect(
      unknown,
      `${relative} names token(s) the harness never defines. Each is either a typo or a name that moved `
      + 'upstream, and either way the property resolves to nothing — or to a hardcoded fallback, which '
      + 'pins the surface to one colour in every theme.',
    ).toEqual([])
  })
})

describe('the providers settings page', () => {
  const source = readFileSync(join(ROOT, BUNDLES[0]), 'utf8')

  it('carries no hardcoded colour fallback on a token reference', () => {
    // The second half of the same defect. Even with valid token names, a
    // `var(--token, #hex)` fallback silently becomes the real colour the moment the
    // token is missing from a theme — which is precisely how the page stayed grey in
    // all sixteen schemes while looking like it was themed.
    const fallbacks = [...source.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,8})/gu)]
    expect(fallbacks.map((match) => `${match[1]} -> ${match[2]}`)).toEqual([])
  })

  it('still has a colour for every surface it paints', () => {
    // The control for the two assertions above: a bundle with no colours at all would
    // satisfy them trivially. The page deliberately keeps a few literal colours where
    // none of the sixteen schemes can supply the right one — the badge foregrounds —
    // so those are expected rather than forbidden. See the file's own comments.
    expect(source).toMatch(/var\(--dsw-alias-/u)
    expect(source).toMatch(/#[0-9a-fA-F]{3,8}/u)
  })
})
