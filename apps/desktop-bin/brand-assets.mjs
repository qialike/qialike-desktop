#!/usr/bin/env node
/**
 * Keep the mark's derived assets in step with the artwork they come from.
 *
 * THE SOURCE OF TRUTH IS AN SVG, the way the wordmark's is: `apps/desktop-web/public/brand/qialike-bee.svg`.
 * It is vendored — drawn elsewhere, committed here — and the three files below are derived from it.
 *
 * That is a change from what this script used to do, and the reason is worth recording rather than
 * discovering. The mark used to be a 12x12 grid of axis-aligned cells in a module called `lib/brand-mark.mjs`
 * (since deleted, its two brand colours moved to `lib/brand-colours.mjs`), which this
 * repository could rasterise itself: a hand-written PNG writer, no image dependency. The artwork that
 * replaced it is drawn with ellipses, quadratic curves, rotations and strokes, which that writer cannot
 * express. So the two halves are now reproducible to different degrees, and each says which it is:
 *
 *   · **The two favicons need no rasteriser at all.** They *are* SVG, so they are the source with a
 *     provenance comment. `--check` compares them byte for byte.
 *   · **`icon.png` is a rasterisation**, so it does need one. `--check` verifies its *form* — a 512x512
 *     8-bit RGBA PNG — rather than its bytes, because a rasteriser's output is not byte-stable across
 *     versions and failing for that reason would say nothing about the artwork. The command that
 *     regenerates it is printed at the end of every run, so it is one copy away rather than folklore.
 *
 * Usage:
 *   node apps/desktop-bin/brand-assets.mjs            # write the two favicons
 *   node apps/desktop-bin/brand-assets.mjs --check    # write nothing; exit 1 if anything is out of step
 *
 * @module qialike-desktop/brand-assets
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// `fileURLToPath` keeps the trailing slash this URL resolves with, so the root is normalised here
// and paths are shown with `relative` rather than by slicing a prefix off — slicing it once cut a
// character too many and printed `pps/desktop-web/...`.
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '')
const WEB_PUBLIC = join(ROOT, 'apps', 'desktop-web', 'public')
const BUILD_RESOURCES = join(ROOT, 'apps', 'desktop', 'build')

/** The vendored artwork every derived asset comes from. */
const SOURCE = join(WEB_PUBLIC, 'brand', 'qialike-bee.svg')

/** The mark's size in `icon.png`. 512 is what electron-builder documents for Linux and Windows. */
const ICON_SIZE = 512

/** Where `icon.png` is expected, and the size and form it is expected to have. */
const ICON = join(BUILD_RESOURCES, 'icon.png')

/**
 * The source SVG with a provenance comment spliced into it.
 *
 * SPLICED RATHER THAN WRITTEN OUT, because the artwork is the one thing here that is not ours to
 * paraphrase: a copy that restated the geometry would be a second source, and the point of vendoring the
 * file is that there is one. The comment goes immediately after the opening tag, which is where a reader
 * of the file meets it before any drawing.
 *
 * @param explanation - the comment body, already indented and wrapped by the caller.
 * @returns the SVG document text.
 */
function derivedDocument(explanation) {
  const source = readFileSync(SOURCE, 'utf8')
  const opening = /^<svg[^>]*>/u.exec(source)
  if (opening === null) {
    throw new Error(`${relative(ROOT, SOURCE)} does not begin with an <svg> tag, so the derived favicons cannot be built from it`)
  }
  return `${source.slice(0, opening[0].length)}
  <!--
${explanation}
  -->${source.slice(opening[0].length)}`
}

/**
 * The `IHDR` fields of a PNG, or `undefined` when the buffer is not one.
 *
 * READ BY HAND rather than with a library, for the same reason the PNG writer used to be written by hand:
 * this repository has no image dependency, and four fields out of a documented header do not justify one.
 * Only the fields this script asserts on are returned.
 */
function pngForm(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(signature)) return undefined
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
  }
}

