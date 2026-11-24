/**
 * Build-time patch: replace the conversation hero's headline with this product's own tagline.
 *
 * WHY THIS IS A PATCH RATHER THAN OUR OWN COPY OF THE STRING. The headline is rendered by the harness's
 * conversation plugin, which is a published client bundle we consume as an artifact (`web-shadow.mjs`
 * explains why it cannot be rebuilt here). The string lives in that bundle's own locale dictionaries, so
 * the only seams are the dictionary and the rendered DOM — and the dictionary is the one with a stable
 * anchor.
 *
 * WHAT IT REPLACES, AND WHY IT IS WORTH REPLACING. Upstream ships `hero.headline` as "Into the Unknown"
 * (zh: 探索未至之境), shown large and centred on the empty-session screen — the first thing a user reads,
 * above the workspace picker. That is the harness's own voice. This application is qialike, and the slot
 * is the product's one chance to say what it is about, so it says qialike's tagline instead.
 *
 * WHY THE TWO LOCALES DIFFER, WHICH `brand-title.mjs` DOES NOT DO. That patch writes one string to both
 * dictionaries, because a brand name does not translate. A tagline does, so this patch carries one value
 * per locale and differs from its sibling in exactly that way.
 *
 * HOW THE TWO ARE TOLD APART, since the key is identical in both and the values must differ. Not by
 * position in the file, and not by the current copy. Each dictionary is introduced by `const <locale> =
 * {` in the built bundle, so for every key occurrence the patch walks back to the nearest such
 * declaration and reads the locale from its name.
 *
 * The first attempt segmented the file instead — each dictionary running up to the next declaration — and
 * a test caught what that costs: the pattern recognised only `en` and `zh`, so a third locale shipped by
 * upstream would land inside the previous dictionary's segment and trip the "exactly one entry" check. A
 * build broken by a locale we do not even use is the wrong failure. Reading the nearest declaration
 * handles any number of dictionaries, and a locale this patch has no value for is simply left alone.
 *
 * THE ANCHOR IS THE KEY, and the value is replaced whatever it currently says — the same reasoning as
 * `brand-title.mjs`: anchoring on the current copy would make this patch fail the build every time
 * upstream rewords a translation, which is a maintenance cost for no safety. A missing *key* is the thing
 * worth failing on, and so is a dictionary that has stopped being identifiable.
 *
 * The patch is idempotent: it writes the render note below into the entry it replaces, and a second run
 * finds that note and returns without touching the file. A farm is rebuilt from scratch often, so both
 * paths matter — see the test.
 *
 * @module qialike-desktop/harness-patches/hero-headline
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker, and the shape a patched entry has. */
export const HERO_HEADLINE_MARKER = 'qialike:hero-headline'

/**
 * The one farm file carrying the headline.
 *
 * `dsh-client-ui-conversation` owns the empty-session skeleton, so the string is in its bundle. Verified
 * rather than assumed: the string appears in exactly three farm files (`src/client/locales.ts`,
 * `lib/types/client/locales.js` and `lib/client.js`), and `lib/client.js` is the only one the browser
 * loads — it is a self-contained bundle whose only external requires are react and cordis, and the
 * web-frontend dist that serves the shell does not contain the string at all.
 */
const TARGET = '-deepseek-ai-dsh-client-ui-conversation/lib/client.js'

/** The dictionary key whose value becomes the headline. */
const KEY = 'hero.headline'

/**
 * The tagline, per locale.
 *
 * A sentence rather than a brand name, so it is translated rather than copied into both dictionaries. The
 * English wording is "Do What You Like" — the product's own phrasing, corrected from a draft that read
 * "Do What Your Like", which is not English.
 */
export const HEADLINES = {
  en: 'Do What You Like',
  zh: '做你所爱',
}

/** The locales this patch writes to. A dictionary for any other locale is left alone. */
export const LOCALES = Object.keys(HEADLINES)

/**
 * Apply the patch to a farm.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when the file, a locale dictionary, or the key is absent.
 */
