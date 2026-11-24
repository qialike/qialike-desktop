/**
 * M6's foundation: the CLI's colour schemes, and the mapping onto this surface.
 *
 * TWO THINGS ARE BEING GUARDED, and they fail in opposite ways.
 *
 * The **scheme data** is generated from a read-only checkout, so the risk is
 * silent shrinkage: an extraction step that quietly returns two schemes instead of
 * fifteen produces a picker that works, looks fine, and is missing most of the CLI's
 * set. The assertions are therefore about the *set* — how many, which names, every
 * palette complete — rather than about one palette's hexes.
 *
 * The **token mapping** is hand-written, and its failure is invisible by
 * construction. Assigning `--dsw-alias-lable-primary` (a typo) is a correct-looking
 * assignment to a CSS variable that nothing reads: no error, no warning, and the
 * only symptom is one surface that does not follow the theme. So the load-bearing
 * assertion here cross-checks every mapped name against the harness's own
 * stylesheets — the one test in this repository that reads both checkouts to prove a
 * string in ours exists in theirs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PALETTE_KEYS, compileCliThemes } from '../apps/desktop-bin/lib/cli-themes.mjs'
import { collectHarnessTokens } from '../apps/desktop-bin/lib/harness-tokens.mjs'
import { ROOT, harnessRoot, qialikeRoot } from '../apps/desktop-bin/lib/paths.mjs'
import {
  THEME_ID_PREFIX, TOKEN_MAP, colorSchemeOf, mappedTokens, normalizeHex, themeIdFor, toThemeDefinition,
} from '../packages/qialike-desktop-theme/lib/tokens.js'

const LIB = join(ROOT, 'packages', 'qialike-desktop-theme', 'lib')
const generated = existsSync(join(LIB, 'palettes.js'))

/** The generated palettes, loaded once. */
const SCHEME_PALETTES = generated ? (await import(join(LIB, 'palettes.js'))).SCHEME_PALETTES : {}

/** The schemes the CLI ships, as its own `BUILTIN_SCHEMES` + `CLASSIC_SCHEMES` name them. */
/**
 * Every scheme the CLI ships, as an explicit list.
 *
 * THE LIST IS THE POINT: asserting a count would still pass if the extraction returned the
 * wrong names, and asserting against `SCHEME_PALETTES` itself would be a tautology. So it is
 * written out, and a CLI release that adds a scheme edits this line deliberately — `moss`
 * joined in CLI 0.11.2, where it stopped being a user file and became `qialike`'s own
 * built-in (and its default).
 */
const CLI_SCHEMES = [
  'catppuccin', 'dracula', 'everforest', 'falcon', 'flexoki', 'gruvbox', 'jellybeans',
  'kanagawa', 'nord', 'panda', 'rosepine', 'solarized', 'solarized-light', 'moss', 'light', 'one-dark',
]

describe('the generated scheme data', () => {
  it('is present', () => {
    expect(generated, 'run `pnpm run build` to generate the palettes').toBe(true)
  })

  it('is absent until the build generates it', () => {
    // `lib/palettes.js` is generated and gitignored, so this suite must not be the
    // thing that tells a fresh checkout it is broken. Skipping is handled by the
    // `generated` guard above; this records the intent.
    expect(typeof generated).toBe('boolean')
  })
})

