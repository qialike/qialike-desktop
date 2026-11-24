/**
 * The hero headline: the tagline patch, and the slot it replaces.
 *
 * The empty-session headline is shown large and centred, above the workspace picker — the first thing a
 * user reads in a new session. It ships as the harness's own copy ("Into the Unknown"), and this
 * application replaces it with its own. Nothing in this environment can click through that screen, so
 * these tests check the two things that would otherwise be wrong invisibly: a patch that writes the wrong
 * locale's value into the other, and a patch that stops matching after an upstream change.
 *
 * The locale lookup is the part worth testing hardest. The key is identical in both dictionaries, so the
 * only thing distinguishing them is the `const <locale> = {` declaration they sit under — and a patch
 * that got that wrong would print Chinese to English users, or the reverse, with every other test passing.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HEADLINES,
  HERO_HEADLINE_MARKER,
  LOCALES,
  patchHeroHeadline,
} from '../apps/desktop-bin/harness-patches/hero-headline.mjs'
import { memberDir } from '../apps/desktop-bin/lib/runtime-tree.mjs'
import { DIST_DIR } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')

/**
 * The patch's own fixture-relative target, as `patchHeroHeadline` writes and reports it.
 *
 * RELATIVE ON PURPOSE, and distinct from {@link RUNTIME_TARGET} below: these fixture tests
 * build a throwaway tree and the patch returns this name, so an absolute path here would
 * make `join(root, TARGET)` produce a nonsense path and every fixture test fail — which is
 * exactly what happened when the two were conflated.
 */
const TARGET = '-deepseek-ai-dsh-client-ui-conversation/lib/client.js'

/**
 * The same file inside the assembled runtime tree, at the path it actually has there.
 *
 * `memberDir` rather than a spelled-out layout: the runtime tree is de-linked after
 * assembly, so a member lives at `node_modules/<name>` and no longer at pnpm's
 * `packages/<flattened>` directory.
 */
const RUNTIME_TARGET = join(memberDir(RUNTIME_DIR, '@deepseek-ai/dsh-client-ui-conversation'), 'lib', 'client.js')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

