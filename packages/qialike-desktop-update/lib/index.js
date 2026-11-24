/**
 * The manual-update row — the Host half of `@qialike/qialike-desktop-update`.
 *
 * WHY THERE IS NOTHING TO DO HERE, AND WHY THAT IS NOT AN OMISSION. Everything this row does happens in the
 * renderer: it reads the update carrier the preload installs at `globalThis.dshDesktop.updates` and renders
 * its states from it. The update itself is the shell's — `electron-updater` behind that carrier — so there is
 * no route to serve, no file to read, and no state for the Host to own. The browser half in `lib/client.js`
 * is the substance.
 *
 * SO WHY A HOST MODULE AT ALL. Because the client bundle is discovered through the package's own mount: a
 * package that declares `dsh.client` but is reached by no Loader entry is discovered by nothing, its bundle is
 * never requested, and the row cannot exist however correct the bundle is. The entry in
 * `packages/qialike-desktop-app/cordis.patch.yml` names this package, so this module is what that entry
 * mounts — and a Cordis plugin must export `name` and an `apply`, or the mount fails with
 * `failed to import` and the only symptom is one line on stderr.
 *
 * That failure was OBSERVED rather than reasoned about: the first version of this file exported a marker
 * constant and nothing else. The import itself succeeded, which is what made it worth recording — a module
 * that loads is not a module the Loader accepts.
 *
 * @module @qialike/qialike-desktop-update
 */

/**
 * The name this plugin registers under, matching the `id` in `cordis.patch.yml`.
 *
 * Kept equal to the entry id deliberately: when a mount fails, the harness prints the id and the package name
 * together, and having them agree is what makes that line greppable rather than something to decode.
 */
export const name = 'qialike-update'

/**
 * Mount the row.
 *
 * Empty on purpose, and that is the honest shape rather than a stub waiting to be filled: registering anything
 * here would mean the Host owns a fact about updates, and it does not. The client half is loaded by virtue of
 * this package being mounted, which is the whole reason this function exists.
 *
 * @param _ctx - the Cordis context. Unused: see above.
 */
export function apply(_ctx) {}