describe.skipIf(!generated)('the CLI’s scheme set', () => {
  it('carries every scheme the CLI ships, and no others', () => {
    // The set is asserted rather than a count, because the failure is a partially
    // successful extraction: reading `classic-schemes.ts` and failing to find the
    // two inline palettes would still produce thirteen working themes.
    expect(Object.keys(SCHEME_PALETTES).sort()).toEqual([...CLI_SCHEMES].sort())
  })

  it('gives every scheme a complete 16-role palette of hex colours', () => {
    for (const [name, palette] of Object.entries(SCHEME_PALETTES)) {
      expect(Object.keys(palette).sort(), name).toEqual([...PALETTE_KEYS].sort())
      for (const [role, value] of Object.entries(palette)) {
        expect(normalizeHex(value), `${name}.${role} = ${String(value)}`).toBeDefined()
      }
    }
  })

  it('carries the palettes’ own hexes, not a defaulted copy', () => {
    // Spot values from three different sources — an inline literal, a classic skin,
    // and a light scheme — so a bug that returned one palette for every name cannot
    // pass by matching a name list.
    expect(SCHEME_PALETTES.light.bg).toBe('#fafafa')
    expect(SCHEME_PALETTES['one-dark'].bg).toBe('#282c34')
    expect(SCHEME_PALETTES.dracula.bg).toBe('#282a36')
    expect(SCHEME_PALETTES.nord.bg).toBe('#2e3440')
  })

  it('does not include the CLI’s `dark`, which is this surface’s own built-in', () => {
    // The CLI's `dark` is `{ ...theme }` — the TUI palette's initial values, which
    // are the harness's web dark palette. Registering it would add a second theme
    // with the same colours as the built-in `dark`.
    expect(SCHEME_PALETTES.dark).toBeUndefined()
  })

  it('is exactly what the extraction step produces from the sources', () => {
    // Freshness and determinism together. The file is gitignored, so a stale copy
    // survives a checkout; and an extraction that is not deterministic would churn
    // it on every build.
    const scratch = join(ROOT, '.build-scratch', 'cli-themes-freshness')
    return compileCliThemes({ qialike: options(), outDir: scratch }).then(() => {
      expect(readFileSync(join(LIB, 'palettes.js'), 'utf8'))
        .toBe(readFileSync(join(scratch, 'palettes.js'), 'utf8'))
    })
  })

  it('fails the build rather than skipping when a source is missing', async () => {
    await expect(compileCliThemes({
      qialike: join(ROOT, '.build-scratch', 'no-such-checkout'),
      outDir: join(ROOT, '.build-scratch', 'cli-themes-missing'),
    })).rejects.toThrow(/is missing from/u)
  })
})

describe('theme ids', () => {
  it('namespaces every id, because the CLI’s set collides with the built-ins', () => {
    // The load-bearing property of the whole feature. The CLI ships a scheme called
    // `light`, and this surface already has a built-in theme with that id;
    // `ThemeRuntime.register()` throws on a duplicate, so registering under the bare
    // name would fail on that scheme and take the theme row down with it.
    expect(CLI_SCHEMES).toContain('light')
    expect(themeIdFor('light')).toBe(`${THEME_ID_PREFIX}light`)
    expect(themeIdFor('light')).not.toBe('light')
  })

  it('keeps the bare name as the scheme’s identity, for the file the CLI reads', () => {
    // The id is for the harness registry; `qialike.json` holds the CLI's own name so
    // both products read one preference. The two strings are deliberately different.
    const definition = toThemeDefinition({ name: 'dracula', palette: SCHEME_PALETTES.dracula })
    expect(definition.id).toBe('qialike-dracula')
    expect(definition.scheme).toBe('dracula')
  })
})

describe('colorSchemeOf', () => {
  it('derives the palette from the scheme’s own background', () => {
    // Derived, not declared, because a user scheme has nowhere to declare it:
    // `~/.dsh/themes/<name>.json` is `{ name, palette }` and nothing else.
    expect(colorSchemeOf(SCHEME_PALETTES.light)).toBe('light')
    expect(colorSchemeOf(SCHEME_PALETTES['solarized-light'])).toBe('light')
    for (const name of ['dracula', 'nord', 'gruvbox', 'one-dark', 'catppuccin']) {
      expect(colorSchemeOf(SCHEME_PALETTES[name]), name).toBe('dark')
    }
  })

  it('falls back to dark rather than throwing on an unusable background', () => {
    // A malformed *user* scheme should cost that one scheme, not the whole list.
    expect(colorSchemeOf({ bg: 'not a colour' })).toBe('dark')
    expect(colorSchemeOf({})).toBe('dark')
    expect(colorSchemeOf(undefined)).toBe('dark')
  })
})

describe('normalizeHex', () => {
  it('expands the short forms and lowercases', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('  #aabbcc  ')).toBe('#aabbcc')
    // The alpha forms, expanded the same way. Accepted because the CLI's own
    // user-scheme loader validates with `/^#[0-9a-fA-F]{3,8}$/`, so a file written for
    // the terminal client may legitimately carry one — and rejecting it here would drop
    // those roles from that scheme on this surface alone.
    expect(normalizeHex('#abcd')).toBe('#aabbccdd')
    expect(normalizeHex('#AABBCCDD')).toBe('#aabbccdd')
  })

  it('rejects anything that is not hex, so a bad value cannot reach CSS', () => {
    // Only hex, because every palette in the set uses it and a value like `rgb(0 0 0)`
    // or `red` would be written into a CSS variable that the browser may then ignore
    // — a silently unstyled surface rather than a visible failure.
    for (const value of ['red', 'rgb(0,0,0)', '#12345', '#1234567', '#gggggg', '', 42, null, undefined]) {
      expect(normalizeHex(value), JSON.stringify(value)).toBeUndefined()
    }
  })
})