const EXPLANATION = `    The qialike mark — a bee — as vendored artwork, not as geometry this repository draws.

    Derived by \`apps/desktop-bin/brand-assets.mjs\` from
    \`apps/desktop-web/public/brand/qialike-bee.svg\`, which is the single source: this file is that
    document with this comment added and nothing else changed, so \`--check\` can compare the two byte
    for byte. Do not hand-edit it — edit the artwork, or nothing, because
    \`tests/brand-assets.test.mjs\` asserts the two agree.

    WHAT IT DRAWS: a golden bee — gradient body and head, two dark stripes, eyes, a smile, antennae
    tipped with gold balls, translucent blue wings — on a dark blue rounded plate with faint grid lines,
    a glow and a fur texture. The gradients and those filters are why this repository cannot rasterise
    it: it has no image library, and the PNG writer it used to have emitted axis-aligned rectangles.

    BOTH FAVICONS ARE THE SAME DOCUMENT, and that is the artwork's doing rather than a shortcut. The two
    names exist because a favicon drawn in near-black is invisible on dark browser chrome and one drawn
    in near-white is invisible on light, and the served document still chooses between them with
    \`prefers-color-scheme\`. This artwork carries its own plate, so it is legible on either and the
    choice no longer changes what is drawn.`

const FILES = [
  { path: join(WEB_PUBLIC, 'favicon.svg'), contents: derivedDocument(EXPLANATION) },
  { path: join(WEB_PUBLIC, 'favicon-dark.svg'), contents: derivedDocument(EXPLANATION) },
]

const check = process.argv.includes('--check')
let differing = 0

for (const file of FILES) {
  const wanted = Buffer.from(file.contents, 'utf8')
  let current
  try {
    current = readFileSync(file.path)
  } catch {
    current = undefined
  }
  const same = current !== undefined && current.equals(wanted)
  const shown = relative(ROOT, file.path)
  if (same) {
    process.stdout.write(`  [ok]      ${shown}\n`)
    continue
  }
  differing += 1
  if (check) {
    process.stdout.write(`  [differs] ${shown}${current === undefined ? ' (missing)' : ''}\n`)
    continue
  }
  writeFileSync(file.path, wanted)
  process.stdout.write(`  [written] ${shown}${current === undefined ? ' (was missing)' : ''}\n`)
}

// The raster, checked by form. See the module comment for why its bytes are not the assertion.
let icon
try {
  icon = readFileSync(ICON)
} catch {
  icon = undefined
}
const form = icon === undefined ? undefined : pngForm(icon)
const iconShown = relative(ROOT, ICON)
const iconOk = form !== undefined && form.width === ICON_SIZE && form.height === ICON_SIZE
  && form.bitDepth === 8 && form.colourType === 6
if (iconOk) {
  process.stdout.write(`  [ok]      ${iconShown} (${String(ICON_SIZE)}x${String(ICON_SIZE)} RGBA)\n`)
} else {
  differing += 1
  const detail = icon === undefined
    ? 'missing'
    : form === undefined
      ? 'not a PNG'
      : `${String(form.width)}x${String(form.height)}, bit depth ${String(form.bitDepth)}, colour type ${String(form.colourType)}`
  process.stdout.write(`  [${check ? 'differs' : 'stale'}] ${iconShown} (${detail}; expected ${String(ICON_SIZE)}x${String(ICON_SIZE)} 8-bit RGBA)\n`)
}

process.stdout.write(`
icon.png is a rasterisation of the artwork and is regenerated by a rasteriser, not by this script:

  inkscape --export-type=png --export-filename=${relative(ROOT, ICON)} \\
    --export-width=${String(ICON_SIZE)} ${relative(ROOT, SOURCE)}
`)

if (check && differing > 0) {
  process.stdout.write(`${String(differing)} file(s) do not match the artwork. Run without --check to rewrite the favicons.\n`)
  process.exit(1)
}
process.stdout.write(check ? 'all three match the artwork\n' : `${String(FILES.length)} file(s) written\n`)
