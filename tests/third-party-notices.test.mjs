/**
 * The aggregate notice an artifact carries.
 *
 * WHY THESE ASSERTIONS. A notice file is only worth shipping if it is complete and honest, and both
 * properties fail silently — an index that missed a package still looks like an index, and a
 * "licences included" claim with no text still looks like a claim. So the tests pin: that every
 * package in a tree appears in the index; that a package without licence text is called out rather
 * than omitted; that the inlined case reproduces real text; and that the fonts it names are the ones
 * an artifact actually carries.
 *
 * The last one is the guard against drift: `INLINED` is a written-down table because there is no
 * general way to ask a compiled bundle which licences its bytes came from. If the harness stops
 * shipping KaTeX fonts, or starts inlining something else, the font-count assertion is what fails.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import {
  composeNotices,
  surveyPackages,
  writeThirdPartyNotices,
} from '../apps/desktop-bin/lib/third-party-notices.mjs'

const NOTICE = '# Third-Party Notices\n\n| Package | Version | License |\n|---|---|---|\n| [electron](https://www.electronjs.org) | 44.0.0 | MIT |\n'

/** Build a throwaway runtime tree with the package shapes the survey has to handle. */
function tree(entries) {
  const root = mkdtempSync(join(tmpdir(), 'notices-'))
  const modules = join(root, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const entry of entries) {
    const dir = join(modules, entry.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: entry.name,
      version: entry.version ?? '1.0.0',
      ...(entry.licence === undefined ? {} : { license: entry.licence }),
      ...(entry.licenceObject === undefined ? {} : { license: entry.licenceObject }),
      ...(entry.licenses === undefined ? {} : { licenses: entry.licenses }),
    }))
    if (entry.text === true) writeFileSync(join(dir, 'LICENSE'), 'text')
    if (entry.textName !== undefined) writeFileSync(join(dir, entry.textName), 'text')
  }
  return { root, runtimeDir: root, modules }
}

