/**
 * Apply the seven build-time patches to a farm.
 *
 * Two of them come from the qialike CLI's `harness-patches/` directory and are
 * imported by path; the other five live in this repository. All seven edit
 * **copies in the farm**, never the harness checkout (DESIGN §3 D12).
 *
 * The count here said "five" until 2026-10-12, and by then it had been wrong for
 * two patches' worth of history. It is derived from the `applied[...]`
 * assignments below rather than from memory — those are the registry, and a patch
 * that is registered but uncounted is exactly how this drifted.
 *
 * The Web dist is the one input the farm does not carry, because it is read
 * straight from the checkout's build output. Its half of the `app-scheme` patch
 * is therefore applied by {@link stageWebFrontendSchemed} at the point the
 * runtime tree is assembled, not here.
 *
 * Why the CLI's modules are imported rather than reimplemented: both are already
 * parameterized to the point of being location-independent — their entry points
 * are `patchDeleteConstraint({root, readFile, writeFile, log})` and
 * `patchPolicyAndHygiene({root, dirs, readFile, writeFile, log})`, they import
 * nothing but `node:fs`, and they resolve their target files from `root`. There
 * is no path or global that ties them to the CLI tree, so a copy here would be
 * pure duplication of two security-relevant edit sets.
 *
 * @module qialike-desktop/apply-patches
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchAppSchemeFarm } from '../harness-patches/app-scheme.mjs'
import { patchAppVersion } from '../harness-patches/app-version.mjs'
import { patchBrandTitle } from '../harness-patches/brand-title.mjs'
import { patchHeroHeadline } from '../harness-patches/hero-headline.mjs'
import { patchOfficeEngineMessage } from '../harness-patches/office-engine-message.mjs'
import {
  patchSessionListParityClient,
  patchSessionListParityHost,
} from '../harness-patches/session-list-parity.mjs'
import { readProductName } from './web-shadow.mjs'
import { patchWritableRootsWindows } from '../harness-patches/writable-roots-windows.mjs'
import { patchModelCatalogEagerLoad } from '../harness-patches/model-catalog-eager-load.mjs'
import { SHELL_PATHS_FILE, qialikeRoot } from './paths.mjs'

/** The CLI modules this build imports, with the exports each must provide. */
const CLI_PATCH_MODULES = [
  {
    id: 'delete-constraint',
    relativePath: 'apps/tui-bin/harness-patches/delete-constraint.mjs',
    requiredExports: ['patchDeleteConstraint', 'ACL_PACKAGE_DIR'],
  },
  {
    id: 'policy-and-hygiene',
    relativePath: 'apps/tui-bin/harness-patches/policy-and-hygiene.mjs',
    requiredExports: ['patchPolicyAndHygiene'],
  },
]

/**
 * Import one CLI patch module and check it still offers the interface this build calls.
 *
 * The modules are outside this workspace, so they are loaded by absolute path.
 * A missing file or a renamed export is a build failure with a message that
 * names the qialike file to look at, rather than a stack trace from deep inside
 * the farm (DESIGN §12.2 R8).
 *
 * @param qialike - the qialike checkout root.
 * @param spec - one entry of {@link CLI_PATCH_MODULES}.
 * @returns the module namespace.
 */
async function loadCliPatchModule(qialike, spec) {
  const path = join(qialike, spec.relativePath)
  if (!existsSync(path)) {
    throw new Error(
      `qialike-desktop: the shared harness patch ${spec.relativePath} is missing from the qialike `
      + `checkout at ${qialike}. Point DSH_QIALIKE at a qialike checkout that carries it.`,
    )
  }
  let module
  try {
    module = await import(pathToFileURL(path).href)
  } catch (error) {
    throw new Error(`qialike-desktop: cannot load ${path}: ${error.message}`)
  }
  const missing = spec.requiredExports.filter((name) => module[name] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `qialike-desktop: ${spec.relativePath} no longer exports ${missing.join(', ')}. `
      + 'The qialike CLI changed a patch interface this build calls; update '
      + 'apps/desktop-bin/lib/apply-patches.mjs and the call below to match it.',
    )
  }
  return module
}

