/**
 * Every string our plugins show, in both languages.
 *
 * WHY THIS IS A TEST RATHER THAN A REVIEW. A missing translation key does not fail
 * anything: the harness's dictionary lookup returns the key itself when a locale has no
 * entry for it, so the window shows the literal word `discoverFailed` where a sentence
 * belongs — in whichever language the user is not reading. Nothing logs, nothing
 * throws, and the only way to notice is to switch language and read every surface in
 * both. That is exactly the kind of check that stops happening.
 *
 * Four failure modes, all silent, all asserted here:
 *
 *   1. **A key used but missing.** `t('remountNo')` with no `remountNo` in one locale.
 *   2. **An asymmetric locale.** The key exists in `zh` and not in `en`, so the
 *      fallback shows the *other* language mid-sentence.
 *   3. **A dead key.** A translation nothing looks up any more — harmless at runtime
 *      and a lie about coverage, which is how a locale file grows stale.
 *   4. **A dynamic key.** `t(row.source)` cannot be checked by scanning for string
 *      literals, and it is where a missing key actually hides in this codebase: the
 *      four values of the host's `source` field have to exist as keys. The check below
 *      reads the *type* that produces them, so adding a fifth state to the API fails
 *      this test rather than producing a raw identifier in the tag beside the provider
 *      name.
 *
 * THE DICTIONARIES ARE LOADED, NOT PARSED. They are extracted as object literals and
 * evaluated in a `vm`, so what is asserted is the object the bundle actually registers
 * rather than a regular expression's idea of it. The `t()` call sites are found by
 * scanning the source, which is the only way to see a lookup that never happens.
 *
 * WHAT IS NOT COVERED: that a translation is *good*, and that switching language
 * actually re-renders. The first is not mechanical. The second is a browser fact and is
 * asserted against a running window by `apps/desktop-bin/e2e.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/**
 * Our client bundles, and the locale namespace each registers.
 *
 * The brand bundle is deliberately absent: it renders geometry and the product's name,
 * and a brand name does not translate — the bundle says so where it declines to take a
 * `t` seat at all.
 *
 * `dynamicLookups` is the interesting field. A key reached through a variable cannot be
 * found by scanning for literals, so each such expression is declared here **with the
 * host type that produces its values** — the test reads that type and asserts every
 * member is a key in both locales. Widening the API therefore fails this test instead
 * of rendering an untranslated identifier beside a provider's name.
 */
const BUNDLES = [
  {
    file: join(ROOT, 'packages', 'qialike-desktop-providers', 'lib', 'client.js'),
    namespace: 'qialike-providers',
    dynamicLookups: {
      'row.source': {
        hostFile: join(ROOT, 'packages', 'qialike-desktop-providers', 'src', 'index.ts'),
        // `source: 'builtin' | 'configured' | 'template' | 'unlisted'`
        declaration: /source:\s*('[^']+'(?:\s*\|\s*'[^']+')*)/u,
      },
    },
  },
  {
    file: join(ROOT, 'packages', 'qialike-desktop-theme', 'lib', 'client.js'),
    namespace: 'qialike-theme',
    dynamicLookups: {},
  },
]

/**
 * Read a `const <name> = { … }` object literal out of a source file and evaluate it.
 *
 * The braces are matched by counting rather than by a regular expression, because the
 * dictionaries contain nested objects (the `groupOff` entry is a function, and the
 * welcome step is an object) and a lazy match would stop at the first inner `}`.
 *
 * @param source - the file's text.
 * @param name - the binding to read.
 * @returns the evaluated object.
 */
function readLiteral(source, name) {
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`no \`const ${name} = {\` in the bundle`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = source.slice(open, index + 1)
        // Evaluated in an empty context: the literals are data, and running them with
        // `new Function` would put the test's own scope in reach of a typo.
        return new Script(`(${literal})`).runInContext(createContext({}))
      }
    }
  }
  throw new Error(`\`const ${name} = {\` is never closed`)
}

/**
 * The keys a bundle looks up by name.
 *
 * Line and block comments are stripped first, so a comment that mentions a key — this
 * repository has several, explaining why a key exists — is not counted as a use.
 *
 * @param source - the file's text.
 * @returns the literal keys, and every non-literal lookup for the reader to account for.
 */
