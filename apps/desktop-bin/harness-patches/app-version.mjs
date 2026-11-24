/**
 * Show this product's version in Settings, not the harness's.
 *
 * WHY THIS PATCH EXISTS. Settings → General carries a version row, and upstream fills it from the harness
 * build it was compiled with. That is the right answer for upstream and the wrong one here: a user reading
 * it sees `0.2.1-alpha.2`, a version of a component they never installed and cannot act on, while the
 * updater in the same window is offering `0.3.x` and comparing it against this product's own releases. Two
 * numbers for one product, and the visible one is not the one that updates.
 *
 * WHY THE VERSION CANNOT BE WRITTEN DOWN HERE. It changes every release, so this patch is not a one-time
 * rewrite: it runs on a farm that may already carry the previous release's value and must replace it. That
 * is also why its idempotency rule differs from every other patch in this directory — they check for their
 * marker and stop, while this one has to check the VALUE, because a second build at a new version is the
 * normal case rather than a repeat.
 *
 * WHY THE ANCHOR IS THE CALL AND NOT THE NUMBER. Matching `"0.2.1-alpha.2"` would work exactly once. The
 * surrounding call — `t('general.currentVersion', { version: … })` — is the stable part, and it is also what
 * makes a missing match an error worth throwing: if upstream renames the key or stops passing a literal,
 * this patch must fail the build rather than leave the harness's number on screen.
 *
 * @module qialike-desktop/harness-patches/app-version
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker, written as a comment beside the value it replaced. */
export const APP_VERSION_MARKER = 'qialike:app-version'

/**
 * The farm files carrying the row.
 *
 * Only the served bundle is patched, and that is a measured distinction rather than an omission: the client
 * module loader resolves `exports['./client']`, which for this package is `lib/client.js` — the file the
 * bundler compiled the literal into. The sibling compiled copy under `lib/types/` reads
 * `process.env.DSH_CLIENT_VERSION` instead and carries no literal to replace, and it is not the file the
 * browser is served. `office-engine-message` patches its two copies because both carry the sentence; this
 * one has one copy to patch, and saying so is cheaper than a second edit that could only ever be a no-op.
 */
export const APP_VERSION_TARGETS = [
  '-deepseek-ai-dsh-client-ui-settings-general/lib/client.js',
]

/**
 * The call the version is read from, whichever quote style the bundler emitted.
 *
 * Captures the opening quote of the value so its closing quote is known: a version string cannot contain
 * that quote, so the first one after it ends the value.
 */
// BACKTICKS COUNT. Harness 0.2.2-rc.3 ships minified client bundles and the minifier emits
// `t(\`general.currentVersion\`,{version:\`0.2.2-rc.3\`})` — backticked and unspaced. A pattern that
// accepted only `'` and `"` found 0 matches in a bundle that still had the literal, which reads like
// upstream removed the row and is a quoting difference.
const ANCHOR = /general\.currentVersion['"`],\s*\{\s*version:\s*(['"`])/u

/**
 * Point the version row at this product's version.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.version - this product's version, as `package.json` declares it.
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when a target is absent, when the anchor is missing or ambiguous, or when the text after the
 *   value is not a shape this patch understands — each of the cases where it would otherwise write nothing
 *   and the harness's version would ship.
 */
export function patchAppVersion({ root, version, log = () => {} }) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`qialike-desktop: the app-version patch needs a version, got ${JSON.stringify(version)}.`)
  }
  const written = []
  for (const target of APP_VERSION_TARGETS) {
    const path = join(root, target)
    if (!existsSync(path)) {
      throw new Error(
        `qialike-desktop: the app-version target ${target} is missing from the farm at ${root}. Either the `
        + 'harness renamed @deepseek-ai/dsh-client-ui-settings-general, or the farm is incomplete. Update '
        + 'APP_VERSION_TARGETS in apps/desktop-bin/harness-patches/app-version.mjs.',
      )
    }
    const text = readFileSync(path, 'utf8')
    const matches = [...text.matchAll(new RegExp(ANCHOR, 'gu'))]
    if (matches.length !== 1) {
      throw new Error(
        `qialike-desktop: expected exactly one \`general.currentVersion\` literal in ${target}, found `
        + `${String(matches.length)}. The patch cannot tell which one to replace, and guessing would put this `
        + "product's version in the wrong place. Update ANCHOR in "
        + 'apps/desktop-bin/harness-patches/app-version.mjs.',
      )
    }
    const match = matches[0]
    const quote = match[1]
    const valueStart = match.index + match[0].length
    const valueEnd = text.indexOf(quote, valueStart)
    if (valueEnd === -1) {
      throw new Error(
        `qialike-desktop: could not find the end of the version string in ${target}. The call changed shape, `
        + 'so this patch would corrupt the bundle rather than edit it.',
      )
    }
    const previous = text.slice(valueStart, valueEnd)
    // Strip a marker left by an earlier build, then write exactly one back. Always removing rather than
    // checking first is what keeps this idempotent across VERSIONS as well as across repeats: the value must
    // be rewritten every release, so the marker cannot be the thing that decides whether to act.
    const afterQuote = text.slice(valueEnd + 1)
    const marker = `/* ${APP_VERSION_MARKER} */`
    const markerIndex = afterQuote.indexOf(marker)
    const withoutMarker = markerIndex === -1
      ? afterQuote
      : afterQuote.slice(0, markerIndex) + afterQuote.slice(markerIndex + marker.length)
    // The whitespace the marker occupied collapses to exactly one space, which is what the first run wrote.
    // Leaving it as it lay would make a rebuild differ from the build before it by a space — invisible in the
    // browser and enough to make "is this file already correct" unanswerable.
    const rest = ` ${withoutMarker.replace(/^\s+/u, '')}`
    const replacement = `${text.slice(0, valueStart)}${version}${quote} ${marker}${rest}`
    if (replacement === text) {
      log(`app-version: already ${version} (${target})`)
      written.push(target)
      continue
    }
    // THE CHECK MUST MATCH THE SHAPE THE BUNDLE IS IN, NOT THE SHAPE THIS PATCH PREFERS. It used to
    // assert the pretty `version: "0.7.0"`; minified bundles carry `version:`0.7.0`` with no space, so
    // a correct write failed its own verification.
    const expectPretty = `version: ${quote}${version}${quote}`
    const expectMinified = `version:${quote}${version}${quote}`
    if (!replacement.includes(expectPretty) && !replacement.includes(expectMinified)) {
      throw new Error(
        `qialike-desktop: patching ${target} did not produce \`version:${quote}${version}${quote}\`. Refusing `
        + 'to write a bundle whose version row this patch cannot describe.',
      )
    }
    writeFileSync(path, replacement)
    log(`app-version: ${previous} -> ${version} (${target})`)
    written.push(target)
  }
  return written
}
