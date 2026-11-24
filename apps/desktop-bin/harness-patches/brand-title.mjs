/**
 * Build-time patch: name this build in the browser surface's own title.
 *
 * WHY THE DOCUMENT TITLE IS NOT ENOUGH. The shell serves a shadowed `index.html`
 * whose `<title>` says Qialike, and the client overwrites it the moment it mounts:
 * `AppFrame` computes
 *
 *     const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
 *
 * and `DocumentTitle` assigns `document.title` from it on every session change.
 * `process.env` in a browser bundle is a *build-time* substitution, so
 * `DSH_CLIENT_TITLE` was baked in when the harness built its own frontend — and
 * we cannot rebuild that bundle (see `web-shadow.mjs` for why). The fallback is
 * therefore what always wins, and it localizes to "DSH Local Build".
 *
 * This matters more than a stray string usually would, because **Electron follows
 * the document title**: the window's title bar, the task switcher and the window
 * list all show it. A user's window would be labelled with the harness's build
 * name while the application is qialike.
 *
 * WHY THE LOCALE DICTIONARY AND NOT THE EXPRESSION. The alternative is to rewrite
 * `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')` in `ui-layout`'s bundle,
 * which is minified and whose shape changes with every upstream release. The
 * string lives in exactly one place that does not: a dictionary entry in
 * `dsh-client-locale`, whose *key* is stable.
 *
 * The anchor is therefore the key, and the value is replaced whatever it says.
 * That is deliberate — anchoring on the current copy would make this patch fail
 * the build every time upstream rewords a translation, which is a maintenance
 * cost for no safety. A missing *key* is the thing worth failing on.
 *
 * The brand name is not translated, so both locales get the same string. That is
 * the exception rather than the rule for this repository: every other
 * product-visible string is localized.
 *
 * @module qialike-desktop/harness-patches/brand-title
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Idempotency marker, and the shape a patched entry has. */
export const BRAND_TITLE_MARKER = 'qialike:product-title'

/**
 * The one farm file carrying the title.
 *
 * `dsh-client-locale` ships the `brand` namespace, so it is where the fallback
 * lives; the browser surface's own bundle carries no second copy (verified by
 * searching the built dist for the string — see the test).
 */
const TARGET = '-deepseek-ai-dsh-client-locale/lib/client.js'

/** The dictionary key whose value becomes the product name. */
const KEY = 'brand.localBuild'

/**
 * Apply the patch to a farm.
 *
 * @param options.root - the farm root (never the harness checkout).
 * @param options.productName - the name to write, read from the shell's `paths.ts`
 *   so the window title and the document title cannot disagree.
 * @param options.log - progress sink.
 * @returns the files written.
 * @throws Error when the file or the key is absent.
 */
export function patchBrandTitle({ root, productName, log = () => {} }) {
  const path = join(root, TARGET)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: the brand-title target ${TARGET} is missing from the farm at ${root}. `
      + 'Either the harness renamed @deepseek-ai/dsh-client-locale, or the farm is incomplete. '
      + 'Update TARGET in apps/desktop-bin/harness-patches/brand-title.mjs.',
    )
  }
  const text = readFileSync(path, 'utf8')
  if (text.includes(BRAND_TITLE_MARKER)) {
    log(`brand-title: already applied (${TARGET})`)
    return [TARGET]
  }
  // Key-anchored, value-agnostic, and global: the `en` and `zh` entries both carry
  // the key, and the brand name is the same in both.
  //
  // THE VALUE MAY BE DOUBLE-QUOTED OR BACKTICKED, AND THAT IS NOT COSMETIC. Harness 0.2.2-rc.3 ships
  // its client bundles MINIFIED, and the minifier emits string literals with backticks
  // (`"brand.localBuild":`DSH Local Build``). A pattern expecting only `"…"` therefore reports "no
  // such key" against a dictionary that still has it — a failure that reads like an upstream rename
  // but is a quoting difference. Accepting both is what keeps this patch about the key rather than
  // about how the bundler felt that day.
  const pattern = new RegExp(`("${KEY.replace('.', '\\.')}"\\s*:\\s*)(?:"[^"]*"|\\x60[^\\x60]*\\x60)`, 'gu')
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) {
    throw new Error(
      `qialike-desktop: ${TARGET} declares no ${JSON.stringify(KEY)} entry, so the browser surface's `
      + 'product title cannot be set. The harness moved or renamed the key; update KEY in '
      + 'apps/desktop-bin/harness-patches/brand-title.mjs.\n'
      + '  · Do not delete this patch: without it the client overwrites the document title that '
      + 'web-shadow.mjs sets, and Electron labels the window with the harness build name.',
    )
  }
  const patched = text.replace(pattern, `$1"${productName}" /* ${BRAND_TITLE_MARKER} */`)
  writeFileSync(path, patched)
  log(`brand-title: titled ${String(matches.length)} locale(s) "${productName}" (${TARGET})`)
  return [TARGET]
}