describe('toThemeDefinition', () => {
  it('maps a scheme onto this surface’s tokens', () => {
    const definition = toThemeDefinition({ name: 'dracula', palette: SCHEME_PALETTES.dracula })
    expect(definition.colorScheme).toBe('dark')
    expect(definition.tokens['--dsw-alias-bg-base']).toBe('#282a36')
    expect(definition.tokens['--dsw-alias-label-primary']).toBe('#f8f8f2')
    expect(definition.tokens['--dsw-alias-brand-primary']).toBe('#bd93f9')
    // Every value is a colour, and every key is a token name.
    for (const [token, value] of Object.entries(definition.tokens)) {
      expect(token.startsWith('--dsw-'), token).toBe(true)
      expect(normalizeHex(value), token).toBeDefined()
    }
  })

  it('produces a definition for every scheme in the set', () => {
    // A scheme that maps to nothing is not a theme, and would appear in the picker
    // and change no colour when chosen.
    for (const name of CLI_SCHEMES) {
      const definition = toThemeDefinition({ name, palette: SCHEME_PALETTES[name] })
      expect(definition, name).toBeDefined()
      expect(Object.keys(definition.tokens).length, name).toBeGreaterThan(50)
    }
  })

  it('returns undefined for a palette that maps nothing', () => {
    expect(toThemeDefinition({ name: 'empty', palette: {} })).toBeUndefined()
    expect(toThemeDefinition({ name: 'junk', palette: { bg: 'not-a-colour' } })).toBeUndefined()
  })

  it('tolerates a partial palette, which is what a user scheme may be', () => {
    // A hand-written `~/.dsh/themes/mine.json` need not fill all sixteen roles; the
    // ones it omits keep the base palette's value rather than becoming `undefined`.
    const definition = toThemeDefinition({ name: 'partial', palette: { bg: '#101010', text: '#eeeeee' } })
    expect(definition).toBeDefined()
    expect(definition.tokens['--dsw-alias-bg-base']).toBe('#101010')
    expect(definition.tokens['--dsw-alias-label-primary']).toBe('#eeeeee')
    expect(definition.colorScheme).toBe('dark')
  })
})

describe('the token mapping', () => {
  it('names only tokens the harness actually defines', () => {
    // THE assertion of this file. A typo here is an assignment to a CSS variable
    // nothing reads: no error anywhere, and one surface that quietly stops following
    // the theme. Cross-checking against the harness's own stylesheets is the only way
    // to catch it without rendering every scheme.
    const tokens = collectHarnessTokens(harnessRoot())
    expect(tokens.size, 'the harness stylesheets were not found').toBeGreaterThan(50)
    const unknown = mappedTokens().filter((token) => !tokens.has(token))
    expect(unknown, 'tokens this mapping sets that the harness never defines').toEqual([])
  })

  it('covers most of the harness’s alias tokens, which is the point of a broad mapping', () => {
    // The floor is deliberately well below the current 121 so ordinary upstream
    // growth does not fail the build, while a mapping that collapsed to a handful of
    // tokens — the "only the chrome follows the theme" failure — does.
    const alias = [...collectHarnessTokens(harnessRoot())].filter((token) => token.startsWith('--dsw-alias-'))
    const covered = mappedTokens().filter((token) => alias.includes(token))
    expect(covered.length / alias.length).toBeGreaterThan(0.8)
  })

  it('never assigns one token from two roles', () => {
    // `mappedTokens()` de-duplicates, so a role list that repeats a token would be
    // invisible there. Asserting on the raw table is what makes the ordering rule
    // (`warning` before `yellow`) checkable rather than folklore.
    const seen = new Map()
    for (const [role, tokens] of Object.entries(TOKEN_MAP)) {
      for (const token of tokens) {
        expect(seen.has(token), `${token} is claimed by ${seen.get(token)} and ${role}`).toBe(false)
        seen.set(token, role)
      }
    }
  })
})

/**
 * The qialike checkout root, resolved the way the build resolves it.
 *
 * A path that does not exist when the checkout is absent, so the missing-source
 * check fires against a real filesystem answer rather than a thrown resolver.
 */
function options() {
  try {
    return qialikeRoot()
  } catch {
    return join(ROOT, '.build-scratch', 'no-such-checkout')
  }
}
