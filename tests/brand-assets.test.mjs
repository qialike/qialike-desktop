/**
 * The brand assets: the artwork, the three files derived from it, and the two blues the wordmark uses.
 *
 * THE MARK HAS ONE SOURCE NOW. `apps/desktop-web/public/brand/qialike-bee.svg` is vendored artwork, and
 * all four renderings come from it: the sidebar mark and the hero mark through the markup the hand-written
 * client bundle inserts, and `favicon.svg`, `favicon-dark.svg` and `apps/desktop/build/icon.png` through
 * `apps/desktop-bin/brand-assets.mjs`.
 *
 * Each rendering is a **copy** of that artwork, and a copy that drifts is invisible: the sidebar would show
 * one bee and the browser tab another, with every other test still passing. What can be asserted differs by
 * rendering, and each test says which it is: the favicons and the bundle's markup can be compared against
 * the artwork exactly, and the launcher PNG cannot — it is rasterised, so its form is asserted and its
 * regeneration command is printed by the generator.
 *
 * The one module left in this area is `apps/desktop-bin/lib/brand-colours.mjs`, which holds the two blues
 * the wordmark is drawn in; the mark's own colours come from its artwork.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRAND_BLUE, BRAND_BLUE_TONE } from '../apps/desktop-bin/lib/brand-colours.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const WEB_PUBLIC = join(ROOT, 'apps', 'desktop-web', 'public')
const CLIENT_BUNDLE = join(ROOT, 'packages', 'qialike-desktop-brand', 'lib', 'client.js')
const ICON = join(ROOT, 'apps', 'desktop', 'build', 'icon.png')
/** The vendored artwork the favicons and the launcher icon come from. */
const ARTWORK = join(WEB_PUBLIC, 'brand', 'qialike-bee.svg')