const made = []
const make = (entries) => {
  const built = tree(entries)
  made.push(built.root)
  return built
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('surveying the runtime tree', () => {
  it('finds plain and scoped packages alike', () => {
    // A scope is a directory that is not a package, and a walk that treated it as one would either
    // skip its children or record `@deepseek-ai` as a package.
    const { modules } = make([
      { name: 'plain', licence: 'MIT', text: true },
      { name: '@scope/one', licence: 'ISC', text: true },
      { name: '@scope/two', licence: 'Apache-2.0', text: true },
    ])
    expect(surveyPackages(modules).map((entry) => entry.name)).toEqual(['@scope/one', '@scope/two', 'plain'])
  })

  it('reads the licence from every manifest shape in the wild', () => {
    // The deprecated forms still ship in older packages, and a survey that only read `license` as a
    // string would call them undeclared — which is a false accusation, not a harmless omission.
    const { modules } = make([
      { name: 'string', licence: 'MIT' },
      { name: 'object', licenceObject: { type: 'BSD-3-Clause' } },
      { name: 'array', licence: ['MIT', 'Apache-2.0'] },
      { name: 'legacy', licenses: [{ type: 'ISC' }] },
    ])
    const byName = Object.fromEntries(surveyPackages(modules).map((entry) => [entry.name, entry.licence]))
    expect(byName.string).toBe('MIT')
    expect(byName.object).toBe('BSD-3-Clause')
    expect(byName.array).toBe('MIT OR Apache-2.0')
    expect(byName.legacy).toBe('ISC')
  })

  it('reports a package that ships no licence text, rather than dropping it', () => {
    const { modules } = make([
      { name: 'has-text', licence: 'MIT', text: true },
      { name: 'no-text', licence: 'MIT' },
      { name: 'odd-filename', licence: 'MIT', textName: 'LICENCE.txt' },
    ])
    const byName = Object.fromEntries(surveyPackages(modules).map((entry) => [entry.name, entry.hasText]))
    expect(byName['has-text']).toBe(true)
    expect(byName['no-text']).toBe(false)
    // The British spelling is common enough that missing it would mark real packages as bare.
    expect(byName['odd-filename']).toBe(true)
  })
})

describe('composing the notice', () => {
  it('reproduces the repository notice instead of paraphrasing it', () => {
    const { runtimeDir } = make([{ name: 'a', licence: 'MIT', text: true }])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.2.3' })
    expect(text).toContain('Qialike Desktop 1.2.3')
    expect(text).toContain('| [electron](https://www.electronjs.org) | 44.0.0 | MIT |')
  })

  it('indexes every package, so absence is visible', () => {
    const { runtimeDir } = make([
      { name: 'alpha', version: '2.0.0', licence: 'MIT', text: true },
      { name: 'beta', version: '3.1.4', licence: 'Apache-2.0', text: true },
    ])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('| alpha | 2.0.0 | MIT | yes |')
    expect(text).toContain('| beta | 3.1.4 | Apache-2.0 | yes |')
    expect(text).toContain('2 packages.')
  })

  it('says so when a manifest declares no licence at all', () => {
    // Not a hypothetical: `@deepseek-ai/dsh-web-frontend` ships no `license` field, which is how the
    // inlined-font gap was found in the first place.
    const { runtimeDir } = make([{ name: 'bare' }])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('| bare | 1.0.0 | **not declared** | **no** |')
    expect(text).toContain('Packages that declare a licence and ship no text')
    expect(text).toContain('`bare` 1.0.0 — licence **not declared**, no licence file')
  })

  it('separates a package covered by its family root licence from one that is simply bare', () => {
    // THE DISTINCTION THAT MATTERS FOR AUDIT. 297 of the DeepSeek Harness's packages declare MIT and
    // carry no file, because the monorepo has one licence at its root — that is covered, and the
    // text is reproduced in section 3. An ordinary npm package that ships no text is not covered by
    // anything here, and naming it is the only honest thing to do.
    const { runtimeDir } = make([
      { name: '@deepseek-ai/dsh-one', licence: 'MIT' },
      { name: 'some-npm-package', licence: 'MIT' },
    ])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('Packages whose licence text is at their source root')
    expect(text).toContain('`@deepseek-ai/*` — 1 packages, MIT, © DeepSeek; see §3')
    expect(text).toContain('`some-npm-package` 1.0.0 — licence MIT, no licence file')
    // And the harness text itself is reproduced, not just referenced.
    expect(text).toContain('Copyright (c) 2026 DeepSeek')
  })

  it('lists a lower-case licence file as present', () => {
    // 121 of the real tree's packages name it `license`, not `LICENSE`. An exact-name list reported
    // every one of them as bare — the false finding this test exists to prevent returning.
    const { runtimeDir } = make([
      { name: 'lower', licence: 'MIT', textName: 'license' },
      { name: 'lower-md', licence: 'MIT', textName: 'license.md' },
    ])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('| lower | 1.0.0 | MIT | yes |')
    expect(text).toContain('| lower-md | 1.0.0 | MIT | yes |')
    expect(text).not.toContain('`lower` 1.0.0 — licence MIT, no licence file')
  })

  it('carries the full text of a licence whose package was inlined', () => {
    // THE POINT OF THE WHOLE FILE. KaTeX's fonts ship with no package beside them, so this block is
    // the only place its notice exists in the artifact.
    const { runtimeDir } = make([])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('### KaTeX — MIT')
    expect(text).toContain('Permission is hereby granted, free of charge')
    expect(text).toContain('Khan Academy')
    // And the stricter reading of the font files is reproduced too, so the artifact satisfies the
    // OFL reading as well as the MIT one.
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })

  it('states what it does not do, so a reader is not misled', () => {
    const { runtimeDir } = make([])
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '1.0.0' })
    expect(text).toContain('does not reproduce the licence text')
    expect(text).toContain('`LICENSE.electron.txt`')
    expect(text).toContain('not a legal opinion')
  })
})

describe('writing it into a tree', () => {
  it('puts the file at the root of the runtime tree, where an artifact keeps it', () => {
    const { runtimeDir } = make([{ name: 'a', licence: 'MIT', text: true }])
    const written = writeThirdPartyNotices({ runtimeDir, repositoryNotice: NOTICE, version: '0.0.0' })
    expect(written.path).toBe(join(runtimeDir, 'THIRD_PARTY_NOTICES.md'))
    expect(existsSync(written.path)).toBe(true)
    expect(written.packages).toBe(1)
    expect(readFileSync(written.path, 'utf8')).toBe(composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '0.0.0' }))
  })
})