export function patchHeroHeadline({ root, log = () => {} }) {
  const path = join(root, TARGET)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: the hero-headline target ${TARGET} is missing from the farm at ${root}. `
      + 'Either the harness renamed @deepseek-ai/dsh-client-ui-conversation, or the farm is incomplete. '
      + 'Update TARGET in apps/desktop-bin/harness-patches/hero-headline.mjs.',
    )
  }
  const original = readFileSync(path, 'utf8')
  if (original.includes(HERO_HEADLINE_MARKER)) {
    log(`hero-headline: already applied (${TARGET})`)
    return [TARGET]
  }

  // The dictionaries are `const <locale> = {` in the built bundle. Matched by shape rather than by a list
  // of the locales we happen to write: upstream may add one, and a locale this patch does not care about
  // must not become a reason for the build to stop.
  // WHITESPACE AROUND `=` IS OPTIONAL, because harness 0.2.2-rc.3 ships minified bundles
  // (`const en={` rather than `const en = {`). Requiring the spaces reported "no dictionary" against a
  // bundle full of them, which reads like an upstream change of shape and is a formatting difference.
  const declaration = /const ([a-z]{2}(?:-[A-Za-z]{2,})?) ?= ?\{/gu
  const opens = [...original.matchAll(declaration)].map((match) => ({
    locale: match[1],
    at: match.index,
  }))

  // Collect the rewrites as spans against the ORIGINAL text, then apply them in one pass. Editing the
  // string while iterating would shift the offsets later occurrences are located by, and the damage would
  // be a locale patched with the wrong value or not at all — silent in both cases.
  // THE VALUE MAY BE DOUBLE-QUOTED OR BACKTICKED. The minifier emits backticks, and a pattern that
  // accepted only `"…"` would find no entry in a dictionary that still contains it — the same trap
  // `brand-title.mjs` documents at length.
  const keyPattern = new RegExp(`("${KEY.replace('.', '\\.')}"\\s*:\\s*)(?:"[^"]*"|\x60[^\x60]*\x60)`, 'gu')
  const spans = []
  const written = new Map()
  for (const match of original.matchAll(keyPattern)) {
    // The locale is the nearest declaration above the entry. Walking backwards rather than segmenting
    // forward means an unknown locale between two known ones changes nothing.
    const owner = opens.filter((open) => open.at < match.index).at(-1)
    if (owner === undefined) {
      throw new Error(
        `qialike-desktop: a ${JSON.stringify(KEY)} entry in ${TARGET} has no \`const <locale> = {\` `
        + 'declaration above it, so which locale it belongs to cannot be determined. The harness changed '
        + 'how its locales are emitted; update the declaration pattern in '
        + 'apps/desktop-bin/harness-patches/hero-headline.mjs.',
      )
    }
    const replacement = HEADLINES[owner.locale]
    // Left alone, deliberately: a locale we ship no value for keeps the harness's headline rather than
    // being patched with one of ours.
    if (replacement === undefined) continue
    if (written.has(owner.locale)) {
      throw new Error(
        `qialike-desktop: ${TARGET} has more than one ${JSON.stringify(KEY)} entry under its `
        + `"${owner.locale}" dictionary. Writing the same value to both would hide the duplicate.`,
      )
    }
    spans.push({
      from: match.index,
      to: match.index + match[0].length,
      text: `"${KEY}": "${replacement}" /* ${HERO_HEADLINE_MARKER} */`,
    })
    written.set(owner.locale, replacement)
  }

  // Two different failures, reported differently, because the fix is different: a dictionary that is gone
  // means the harness changed how locales are emitted, while a dictionary without the key means the key
  // moved or was renamed.
  for (const locale of LOCALES) {
    if (written.has(locale)) continue
    if (!opens.some((open) => open.locale === locale)) {
      throw new Error(
        `qialike-desktop: ${TARGET} declares no \`const ${locale} = {\` dictionary, so the hero headline `
        + `cannot be written for it. The harness changed how its locales are emitted; update LOCALES or the `
        + 'declaration pattern in apps/desktop-bin/harness-patches/hero-headline.mjs.',
      )
    }
    throw new Error(
      `qialike-desktop: the "${locale}" dictionary in ${TARGET} carries no ${JSON.stringify(KEY)} entry, `
      + 'so the hero headline cannot be set in that locale and the harness\'s own wording would ship. The '
      + 'harness moved or renamed the key; update KEY in '
      + 'apps/desktop-bin/harness-patches/hero-headline.mjs.\n'
      + '  · Do not delete this patch: without it the empty-session screen shows another product\'s '
      + 'tagline as the first thing a new user reads.',
    )
  }

  let patched = ''
  let cursor = 0
  for (const span of spans) {
    patched += original.slice(cursor, span.from) + span.text
    cursor = span.to
  }
  patched += original.slice(cursor)

  writeFileSync(path, patched)
  const report = LOCALES.map((locale) => `${locale}="${String(written.get(locale))}"`).join(' ')
  log(`hero-headline: ${report} (${TARGET})`)
  return [TARGET]
}