describe('the committed copies', () => {
  it('carries the artwork, verbatim, in the client bundle', () => {
    // This is the copy that cannot import anything, so it is the one most likely to go stale — and it is
    // the seat the user actually looks at, where the other three are the launcher and a browser tab.
    //
    // COMPARED AS THE WHOLE DRAWING, not as a path string. The bundle inserts the artwork's markup rather
    // than transcribing it, so the assertion can be exact: strip the template literal's own indentation and
    // the two are the same bytes. A transcription would have to be compared element by element, which is
    // the kind of check that passes while the drawing is wrong.
    const artwork = readFileSync(ARTWORK, 'utf8')
    const contents = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/u.exec(artwork)?.[1]
    expect(contents, 'the artwork has no <svg> body').toBeDefined()
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    const declared = /const MARK_MARKUP = `\n([\s\S]*?)`\n/u.exec(bundle)?.[1]
    expect(declared, 'the client bundle declares no MARK_MARKUP').toBeDefined()
    // COMPARED AS BYTES, because the bundle inserts the markup without reindenting it: the artwork's own
    // line indentation is what appears between the backticks, so anything that "tidied" it here would be a
    // reformat of the drawing. The only difference is the newline the template literal opens with.
    expect(declared.trimEnd(), 'the client bundle does not carry the artwork')
      .toBe(contents.replace(/^\n/u, '').trimEnd())
  })

  it('namespaces the artwork ids per seat, so two seats cannot collide', () => {
    // The artwork names ten gradients and four filters, and the bundle renders the mark in two places at
    // once. Duplicate ids in one document is invalid; it looks fine only while the two copies are
    // identical, and this test is what keeps that from being the reason it works.
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    const declaration = /function markMarkup\(seat\) \{([\s\S]*?)\n    \}/u.exec(bundle)?.[1]
    expect(declaration, 'markMarkup is gone').toBeDefined()
    expect(declaration).toContain('id="')
    expect(declaration).toContain('url(#')
    // And the two seats must not pass the same label.
    const seats = [...bundle.matchAll(/markMarkup\('([^']+)'\)/gu)].map(([, seat]) => seat)
    expect(seats.length, 'the mark is not rendered in two seats').toBe(2)
    expect(new Set(seats).size, `both seats namespace with ${seats.join('/')}`).toBe(2)
  })

  it('ships favicons that are the vendored artwork and nothing else', () => {
    // STRIPPING THE COMMENT IS THE ASSERTION. The two documents are the artwork plus a provenance note,
    // so removing the note has to leave the artwork exactly — which catches both a hand-edit of a favicon
    // and an edit of the artwork that the favicons were not regenerated after. Comparing whole files
    // instead would only prove the note is unchanged.
    const artwork = readFileSync(ARTWORK, 'utf8')
    for (const name of ['favicon.svg', 'favicon-dark.svg']) {
      const text = readFileSync(join(WEB_PUBLIC, name), 'utf8')
      const withoutComment = text.replace(/\n  <!--\n[\s\S]*?\n  -->/u, '')
      expect(withoutComment, `${name} is not the artwork`).toBe(artwork)
    }
  })

  it('ships a launcher icon that is a 512-square RGBA PNG', () => {
    // WHY THE BYTES AND NOT THE FORM USED TO BE ENOUGH, and why that changed. `icon.png` was a raster the
    // repository produced itself, from the same cell grid as everything else, so its bytes could be
    // compared against a fresh render. The artwork that replaced it is drawn with ellipses, curves and
    // strokes, which this repository has no rasteriser for — so the file is regenerated by Inkscape, and a
    // rasteriser's output is not byte-stable across versions. Failing on that would say nothing about the
    // artwork. What can be asserted without a rasteriser in the loop is the form electron-builder and the
    // desktop require, so that is what is asserted; the command that regenerates it is printed by
    // `brand-assets.mjs`.
    const png = readFileSync(ICON)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16), 'the launcher icon is not 512 wide').toBe(512)
    expect(png.readUInt32BE(20), 'the launcher icon is not 512 tall').toBe(512)
    expect(png[24], 'not 8-bit').toBe(8)
    expect(png[25], 'not RGBA').toBe(6)
    // A 512-square RGBA PNG of nothing would satisfy every field above, so the file also has to be big
    // enough to hold a drawing: a flat fill of one colour compresses to a few hundred bytes.
    expect(png.length, 'the launcher icon is too small to contain a drawing').toBeGreaterThan(1024)
  })

  it('draws the favicons in the palette the artwork brings, and nothing this repository used to draw', () => {
    // The colours are asserted separately from the geometry because a stale copy is exactly as invisible
    // as a stale path: the browser tab would show the old bee with nothing failing.
    for (const name of ['favicon.svg', 'favicon-dark.svg']) {
      const text = readFileSync(join(WEB_PUBLIC, name), 'utf8')
      // The artwork's plate and body, which no previous mark had: the plate is a radial gradient from
      // `#1E2A4A` to `#060912`, and the body one from `#FFE9A0` to `#9C5E00`, so the mid stops are what
      // name each. Checked as colours rather than as gradient ids because an id is a name someone can
      // reuse while the drawing changes underneath it.
      expect(text, `${name} has no dark plate`).toContain('#0E1428')
      expect(text, `${name} has no golden body`).toContain('#FFC93C')
      // Every ink this repository drew a bee with before, none of which may survive in a favicon now.
      // The last two are the mark's pre-bee inks, kept named so a copy of them cannot come back
    // unnoticed; the first two are the colours this repository drew the bee itself with.
    for (const gone of [BRAND_BLUE, '#ffcc00', '#201e1e', '#f1ecec']) {
        expect(text, `${name} still carries ${gone}`).not.toContain(gone)
      }
    }
  })

  it('carries both brand blues in the client bundle, matching the module', () => {
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    const ink = /const INK = '([^']+)'/u.exec(bundle)?.[1]
    const tone = /const TONE = '([^']+)'/u.exec(bundle)?.[1]
    expect(ink).toBe(BRAND_BLUE)
    expect(tone).toBe(BRAND_BLUE_TONE)
  })

  it('binds neither brand colour to a theme token any more', () => {
    // The reversal is deliberate and documented, so a token creeping back would silently make the
    // brand colour follow the theme again — the property this change gave up on purpose.
    //
    // Only the DECLARATIONS are checked, not the whole file: the comment above them names
    // `--dsw-alias-label-primary` on purpose, because explaining why a token was dropped means saying
    // which token it was. Banning the string would ban the explanation.
    const bundle = readFileSync(CLIENT_BUNDLE, 'utf8')
    const declared = [...bundle.matchAll(/const (?:INK|TONE) = '([^']+)'/gu)]
    expect(declared.length, 'the bundle no longer declares both brand colours').toBe(2)
    for (const [, value] of declared) {
      expect(value).not.toContain('var(')
      // A literal, so it is a colour and not something that resolves per theme.
      expect(value).toMatch(/^#[0-9a-f]{6}$/u)
    }
  })
})
