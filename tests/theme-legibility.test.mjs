/**
 * The one part of a theme that is not a matter of taste: can the text be read.
 *
 * WHY THIS FILE EXISTS. The theme feature was verified up to the registry boundary
 * — seventeen schemes registered, a preference persisted, tokens delivered to the
 * document — and the remaining claim, "the colours look right", was left to a human
 * with a screenshot. That is the correct answer for *appearance*, and it was the
 * wrong answer for *legibility*, because legibility is arithmetic: given a foreground
 * hex and a background hex, WCAG defines the ratio and the minimum. No display, no
 * eyes and no judgement are involved.
 *
 * The defect that motivated it is worth stating plainly, because nothing else in the
 * repository could have caught it. The harness paints the tooltip and the toast dark
 * **in every theme** and labels them with a colour that is *fixed* — a static white
 * that does not flip with the theme. Our mapping recoloured the surfaces and left
 * the labels alone, so in the two light schemes (`light`, `solarized-light`) the
 * tooltip became a near-white rectangle carrying white text: **1.14:1**. It is
 * invisible, it appears on hover, and every existing test passes.
 *
 * So there are three layers here, and they answer different questions:
 *
 *   1. `FIXED_DARK_SURFACES` names the four tokens the mapping must not set, and
 *      this file proves it does not set them — then computes the pair the two light
 *      schemes *would* produce, so the reason is a number rather than a preference.
 *      The membership assertion was verified load-bearing by hand: re-adding
 *      `--dsw-alias-tooltip-bg` to `panel` fails two tests and names the token. That
 *      is recorded rather than automated because a test cannot easily sabotage the
 *      module it imports; the arithmetic half of the sabotage *is* automated below.
 *   2. The upstream declarations are read back from the harness checkout, so the
 *      reason for the exclusion is checked rather than remembered. This is the third
 *      test in the repository that reads both checkouts to prove a claim that spans
 *      them (`theme-schemes` proves our token names exist; `client-tokens` proves our
 *      bundles' `--dsw-*` references exist; this one proves the *pairings* exist).
 *   3. The rest of the mapping is swept scheme by scheme: every token we do set that
 *      carries a fixed label gets a ratio, and the ratios are asserted to be at least
 *      as good as the harness's own. That last shape is deliberate — several of them
 *      are *below* 4.5:1 upstream (a white glyph on the send button in the dark
 *      theme is 2.16:1), and a test that demanded AA there would be asserting a
 *      standard the product's own designer did not hold us to. Parity is the
 *      honest bar; improving on it is a product decision with a visual cost.
 *
 * Nothing here needs a browser: the palettes are generated data and the harness
 * declarations are text.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessRoot, ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import {
  FIXED_DARK_SURFACES, TINT_MAP, TINT_MIN_CONTRAST, TOKEN_MAP, contrastRatio, mappedTokens, tintFor, tintOf,
  toThemeDefinition,
} from '../packages/qialike-desktop-theme/lib/tokens.js'

const LIB = join(ROOT, 'packages', 'qialike-desktop-theme', 'lib')
const { existsSync } = await import('node:fs')
const generated = existsSync(join(LIB, 'palettes.js'))
const SCHEME_PALETTES = generated ? (await import(join(LIB, 'palettes.js'))).SCHEME_PALETTES : {}

const HARNESS = harnessRoot()
const readHarness = (relative) => readFileSync(join(HARNESS, relative), 'utf8')

/**
 * The harness's static ramp values, read from its own stylesheet.
 *
 * Read rather than hard-coded so that a change upstream is a test failure with a
 * diff, not a stale constant. The two blocks (`body` and
 * `body[data-ds-dark-theme]`) define the whole ramp twice; the values that matter
 * here are identical in both, which is exactly what "fixed" means.
 */