function lookupSites(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n')
  // `\b` so `t(` inside an identifier such as `split(` is not a call site.
  const calls = [...code.matchAll(/\bt\(([^)]*)\)/gu)].map((match) => match[1].trim())
  const literal = []
  const dynamic = []
  for (const argument of calls) {
    const single = /^'([^']*)'$/u.exec(argument)
    if (single !== null) literal.push(single[1])
    else dynamic.push(argument)
  }
  return { literal, dynamic }
}

const loaded = BUNDLES.map((bundle) => {
  const source = readFileSync(bundle.file, 'utf8')
  // The domain of each dynamic lookup, read from the host type that produces it rather
  // than restated here — a copy is what would drift.
  const dynamicKeys = {}
  for (const [expression, lookup] of Object.entries(bundle.dynamicLookups ?? {})) {
    const host = readFileSync(lookup.hostFile, 'utf8')
    const declaration = lookup.declaration.exec(host)?.[1]
    if (declaration === undefined) {
      throw new Error(`${bundle.namespace}: could not read the type behind \`t(${expression})\``)
    }
    dynamicKeys[expression] = [...declaration.matchAll(/'([^']+)'/gu)].map((match) => match[1])
  }
  return {
    ...bundle,
    source,
    en: readLiteral(source, 'en'),
    zh: readLiteral(source, 'zh'),
    sites: lookupSites(source),
    dynamicKeys,
  }
})

describe('our plugins’ dictionaries', () => {
  it('are found, so this suite cannot pass by reading nothing', () => {
    // The failure mode of a source-scanning test is finding nothing and reporting
    // success, so the shapes it depends on are asserted before they are used.
    expect(loaded).toHaveLength(2)
    for (const bundle of loaded) {
      expect(Object.keys(bundle.en).length, `${bundle.namespace} en entries`).toBeGreaterThan(10)
      expect(bundle.sites.literal.length, `${bundle.namespace} literal lookups`).toBeGreaterThan(10)
    }
  })

  it('register the namespace their own slots declare', () => {
    // A slot declares `locale: NS` and the harness binds a `t` for that namespace. A
    // dictionary registered under a different name is never read — the row would render
    // raw keys while the dictionaries sat unused, and both halves look correct alone.
    for (const bundle of loaded) {
      const declared = /const NS = '([^']+)'/u.exec(bundle.source)?.[1]
      expect(declared, `${bundle.namespace}: no \`const NS = '…'\``).toBeTypeOf('string')
      expect(declared).toBe(bundle.namespace)
      expect(bundle.source).toContain(`ctx.locale.register(NS, { en, zh })`)
    }
  })

  it('are registered for exactly the two locales the harness ships', () => {
    // The harness's own `LOCALES` is `{ zh, en }`. A third here would be dead weight and
    // a missing one would fall back to the other language mid-sentence.
    for (const bundle of loaded) {
      const registered = /ctx\.locale\.register\(NS, \{ ([^}]*) \}\)/u.exec(bundle.source)?.[1]
      expect(registered?.split(',').map((part) => part.trim()).sort()).toEqual(['en', 'zh'])
    }
  })
})