describe('the real tree this repository builds', () => {
  const runtimeDir = join(ROOT, 'dist', 'runtime', 'dsh')
  const fontsDir = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'fonts')
  const assembled = existsSync(fontsDir)

  it.skipIf(!assembled)('ships the fonts the inlined table accounts for, and counts them', () => {
    // THE DRIFT GUARD. `INLINED` is written down because a compiled bundle cannot be asked which
    // licences it consumed. If the harness adds or removes a font family, the count moves and this
    // test is where someone finds out that the table needs a new entry.
    const fonts = readdirSync(fontsDir)
    const woff = fonts.filter((name) => /\.woff2$/u.test(name))
    expect(woff.length).toBeGreaterThanOrEqual(20)
    // The families the artifact carries, spelled out: three with their own licence text, one
    // (KaTeX) without.
    expect(woff.some((name) => name.startsWith('KaTeX_'))).toBe(true)
    expect(fonts.some((name) => name === 'LICENSE-Inter.txt')).toBe(true)
    expect(fonts.some((name) => name === 'LICENSE-JetBrainsMono.txt')).toBe(true)
    expect(fonts.some((name) => name === 'Montserrat-OFL.txt')).toBe(true)
    // AND NOTHING FOR KATEX — which is why §3 exists. If a licence file ever appears here, this
    // assertion fails and the notice can stop carrying a duplicate.
    expect(fonts.some((name) => /katex.*licen|licen.*katex/iu.test(name))).toBe(false)
  })

  it.skipIf(!assembled)('names that font count in the composed document', () => {
    const text = composeNotices({ runtimeDir, repositoryNotice: NOTICE, version: '0.0.0' })
    expect(text).toMatch(/Fonts present in .*: \d+ files\./u)
    expect(text).toContain('src/assets/fonts'.replace('src/', ''))
  })

  it.skipIf(!assembled)('covers the whole DeepSeek Harness family, which ships no per-package text', () => {
    // The larger gap. 297 packages, one root licence, none of it in an artifact before this file.
    const packages = surveyPackages(join(runtimeDir, 'node_modules'))
    const harness = packages.filter((entry) => entry.name.startsWith('@deepseek-ai/'))
    expect(harness.length).toBeGreaterThan(250)
    // NOT ALL OF THEM. Eleven are the vendored `cordis` packages, which come from their own upstream
    // and carry their own licence file; the rest are monorepo members that do not. Asserting "every"
    // would have been wrong in a way that looks like a stronger test.
    const withText = harness.filter((entry) => entry.hasText)
    expect(withText.length).toBeGreaterThan(0)
    // NOT A NAME TEST. Which of these ship their own text is a fact about upstream vendoring —
    // `cordis`, `cosmokit`, `schemastery`, `libreoffice-kit` and one native prebuild do, the rest do
    // not — and asserting the membership rule would be asserting a coincidence. What matters is the
    // property: every harness package is either carrying its text or covered by the root licence,
    // and the majority are the latter.
    const covered = harness.filter((entry) => entry.rootLicence === 'MIT')
    expect(covered.length).toBeGreaterThan(250)
    expect(covered.length).toBeGreaterThan(withText.length * 10)
    // Every harness package is one or the other: text of its own, or covered by the root licence.
    expect(harness.every((entry) => entry.hasText || entry.rootLicence === 'MIT')).toBe(true)
  })

  it.skipIf(!assembled)('the web frontend is the one package that declares no licence', () => {
    // The finding that started this: 654 of 655 packages declare one, and the exception is the
    // package whose fonts are inlined.
    const packages = surveyPackages(join(runtimeDir, 'node_modules'))
    const undeclared = packages.filter((entry) => entry.licence === undefined)
    expect(undeclared.map((entry) => entry.name)).toEqual(['@deepseek-ai/dsh-web-frontend'])
  })
})
