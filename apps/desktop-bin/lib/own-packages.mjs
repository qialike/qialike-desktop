/**
 * This repository's own packages, as the runtime tree needs them.
 *
 * Kept apart from `paths.mjs` because the list changes as milestones land: M1
 * adds the Host, M2 the built Web frontend. A single place to read the current
 * set keeps the build, the gates, and the tests agreeing about what this
 * application contributes.
 *
 * @module qialike-desktop/own-packages
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripSourceExports } from './harness-farm.mjs'
import { ROOT } from './paths.mjs'

/** The bundle layered over `dsh-base` + `dsh-web-app`. */
export const OUR_BUNDLE = '@qialike/qialike-desktop-app'

/**
 * The package the profile's provider rows name.
 *
 * Separate from the bundle because the resolver removes bundle packages from its
 * table, so a row may not name a subpath of the bundle that inserted it. See the
 * package's entry point.
 */
export const PROVIDERS_PACKAGE = '@qialike/qialike-desktop-providers'

/**
 * The CLI's app package, re-hosted as a runtime-tree member.
 *
 * The `qialike-llm` row in our bundle resolves `@qialike/qialike-app/llm` — the
 * CLI's *built* provider catalogue (DESIGN §5.1: the CLI is consumed as a built
 * artifact, not recompiled here). That package therefore has to be a member of
 * the runtime workspace, alongside the harness farm and our own packages.
 *
 * NO DEPENDENCY EDGE DECLARES THIS, deliberately. The spec cannot be expressed
 * statically — the checkout is located at build time through `DSH_QIALIKE`, a
 * sibling directory, or `~/deepseek/*` — and a `workspace:*` spec in our own
 * manifest would make this repository's root `pnpm install` demand a member its
 * workspace does not have. The runtime tree is a *separate* pnpm workspace that
 * declares every member as a root dependency itself, and it installs with
 * `nodeLinker: hoisted`, so the member is resolvable from our package without an
 * edge. The same shape as `ROWLLESS_PACKAGES`: installed, reachable by name,
 * depended on by nothing. `tests/qialike-app-package.test.mjs` asserts the two
 * halves still agree.
 *
 * WHY IT IS STAGED RATHER THAN COPIED WHOLE. The checkout's package directory
 * carries 40 MB of TypeScript sources the runtime never loads, plus a
 * `node_modules` and a set of headless render scripts. `lib/` is 1.7 MB and is
 * the only directory any runtime import reaches.
 *
 * THE VERSION THAT GETS STAGED IS A CONTRACT. Whatever `packages/qialike-app`
 * declares here is what the installer ships, so the checkout must be the release
 * this build was validated against — `CLI_VERSION` in `harness-version.mjs`, checked
 * by `assertCliCompatible` before this runs. Nothing in the artifact reveals a
 * stale copy: its version string is this application's, not the provider layer's.
 */
export const QIALIKE_APP_PACKAGE = '@qialike/qialike-app'

/**
 * Stage the CLI's built app package for the runtime tree.
 *
 * Copies the manifest and `lib/`, then strips the `/src` export subpaths the
 * farm's own copies also strip: they point at sources this tree does not carry,
 * and deleting them turns a latent runtime failure into an absent subpath. The
 * result is returned in `{ name, dir }` form so the build can pass it as an
 * ordinary `own` entry, which is what gives it the member treatment —
 * `rewriteWorkspaceSpecs` rewrites its `@deepseek-ai/*` peers and drops its
 * `devDependencies` and `scripts`.
 *
 * @param options.qialike - the resolved qialike checkout root.
 * @param options.stageDir - where to lay the staged copy out.
 * @param options.log - progress sink.
 * @returns the `{ name, dir }` entry, or undefined when the source is unbuilt.
 */
export function stageQialikeAppPackage({ qialike, stageDir, log = () => {} }) {
  const from = join(qialike, 'packages', 'qialike-app')
  if (!existsSync(join(from, 'package.json')) || !existsSync(join(from, 'lib'))) return undefined
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  cpSync(join(from, 'package.json'), join(stageDir, 'package.json'))
  cpSync(join(from, 'lib'), join(stageDir, 'lib'), { recursive: true, preserveTimestamps: true })

  const manifestPath = join(stageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const stripped = stripSourceExports(manifest)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`runtime: staged ${QIALIKE_APP_PACKAGE} (library only, ${String(stripped)} /src export subpath(s) stripped)`)
  return { name: QIALIKE_APP_PACKAGE, dir: stageDir }
}

/**
 * Workspace packages the runtime tree carries, in dependency order.
 *
 * `@qialike/qialike-desktop-host` is the Node-mode Host process the shell
 * spawns. It is a private package and is placed by path rather than installed,
 * so pnpm never needs to resolve its `workspace:*` specifiers.
 */