describe('patchHeroHeadline', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-hero-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * The bundle's shape, reduced to what the patch reads: two locale dictionaries keyed identically, plus
   * the call site that mentions the key without a value.
   *
   * The call site is in the fixture on purpose — it is what makes a naive `"hero.headline"` replacement
   * wrong, and the real bundle has one.
   */
  function fixture({ zhFirst = true, headline = true, enExtra = '' } = {}) {
    const dict = (locale, value) => `const ${locale} = {
  "context.tools": "${locale} tools",
  "settings.enter.queue": "${locale} queue",
${headline ? `  "hero.headline": "${value}",\n` : ''}  "hero.preview": "${locale} preview",
  "hero.chooseWorkspace": "${locale} workspace",
}`
    const en = dict('en', 'Into the Unknown')
    const zh = dict('zh', '探索未至之境')
    const body = [
      zhFirst ? zh : en,
      enExtra,
      zhFirst ? en : zh,
      'const render = (t) => t("hero.headline")',
      'export const pick = (locale) => (locale === "zh" ? zh : en)',
    ].join('\n')
    const file = join(root, TARGET)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${body}\n`)
  }

  /** Read a dictionary entry out of the patched file, by locale. */
  function entry(locale) {
    const text = readFileSync(join(root, TARGET), 'utf8')
    const start = text.indexOf(`const ${locale} = {`)
    const next = text.indexOf('const ', start + 1)
    const segment = text.slice(start, next === -1 ? undefined : next)
    return /"hero\.headline":\s*"([^"]*)"/u.exec(segment)?.[1]
  }

  it('writes each locale its own value, in the dictionary that locale owns', () => {
    fixture()
    patchHeroHeadline({ root })
    expect(entry('en')).toBe(HEADLINES.en)
    expect(entry('zh')).toBe(HEADLINES.zh)
    // The point of the whole patch: the two must not be equal, so a test that only checked one of them
    // would pass even if the lookup collapsed to a single value.
    expect(entry('en')).not.toBe(entry('zh'))
  })

  it('does not depend on which dictionary comes first in the bundle', () => {
    // The bundle this was written against has `zh` before `en`, and nothing promises that in the next
    // one. Reading the declarations and sorting them is what makes the patch independent of it.
    fixture({ zhFirst: false })
    patchHeroHeadline({ root })
    expect(entry('en')).toBe(HEADLINES.en)
    expect(entry('zh')).toBe(HEADLINES.zh)
  })

  it('replaces the value whatever it currently says, so an upstream reword is not a build failure', () => {
    // Anchoring on the copy would mean failing every time upstream rewords a translation. The key is the
    // contract; the value is not.
    const file = join(root, TARGET)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'const en = {\n  "hero.headline": "Some New Wording",\n}\nconst zh = {\n  "hero.headline": "某个新说法",\n}\n')
    patchHeroHeadline({ root })
    expect(entry('en')).toBe(HEADLINES.en)
    expect(entry('zh')).toBe(HEADLINES.zh)
  })

  it('leaves a locale it has no value for alone, wherever upstream puts it', () => {
    // Upstream shipping a third locale is not a reason to stop building.
    //
    // This test is why the patch looks the way it does. The first implementation segmented the file, each
    // dictionary running up to the next declaration, and recognised only `en` and `zh` — so this fixture
    // put the third dictionary's entry inside the previous segment and the build failed with "expected
    // exactly one entry, found 2". A locale we do not even ship broke the build. Reading the nearest
    // declaration above each entry fixed it, and both positions are asserted so it stays fixed.
    for (const position of ['between', 'after']) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      const ja = 'const ja = {\n  "hero.headline": "未知の世界へ",\n}'
      fixture(position === 'between' ? { enExtra: ja } : {})
      if (position === 'after') {
        const file = join(root, TARGET)
        writeFileSync(file, `${readFileSync(file, 'utf8')}${ja}\n`)
      }
      patchHeroHeadline({ root })
      expect(entry('ja'), `the ja dictionary was not preserved when placed ${position}`).toBe('未知の世界へ')
      expect(entry('en')).toBe(HEADLINES.en)
      expect(entry('zh')).toBe(HEADLINES.zh)
    }
  })

  it('is idempotent, because a farm is rebuilt from scratch often', () => {
    fixture()
    patchHeroHeadline({ root })
    const once = readFileSync(join(root, TARGET), 'utf8')
    const again = patchHeroHeadline({ root, log: () => {} })
    expect(readFileSync(join(root, TARGET), 'utf8')).toBe(once)
    expect(again).toEqual([TARGET])
    // Two markers: one per locale, and no third from the second run.
    expect(once.split(HERO_HEADLINE_MARKER)).toHaveLength(3)
  })

  it('does not touch the call site, which mentions the key with no value', () => {
    fixture()
    patchHeroHeadline({ root })
    const text = readFileSync(join(root, TARGET), 'utf8')
    // The rendered expression must survive verbatim, or the headline would be baked in rather than
    // looked up per locale.
    expect(text).toContain('t("hero.headline")')
    expect(text).toContain('locale === "zh" ? zh : en')
  })

  it('refuses when a locale dictionary is gone, rather than patching nothing', () => {
    const file = join(root, TARGET)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'const en = {\n  "hero.headline": "Into the Unknown",\n}\n')
    expect(() => patchHeroHeadline({ root })).toThrow(/no `const zh = \{` dictionary/u)
  })

  it('refuses when the key is absent from a dictionary it must write', () => {
    // Without this the patch would silently write nothing and the upstream headline would ship under our
    // own brand — the failure this whole module exists to prevent. Reported as a missing KEY rather than
    // as a missing dictionary, because that is the different fix.
    fixture({ headline: false })
    expect(() => patchHeroHeadline({ root })).toThrow(/carries no "hero\.headline" entry/u)
  })

  it('says which of the two problems it hit, because the fixes differ', () => {
    // A dictionary that is gone means the harness changed how it emits locales; a dictionary without the
    // key means the key moved. Same refusal, different message — an earlier version used one message for
    // both and the test that caught it is why these assertions exist.
    const file = join(root, TARGET)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'const en = {\n  "hero.headline": "Into the Unknown",\n}\n')
    expect(() => patchHeroHeadline({ root })).toThrow(/declares no `const zh = \{` dictionary/u)
    rmSync(file)
    fixture({ headline: false })
    expect(() => patchHeroHeadline({ root })).toThrow(/carries no "hero\.headline" entry/u)
  })

  it('refuses when the target file is missing', () => {
    expect(() => patchHeroHeadline({ root })).toThrow(/missing from the farm/u)
  })

  it('carries one value per locale, translated rather than copied', () => {
    // A tagline is a sentence, unlike the brand name `brand-title.mjs` writes to both dictionaries. If
    // this ever collapses to one string, the reason for this patch having two values is gone.
    expect(LOCALES).toEqual(['en', 'zh'])
    expect(new Set(Object.values(HEADLINES)).size).toBe(LOCALES.length)
    // The wording that was requested, including the correction to its grammar.
    expect(HEADLINES.en).toBe('Do What You Like')
    expect(HEADLINES.en).not.toMatch(/\bYour\b/u)
  })
})

describe.skipIf(!assembled)('the assembled runtime', () => {
  it('ships the tagline in both locales of the conversation bundle it serves', () => {
    // The farm patch is what ships, but this reads the assembled runtime — so a patch that stopped being
    // applied by the build shows up here rather than only on screen.
    const file = RUNTIME_TARGET
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(`"hero.headline": "${HEADLINES.en}"`)
    expect(text).toContain(`"hero.headline": "${HEADLINES.zh}"`)
    // And the harness's own copy is gone from the file the browser loads.
    expect(text).not.toContain('Into the Unknown')
    expect(text).not.toContain('探索未至之境')
  })

  it('leaves no second copy of the headline in the shell bundle that serves it', () => {
    // Verified when the patch was written, and asserted because it is the assumption the single TARGET
    // rests on: if the web-frontend dist ever inlined this dictionary, patching the plugin bundle would
    // stop being enough and the screen would keep showing the harness's headline.
    const dist = join(memberDir(RUNTIME_DIR, '@deepseek-ai/dsh-web-frontend'), 'dist')
    if (!existsSync(dist)) return
    const hits = []
    const walk = (dir) => {
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, dirent.name)
        if (dirent.isDirectory()) { walk(path); continue }
        if (!dirent.name.endsWith('.js')) continue
        if (readFileSync(path, 'utf8').includes('hero.headline')) hits.push(path)
      }
    }
    walk(dist)
    expect(hits, `the headline dictionary is inlined in ${hits.join(', ')}`).toEqual([])
  })
})