/**
 * Apply every build-time patch to a farm.
 *
 * Ordering matters in one place: `delete-constraint` runs before the native ACL
 * runner is bundled in the CLI, because that bundle inlines the patched package.
 * This build does not re-bundle it, so the constraint reduces to applying the
 * edits before anything reads the farm.
 *
 * @param farmDir - the farm root, freshly copied from the checkout.
 * @param version - this product's version, for the row that shows one. Passed in rather than read here so
 *   the patch that writes it can be tested without a checkout.
 * @param log - progress sink.
 * @returns a summary naming what each patch touched.
 */
export async function applyHarnessPatches({ farmDir, version, log = () => {} }) {
  const qialike = qialikeRoot()
  const applied = {}

  const deleteConstraint = await loadCliPatchModule(qialike, CLI_PATCH_MODULES[0])
  // The ACL patch does not take the farm root: it scans a *directory* for the
  // hashed `types-<hash>.js` chunk the bundler emitted, and the package name is
  // flattened the same way this build flattens it, so the CLI's own constant
  // describes the path here too.
  applied['delete-constraint'] = deleteConstraint.patchDeleteConstraint({
    root: join(farmDir, deleteConstraint.ACL_PACKAGE_DIR),
    log,
  })

  // Ordering note: writableRoots is patched BEFORE policy-and-hygiene because
  // P1-B generates the workspace-write prompt sentence from a live call to
  // writableRoots(). Both edit source text rather than run it, so the two are
  // not actually interdependent at patch time — but keeping the enforcement half
  // first means a failure to narrow the boundary stops the build before the text
  // that describes it is written.
  applied['writable-roots-windows'] = patchWritableRootsWindows({ root: farmDir, log })

  const policyAndHygiene = await loadCliPatchModule(qialike, CLI_PATCH_MODULES[1])
  applied['policy-and-hygiene'] = policyAndHygiene.patchPolicyAndHygiene({ root: farmDir, log })

  // The scheme rewrite runs last because it has no ordering relationship with the
  // others: it edits client-bundle text, while they edit sandbox and policy text.
  // Keeping it last means a failure here leaves the security-relevant edits
  // already validated and reported.
  applied['app-scheme'] = patchAppSchemeFarm({ root: farmDir, log })

  // The product name comes from the shell's own module rather than from a literal
  // here, for the same reason web-shadow.mjs reads it: the window title, the About
  // panel and the document title are one fact.
  applied['brand-title'] = patchBrandTitle({
    root: farmDir,
    productName: readProductName(SHELL_PATHS_FILE),
    log,
  })

  // The product's own copy rather than the harness's, in the one slot a new user reads first. It has no
  // ordering relationship with the others: it edits a different package's locale dictionaries, and it
  // carries its own values rather than reading a constant out of the shell.
  applied['hero-headline'] = patchHeroHeadline({ root: farmDir, log })

  // Session-list parity: the sidebar's group for a Workspace must list what the CLI lists for the same
  // directory. It edits two packages — the grouping/visibility half in the client bundle, the `blank` half in
  // the Host — so it is one entry with two calls, the shape `app-scheme` established. Ordering: no relationship
  // with the others, and the Host half is written first so a client-only failure reports after the projection
  // the client reads has been aligned.
  applied['session-list-parity'] = [
    ...patchSessionListParityHost({ root: farmDir, log }),
    ...patchSessionListParityClient({ root: farmDir, log }),
  ]

  // The Office preview's "unavailable" sentence, redirected to Settings. It edits one
  // package's locale dictionaries, so it has no ordering relationship with the others. Last
  // only because it was added last.
  // The composer's startup cost: the catalogue is built on demand rather than at boot. It edits a
  // client bundle, so it has no ordering relationship with the security-relevant edits above; it
  // sits here for the same reason `app-scheme` does — after them, so their failures report first.
  applied['model-catalog-eager-load'] = patchModelCatalogEagerLoad({ root: farmDir, log })

  applied['office-engine-message'] = patchOfficeEngineMessage({ root: farmDir, log })

  // Settings' version row, changed from the harness's version to this product's. It edits one
  // string in one bundle, so it too has no ordering relationship with the others.
  applied['app-version'] = patchAppVersion({ root: farmDir, version, log })

  return applied
}