describe.each(loaded)('$namespace', (bundle) => {
  it('has the same keys in both locales', () => {
    // Failure 2. Compared as sets so a rename in one locale and a rename in the other
    // are two named failures rather than one silent asymmetry.
    const en = Object.keys(bundle.en).sort()
    const zh = Object.keys(bundle.zh).sort()
    expect(zh.filter((key) => !en.includes(key)), 'present in zh but not en').toEqual([])
    expect(en.filter((key) => !zh.includes(key)), 'present in en but not zh').toEqual([])
    expect(zh).toEqual(en)
  })

  it('resolves every key the bundle looks up by name', () => {
    // Failure 1, the one that shows a raw identifier to a user.
    const missing = [...new Set(bundle.sites.literal)].filter((key) => !(key in bundle.en))
    expect(missing, `${bundle.namespace}: keys used but not translated`).toEqual([])
  })

  it('has no key nothing looks up', () => {
    // Failure 3. A dead key is not a runtime problem, and that is precisely why it
    // accumulates: it makes the dictionary claim coverage it does not have. The values
    // a dynamic lookup can produce are added to the used set, because those keys are
    // reached through a variable and would otherwise read as dead.
    const used = new Set([
      ...bundle.sites.literal,
      ...Object.values(bundle.dynamicKeys).flat(),
    ])
    const dead = Object.keys(bundle.en).filter((key) => !used.has(key))
    expect(dead, `${bundle.namespace}: translated but never looked up`).toEqual([])
  })

  it('accounts for every dynamic lookup', () => {
    // Failure 4, and the reason this whole file exists rather than a lint rule. A
    // dynamic key cannot be checked by scanning for literals, so each one is declared
    // with the domain it ranges over — and that domain is read from the host code which
    // produces it, so widening the API fails here instead of rendering an untranslated
    // identifier in the window.
    for (const argument of bundle.sites.dynamic) {
      const keys = bundle.dynamicKeys[argument]
      expect(keys, `${bundle.namespace}: \`t(${argument})\` is not accounted for`).toBeTypeOf('object')
      expect(keys.length, `${bundle.namespace}: the domain of \`t(${argument})\` is empty`).toBeGreaterThan(0)
      for (const key of keys) {
        expect(bundle.en, `${bundle.namespace}.en: \`${key}\` from ${argument}`).toHaveProperty([key])
        expect(bundle.zh, `${bundle.namespace}.zh: \`${key}\` from ${argument}`).toHaveProperty([key])
      }
    }
    // And the converse: a declared domain whose lookup has gone away is a stale entry in
    // this file, which would quietly stop checking anything.
    for (const expression of Object.keys(bundle.dynamicKeys)) {
      expect(bundle.sites.dynamic, `${bundle.namespace}: \`${expression}\` is declared but not looked up`)
        .toContain(expression)
    }
  })

  it('translates every entry to a non-empty string or a formatter', () => {
    // An empty translation renders as nothing at all, which reads as a layout bug. A
    // function is how this repository handles interpolated entries (`groupOff` takes
    // the group's name), so both are allowed and nothing else is.
    for (const [locale, dict] of [['en', bundle.en], ['zh', bundle.zh]]) {
      for (const [key, value] of Object.entries(dict)) {
        const kind = typeof value
        expect(['string', 'function'], `${bundle.namespace}.${locale}.${key} is a ${kind}`).toContain(kind)
        if (kind === 'string') {
          expect(value.trim().length, `${bundle.namespace}.${locale}.${key} is empty`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('does not leave a key-shaped entry standing in for a translation', () => {
    // The signature of an entry added to silence a lookup without being written:
    // `'discoverFailed': 'discoverFailed'`. It passes every check above and reads as a
    // bug in the window, which is what this suite is for.
    //
    // ONLY CAMEL-CASE KEYS ARE FLAGGED, and the restriction is the difference between a
    // useful check and a noisy one. This repository's keys are camelCase identifiers
    // (`welcomeNeedsKey`, `groupOffHint`) precisely because they are not display text —
    // so a camelCase key whose value equals itself cannot be a translation. A
    // single-word key CAN be: the provider tag shows the host's own state name, so
    // `'configured': 'configured'` is the correct English for that state and
    // `'models': 'models'` is the correct English for the plural noun in "3 models".
    // Both are legitimate; neither is a missing translation.
    const isKeyShaped = (key) => /[a-z][A-Z]/u.test(key)
    for (const [locale, dict] of [['en', bundle.en], ['zh', bundle.zh]]) {
      const echoes = Object.entries(dict)
        .filter(([key, value]) => typeof value === 'string' && value === key && isKeyShaped(key))
        .map(([key]) => key)
      expect(echoes, `${bundle.namespace}.${locale}: entries that are just their key`).toEqual([])
    }
  })

  it('does not mix the two languages inside one dictionary', () => {
    // A `zh` entry that is entirely ASCII and looks like a sentence is nearly always an
    // English string left behind — `'save': 'Save'` in the Chinese dictionary shows
    // English to a Chinese user, which the key-set comparison cannot see. Identifiers
    // and symbols are exempt because Chinese UI text legitimately contains them
    // (`API 密钥`, `baseURL`).
    const looksEnglish = (value) => typeof value === 'string'
      && value.length > 3
      && /^[\x20-\x7e]+$/u.test(value)
      && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/u.test(value)
    const suspects = Object.entries(bundle.zh)
      .filter(([, value]) => looksEnglish(value))
      .map(([key, value]) => `${key}: ${String(value)}`)
    expect(suspects, `${bundle.namespace}.zh: entries that are plain English sentences`).toEqual([])
  })
})