export const POLICY_PACKAGE = '@qialike/qialike-desktop-policy'

/** The theme row: this surface's colour schemes and the picker that chooses one. */
export const THEME_PACKAGE = '@qialike/qialike-desktop-theme'

/** The edit-follow row: point the document preview at whatever the agent is editing. */
export const EDIT_FOLLOW_PACKAGE = '@qialike/qialike-desktop-edit-follow'

/**
 * The office-engine row: report the engine's state, and install one when a build left it out.
 *
 * Both halves are hand-written and nothing generates either, so both need a `.gitignore`
 * exception — the blanket rule covers `client.js`, and the row's own `index.js` is named beside it.
 */
export const OFFICE_ENGINE_PACKAGE = '@qialike/qialike-desktop-office-engine'

/** The manual-update Settings row: a client-only package the shell's row mounts. */
export const UPDATE_PACKAGE = '@qialike/qialike-desktop-update'

/**
 * The continuous voice-input control: its own microphone, one transcription per sentence.
 *
 * Separate from the harness's voice-input bundle rather than replacing it, because that
 * plugin occupies a `single` slot and keeps its stop action to itself — see the bundle's own
 * module note. This row is what puts the control in the composer.
 */
export const VOICE_PACKAGE = '@qialike/qialike-desktop-voice'

/**
 * The Session export row: JSON or Markdown, from a Session's own menu.
 *
 * Separate from the harness's `/export`, which hands back the raw `.jsonl` in a ZIP — a backup of
 * the log rather than a document. The reading is the harness's; the folding and rendering are
 * this package's, because the CLI's implementation imports Ink and cannot be loaded here.
 */
export const EXPORT_PACKAGE = '@qialike/qialike-desktop-export'

/**
 * Files a package needs beyond its `main`, checked before it is placed.
 *
 * The policy package's `lib/index.js` is hand-written, but the two modules it
 * imports are *compiled* from the CLI's sources at build time
 * (`apps/desktop-bin/lib/cli-policy.mjs`). A fresh checkout therefore has the entry
 * point and neither dependency, and the main-only check would place the package
 * happily — moving the failure from the build to the first tool call, in a process
 * whose whole job is to decide whether to allow that call. Declaring them here is
 * what keeps "don't place a half-built package" true for it.
 */
export const OWN_PACKAGES = [
  { name: '@qialike/qialike-desktop-app', dir: 'packages/qialike-desktop-app' },
  { name: PROVIDERS_PACKAGE, dir: 'packages/qialike-desktop-providers' },
  { name: '@qialike/qialike-desktop-brand', dir: 'packages/qialike-desktop-brand' },
  {
    name: POLICY_PACKAGE,
    dir: 'packages/qialike-desktop-policy',
    requires: ['lib/read-policy.js', 'lib/bash-policy.js'],
  },
  {
    name: THEME_PACKAGE,
    dir: 'packages/qialike-desktop-theme',
    // Generated from the CLI's scheme sources; see `cli-themes.mjs`.
    requires: ['lib/palettes.js'],
  },
  { name: EDIT_FOLLOW_PACKAGE, dir: 'packages/qialike-desktop-edit-follow' },
  { name: OFFICE_ENGINE_PACKAGE, dir: 'packages/qialike-desktop-office-engine' },
  { name: UPDATE_PACKAGE, dir: 'packages/qialike-desktop-update' },
  { name: VOICE_PACKAGE, dir: 'packages/qialike-desktop-voice' },
  { name: EXPORT_PACKAGE, dir: 'packages/qialike-desktop-export' },
  { name: '@qialike/qialike-desktop-host', dir: 'apps/desktop-host' },
]

/**
 * The runtime-tree entries for packages that exist in this checkout.
 *
 * A package whose directory, built entry point, or a declared `requires` file is
 * absent is skipped rather than placed half-built: the Host entry must have been
 * compiled, and copying a missing `lib/` would produce a runtime tree that fails at
 * spawn with a module resolution error instead of at build time.
 *
 * @returns `{ name, dir }` entries with absolute directories.
 */
export function ownPackages() {
  const present = []
  for (const entry of OWN_PACKAGES) {
    const dir = join(ROOT, entry.dir)
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const main = manifest.main ?? 'lib/index.js'
    if (!existsSync(join(dir, main))) continue
    // Everything the entry point imports must be on disk too, for the reason the
    // package's own entry in `OWN_PACKAGES` records.
    if ((entry.requires ?? []).some((file) => !existsSync(join(dir, file)))) continue
    present.push({ name: manifest.name, dir })
  }
  return present
}

/** The names of {@link ownPackages}, for telling the closure what not to install. */
export function ownPackageNames() {
  return ownPackages().map((entry) => entry.name)
}
