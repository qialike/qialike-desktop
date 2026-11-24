/**
 * The two brand blues, and why they are literals rather than theme tokens.
 *
 * WHAT IS LEFT HERE, AND WHY THE FILE IS MOSTLY GONE. This module used to own the mark's geometry as well:
 * a 12x12 cell grid, from which the sidebar mark, the hero mark, both favicons and the launcher icon were
 * all derived. The mark is now **vendored artwork** — `apps/desktop-web/public/brand/qialike-bee.svg` —
 * and every one of those four renderings comes from it, so the grid, its raster writer and the accent that
 * went with them were deleted rather than left as a source nothing reads.
 *
 * The two colours below stay because the **wordmark** still uses them, and because the wordmark's copy in
 * `packages/qialike-desktop-brand/lib/client.js` cannot import this file: that bundle is hand-written and
 * inlined into the served document. `tests/brand-assets.test.mjs` compares the two, so the copy cannot
 * drift.
 *
 * The mark's own colours are no longer here at all. They belong to the artwork, which carries them in
 * itself — including a dark plate that makes it legible on a light scheme and a dark one alike, which is
 * the job the removed `ABDOMEN_YELLOW` note used to describe the difficulty of.
 *
 * @module qialike-desktop/brand-colours
 */

/**
 * The brand blue: DeepSeek's own, `#4D6BFE`.
 *
 * WHERE THIS VALUE COMES FROM, because picking a blue by eye would have been easy and wrong. It is the
 * fill of DeepSeek's own mark — `deepseek-harness/website/public/favicon.svg` paints the whale with
 * exactly this value — and it is also the fallback `--dsw-alias-brand-primary` declares for itself
 * (`var(--dsw-alias-brand-primary, #4d6bfe)`). The palette beside it (`--dsw-static-deepseek-400`
 * through `900`) is the ramp that colour belongs to, not the brand colour itself.
 *
 * WHY A LITERAL, WHERE EVERYTHING ELSE IN THIS PRODUCT BINDS TO A THEME TOKEN. That was a deliberate
 * reversal, so it is written down rather than left as an inconsistency. The wordmark and the mark used to be drawn in
 * `--dsw-alias-label-primary`, which made it follow the text colour and therefore all sixteen schemes
 * and any theme a user installs — a real property, and the reason the wordmark is still token-driven.
 * A brand colour is the opposite kind of thing: it should be the same blue on a light scheme, a dark
 * scheme and a user's own theme, or it is not a brand colour. So the wordmark's brand half is fixed, and the wordmark's other half is a fixed lighter step of the same ramp.
 *
 * THE CONTRAST WAS MEASURED ON BOTH SIDES BEFORE CHOOSING, since one literal has to work everywhere:
 * 4.33:1 on white and 4.49:1 on this application's own dark background (`#0d0d0e`, sampled from a
 * screenshot rather than assumed). WCAG exempts logotypes from the text-contrast floor, and the wordmark is
 * a logotype, but it is still worth knowing the number is the same order on either side instead of
 * relying on that exemption.
 */
export const BRAND_BLUE = '#4d6bfe'

/**
 * The wordmark's second blue: `--dsw-static-deepseek-400`.
 *
 * A step of DeepSeek's own ramp rather than an invented tint, so the two-tone wordmark stays inside the
 * brand's palette. See the client bundle's comment for which half takes which and what that does to
 * their relative prominence on a dark background.
 */
export const BRAND_BLUE_TONE = '#7aaaff'

