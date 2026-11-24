/**
 * `@qialike/qialike-desktop-brand` — the host half of qialike's branding.
 *
 * This module has no *behaviour*, and that is deliberate rather than unfinished.
 * It still exports an `apply`, because a Cordis entry whose module has none does
 * not activate — see below.
 *
 * A client bundle reaches the browser only through a **mounted Loader row**: the
 * client-module scanner walks the host Loader's entries, reads each one's
 * package manifest, and picks up the ones declaring `dsh.client`. So the
 * branding — which is entirely a browser concern, registered into three slots —
 * still needs a host row to be discovered at all, and that row needs a module to
 * name. This is it.
 *
 * WHAT IT IS NOT. It is not a second place for brand *assets*: the favicons and
 * the manifest are files the build shadows over the Web dist
 * (`apps/desktop-bin/lib/web-shadow.mjs`), because the browser fetches them by
 * URL rather than through the plugin system. The two halves meet only in the
 * wordmark, which is inlined into the client bundle rather than fetched, so that
 * a change to `apps/desktop-web/public/brand/` is a change to one file that both
 * the build and the bundle read.
 *
 * @module @qialike/qialike-desktop-brand
 */

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-brand'

/**
 * Mount the row.
 *
 * Empty by design, and it has to be here: a Cordis entry whose module exports no
 * `apply` does not activate, and an inactive entry is one the client-module
 * scanner never sees — so the branding would be absent from the browser with the
 * only symptom being its absence. Nothing logged it as an error either; the row
 * simply had no fiber. The same shape as this repository's bundle entry point,
 * for the same reason.
 */
export function apply(): void {}