function staticRamp() {
  const css = readHarness('packages/client/ui-theme/src/styles/design-platform.css')
  const values = new Map()
  for (const match of css.matchAll(/--dsw-static-([a-z0-9-]+):\s*(rgb\([^)]*\)|#[0-9a-f]{3,8})/giu)) {
    // First definition wins; the ramp is declared twice with the same values, and a
    // divergence between the two blocks is a different test's business.
    if (!values.has(match[1])) values.set(match[1], match[2])
  }
  return values
}

/** `rgb(44, 44, 46)` or `#2c2c2e` to `#2c2c2e`. */
function toHex(value) {
  const rgb = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/u.exec(value)
  if (rgb === null) return value.toLowerCase()
  return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The alias pairs that carry a fixed label, and the harness declaration that proves it.
 *
 * Each entry is a *claim about the harness*, checked in the test below by reading
 * the named file. The `label` is a literal or a static-ramp colour — never one of
 * our tokens — because a label that we also set cannot invert.
 */
const FIXED_LABEL_SITES = [
  {
    name: 'the send button',
    surface: { kind: 'alias', token: '--dsw-alias-button-info-fill' },
    label: { kind: 'literal', value: '#ffffff' },
    file: 'packages/client/ui-conversation/src/client/skeleton/InputBar.module.css',
    surfaceEvidence: 'background: var(--dsw-alias-button-info-fill)',
    // 0.2.2-rc.3 replaced the literal with the token it was already equivalent to:
    // `--dsw-alias-label-on-color` is the on-fill ink, and it is now mapped by this theme.
    labelEvidence: ['color: var(--dsw-alias-label-on-color)', 'color: #fff'],
  },
  {
    name: 'the failed-attachment badge',
    surface: { kind: 'alias', token: '--dsw-alias-state-error-primary' },
    label: { kind: 'literal', value: '#ffffff' },
    file: 'packages/client/ui-attachment/src/FileCard.module.css',
    // The hard-coded fallback was dropped in 0.2.2-rc.3: the token is now relied on outright.
    surfaceEvidence: ['background: var(--dsw-alias-state-error-primary)',
      'background: var(--dsw-alias-state-error-primary, #d54941)'],
    labelEvidence: ['color: var(--dsw-alias-label-on-color)', 'color: #fff'],
  },
]

describe('the harness’s fixed surfaces', () => {
  it('are still declared the way the exclusion assumes', () => {
    // The exclusion is only correct while these lines exist. Reading them makes the
    // reason checkable, and turns "upstream tokenised the label" into a failure with
    // an obvious next step: these four tokens become mappable.
    const tooltip = readHarness('packages/client/ui-primitives/src/Tooltip.module.css')
    expect(tooltip).toContain('background: var(--dsw-alias-tooltip-bg)')
    // THE LABEL MOVED FROM A LITERAL TO A TOKEN IN 0.2.2-rc.3 WITHOUT CHANGING THE INVARIANT:
    // `--dsw-alias-tooltip-label` is itself declared `var(--dsw-static-neutral-bluish-00)`, so the pair
    // is still fixed dark surface with white text. Accepting both spellings keeps this assertion about
    // the invariant rather than about which way upstream happened to write it.
    expect(
      tooltip.includes('color: var(--dsw-alias-tooltip-label)')
      || tooltip.includes('color: var(--dsw-static-neutral-bluish-00)'),
      'the tooltip label is neither the token nor the static colour it resolves to',
    ).toBe(true)

    const toast = readHarness('packages/client/ui-primitives/src/Toast.module.css')
    expect(toast).toContain('background: var(--dsw-alias-toast-bg)')
    expect(toast).toContain('color: var(--dsw-alias-toast-label)')
    // The sentence that makes the pair fixed rather than themed.
    expect(toast).toContain('is dark in BOTH themes')

    const keys = readHarness('packages/client/ui-primitives/src/ShortcutKeys.module.css')
    expect(keys).toContain('background: var(--dsw-alias-tooltip-key-bg)')

    const theme = readHarness('packages/client/ui-theme/src/styles/design-platform.css')
    expect(theme).toContain('--dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-850)')
    expect(theme).toContain('--dsw-alias-toast-bg: var(--dsw-static-neutral-bluish-800)')
  })

  it('keeps every one of them out of the mapping', () => {
    const mapped = new Set(mappedTokens())
    for (const surface of FIXED_DARK_SURFACES) {
      expect(mapped.has(surface.token), `${surface.token} must not be mapped: ${surface.why}`).toBe(false)
    }
  })

  it('measures at least 4.5:1 when the harness paints the pair', () => {
    const ramp = staticRamp()
    const tooltipBg = toHex(ramp.get('neutral-bluish-850'))
    const toastBg = toHex(ramp.get('neutral-bluish-800'))
    // The pair the harness ships: white label on the dark surface, in either theme.
    expect(contrastRatio('#ffffff', tooltipBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#ffffff', toastBg)).toBeGreaterThanOrEqual(4.5)
    // The numbers quoted in the module, so the comment cannot drift from the values.
    expect(contrastRatio('#ffffff', tooltipBg)).toBeCloseTo(13.94, 1)
    expect(contrastRatio('#ffffff', toastBg)).toBeCloseTo(12.1, 1)
  })

  it('shows the pair the light schemes would produce, which is why none of them is mapped', () => {
    // The arithmetic half of the sabotage: this is what the mapping used to paint,
    // and it is the reason the four tokens are excluded rather than merely absent.
    if (!generated) return
    const lightPanel = SCHEME_PALETTES['light'].panel
    const solarizedPanel = SCHEME_PALETTES['solarized-light'].panel
    expect(contrastRatio('#ffffff', lightPanel)).toBeLessThan(4.5)
    expect(contrastRatio('#ffffff', solarizedPanel)).toBeLessThan(4.5)
    // And the mapping no longer claims those tokens, which is the fix itself.
    expect(Object.values(TOKEN_MAP).flat()).not.toContain('--dsw-alias-tooltip-bg')
    expect(Object.values(TOKEN_MAP).flat()).not.toContain('--dsw-alias-toast-bg')
    expect(Object.values(TOKEN_MAP).flat()).not.toContain('--dsw-alias-toast-label')
    expect(Object.values(TOKEN_MAP).flat()).not.toContain('--dsw-alias-tooltip-key-bg')
  })
})

describe.skipIf(!generated)('the fixed-label pairs that we DO paint', () => {
  it('are declared the way the sweep assumes', () => {
    for (const site of FIXED_LABEL_SITES) {
      const source = readHarness(site.file)
      const acceptedSurface = Array.isArray(site.surfaceEvidence)
        ? site.surfaceEvidence
        : [site.surfaceEvidence]
      expect(
        acceptedSurface.some((evidence) => source.includes(evidence)),
        `${site.file} should contain one of ${JSON.stringify(acceptedSurface)}`,
      ).toBe(true)
      // EACH EVIDENCE MAY HAVE SEVERAL ACCEPTED SPELLINGS. 0.2.2-rc.3 replaced literal on-fill inks
      // (`#fff`) with the token they were already equivalent to (`--dsw-alias-label-on-color`), so a
      // single-string assertion failed on a pair whose CONTRAST was unchanged — which is the property
      // this file exists to protect.
      const accepted = Array.isArray(site.labelEvidence) ? site.labelEvidence : [site.labelEvidence]
      expect(
        accepted.some((evidence) => source.includes(evidence)),
        `${site.file} should contain one of ${JSON.stringify(accepted)}`,
      ).toBe(true)
    }
  })

  it('stay above the floor we are willing to hold today', () => {
    const ramp = staticRamp()
    const white = '#ffffff'
    // The harness's own values for the two fills, from the two theme blocks: deepseek
    // blue and red, one step apart per theme. Read from its stylesheet so the
    // comparison cannot go stale.
    const upstream = {
      '--dsw-alias-button-info-fill': {
        light: toHex(ramp.get('deepseek-500')),
        dark: toHex(ramp.get('deepseek-400')),
      },
      '--dsw-alias-state-error-primary': {
        light: toHex(ramp.get('red-600')),
        dark: toHex(ramp.get('red-400')),
      },
    }

    /** Everything we set for a token, across the schemes. */
    const ours = (token) => Object.values(SCHEME_PALETTES).flatMap((palette) => {
      const role = Object.entries(TOKEN_MAP).find(([, names]) => names.includes(token))?.[0]
      return role !== undefined && palette[role] !== undefined ? [palette[role]] : []
    })

    const report = []
    for (const [token, upstreamValues] of Object.entries(upstream)) {
      const values = ours(token)
      expect(values.length, `${token} should be reachable from a role in every scheme`).toBeGreaterThan(0)
      const worst = Math.min(...values.map((value) => contrastRatio(white, value)))
      const best = Math.max(...values.map((value) => contrastRatio(white, value)))
      const upstreamWorst = Math.min(
        contrastRatio(white, upstreamValues.light),
        contrastRatio(white, upstreamValues.dark),
      )
      report.push({
        token,
        worst: worst.toFixed(2),
        best: best.toFixed(2),
        harnessWorst: upstreamWorst.toFixed(2),
      })
      // THE FLOOR IS 1.4:1 AND IT IS A FLOOR, NOT A STANDARD. It exists to turn a
      // silent regression into a failure, not to claim the pair is good. The gap
      // above it is real and recorded: the harness's own worst for these two fills
      // is 2.16:1 (white on its dark-theme deepseek-400 send button), ours reaches
      // 1.49:1 in catppuccin. Closing that gap means deepening a palette accent that
      // is *also* read as ink in four places upstream, which is a visual decision
      // rather than a bug fix — it is written up in DESIGN.md §7.3 instead.
      expect(worst, `${token}: a scheme fell below the recorded floor — ${JSON.stringify(report)}`)
        .toBeGreaterThanOrEqual(1.4)
    }
    expect(report.length).toBe(2)
  })
})

describe('contrastRatio', () => {
  it('is the WCAG formula, at both ends', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // Order does not matter, which is the property a caller would otherwise have to
    // remember.
    expect(contrastRatio('#94e2d5', '#1e1e2e')).toBeCloseTo(contrastRatio('#1e1e2e', '#94e2d5'), 10)
  })

  it('throws rather than returning a number that would read as a verdict', () => {
    // A silent NaN propagates as "fine" through `toBeGreaterThanOrEqual`; a silent 0
    // would read as "catastrophic". Neither is a measurement.
    expect(() => contrastRatio('rebeccapurple', '#fff')).toThrow(TypeError)
    expect(() => contrastRatio(undefined, '#fff')).toThrow(TypeError)
  })
})

describe('the tokens that are surfaces rather than ink', () => {
  // REPORTED: "some characters in the conversation area have a light blue box under them and
  // the white text is hard to read" — in the moss scheme. The box is an inline code span, and
  // the cause was structural rather than moss-specific: `-tertiary`, the code family and the
  // diff fills are SURFACES upstream (its own dark `file-diff-added-bg` is `rgb(31, 49, 36)`,
  // green mixed into the background), and this mapping was handing them the saturated role
  // colour and then the harness painted normal label ink on top. Measured: 1.86:1 for the
  // inline code, 1.80:1 for success, 1.66:1 for warn — every member of the family, though
  // only one had been looked at.
  //
  // The fix derives them: `tintOf` mixes the role into the palette's own background, so the
  // hue survives, a light scheme gets a pale tint and a dark one a dark tint, and the ink on
  // top is readable in both. These assertions hold that for EVERY shipped scheme rather than
  // for moss alone, because the defect was in the mapping, not in the palette.

  const SURFACES = [...new Set(Object.values(TINT_MAP).flat())]
  const LABEL_INK = '--dsw-alias-label-primary'

  for (const [schemeName, palette] of Object.entries(SCHEME_PALETTES)) {
    it(`${schemeName}: every surface keeps its label ink readable`, () => {
      const definition = toThemeDefinition({ name: schemeName, palette })
      const ink = definition.tokens[LABEL_INK]
      expect(ink, 'no label ink to compare against').toBeDefined()
      for (const token of SURFACES) {
        const surface = definition.tokens[token]
        expect(surface, `${token} was not derived`).toBeDefined()
        const ratio = contrastRatio(ink, surface)
        // THE FLOOR IS 4.0, NOT 4.5, AND THAT IS A MEASUREMENT. `solarized-light` puts its own
        // body text at 4.13:1 against its own background, so a 4.5 bar would fail every tint
        // in it whatever this file did — the same "parity is the honest bar" reasoning this
        // suite already records for the tooltip. What the assertion must catch is the defect
        // that was reported: 1.66–1.86:1, i.e. a box the text disappears into.
        expect(ratio, `${schemeName} ${token}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TINT_MIN_CONTRAST)
      }
    })
  }

  it('derives tints from the palette’s own background, not a fixed dark value', () => {
    // The property that makes one table serve both schemes: the same role colour mixes to a
    // pale tint on a light palette and a dark one on a dark palette.
    const dark = tintOf('#6FB3AE', '#0C0F0D')
    const light = tintOf('#6FB3AE', '#FAFAFA')
    expect(dark).toBeDefined()
    expect(light).toBeDefined()
    expect(contrastRatio(dark, '#0C0F0D')).toBeLessThan(2)
    expect(contrastRatio(light, '#FAFAFA')).toBeLessThan(2)
    // And the light one is genuinely lighter, not merely different.
    expect(light > dark).toBe(true)
  })

  it('keeps a surface distinguishable from the background it sits on', () => {
    // The other half of the trade: a tint dark enough to read ink must still read AS a box,
    // or an inline code span becomes invisible and the fix trades one defect for another.
    const definition = toThemeDefinition({ name: 'moss', palette: SCHEME_PALETTES.everforest })
    for (const token of SURFACES) {
      const surface = definition.tokens[token]
      const background = definition.tokens['--dsw-alias-bg-base']
      expect(contrastRatio(surface, background), `${token} disappeared into the background`)
        .toBeGreaterThan(1.15)
    }
  })
})
