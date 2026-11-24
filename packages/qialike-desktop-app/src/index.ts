/**
 * @qialike/qialike-desktop-app — the qialike desktop bundle.
 *
 * The substance of this package is `cordis.patch.yml`, declared through the
 * `dsh.bundle.patch` manifest field the profile composer resolves. This module
 * carries no runtime API yet: it exists so the package has a resolvable entry
 * point, which is what lets the profile load the bundle at all.
 *
 * Later milestones add the host-side plugins here — the provider catalogue
 * adapter, the gateway sub-plugins, the workspace-scoped file tools, and the
 * desktop surface prompt section — each as an exported subpath the patch file
 * names. They are separate subpaths rather than one module because the CLI's
 * `llm.ts` is ~2000 lines and nothing should load a gateway catalogue it has
 * disabled in `qialike.json`.
 *
 * @module @qialike/qialike-desktop-app
 */

/** Stable Cordis plugin name. */
export const name = 'qialike-desktop-app'

/**
 * Mount the bundle's host-side glue.
 *
 * Empty by design at this stage. The bundle's rows are configuration, applied by
 * the composer before this function runs; a bundle that contributes no service
 * of its own needs no body, and an empty one keeps the profile loadable while
 * the client plugins are still being built.
 */
export function apply(): void {}
