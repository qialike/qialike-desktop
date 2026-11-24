/**
 * The profile this application owns, and its recovery path.
 *
 * A profile is a manifest naming bundle layers, a user patch layer, and a
 * package manager's settings. The profile holds only *external* plugins:
 * everything this application ships — the harness core, the browser surface, our
 * own bundle — lives in the runtime tree and resolves from there, so an installed
 * profile stays small and the application starts with no package manager run.
 *
 * WHO WRITES IT, AND WHY IT IS NOT THE SHELL. The Host creates the profile as its
 * first action (`ensureProfile` in `apps/desktop-host`), before any plugin mounts,
 * and reports a `fatal` over IPC if it cannot. The shell used to do it too, by
 * importing `initProfile` from `@deepseek-ai/dsh-app-boot` — and that import could
 * never resolve. The harness is not a dependency of this workspace (it lives in a
 * read-only checkout and is composed into the runtime tree at build time), so a
 * bare `@deepseek-ai/*` specifier in the shell's own code has no `node_modules` to
 * resolve against, in development or in a package. The application died on its
 * first import, before Electron painted anything.
 *
 * The shell keeps the two things it can do without harness code: read the
 * profile's manifest as JSON, and compare it with what this build composes.
 * Anything that needs the harness's own profile API is imported from the runtime
 * tree by absolute path, where exactly one copy of that API exists.
 *
 * @module @qialike/desktop/project-manager
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROFILE_BUNDLES } from './paths.ts'

/** The name the harness uses for this installation in its diagnostics. */
const BIN_NAME = 'qialike-desktop'

/**
 * The harness profile API, as `@deepseek-ai/dsh-app-boot` exports it.
 *
 * Declared locally rather than imported: the package is only resolvable from the
 * runtime tree at runtime, so a `import type` would drag a module this file may
 * not reference statically into its own resolution.
 */
interface ProfileApi {
  /** Bring a profile back to `bundles`, moving the user's patch layer aside. */
  sanitizeProfile(binName: string, profileDir: string, bundles: readonly string[]): string | undefined
}

/**
 * Load the harness profile API out of the runtime tree.
 *
 * By absolute path, and dynamically, because that is the only form that can work:
 * the specifier `@deepseek-ai/dsh-app-boot` resolves for nothing in this
 * workspace, while the same package resolves for everything inside the tree.
 * Importing it this way also means the shell and the Host share one copy of the
 * profile format instead of the shell carrying a second one.
 *
 * @param runtimeDir - the assembled runtime tree.
 * @returns the profile API.
 * @throws Error when the tree does not carry it.
 */
async function loadProfileApi(runtimeDir: string): Promise<ProfileApi> {
  const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(
      `qialike-desktop: the runtime tree at ${runtimeDir} does not carry @deepseek-ai/dsh-app-boot. `
      + 'The tree is incomplete; reassemble it with `pnpm run build`.',
    )
  }
  return await import(pathToFileURL(entry).href) as ProfileApi
}

/**
 * What a profile's manifest currently declares, for the startup check.
 *
 * @returns the bundle layer names, or undefined when the manifest is unreadable.
 */
export function readProfileBundles(profileDir: string): string[] | undefined {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return undefined
  }
}

/**
 * Compare the profile's declared layers with the ones this build composes.
 *
 * A profile prepared by an older build keeps its old bundle list, because
 * `initProfile` never overwrites. That is the right default — a user may have
 * edited it deliberately — but it means an upgrade can leave the application
 * composing a layer set it was not tested with, so a MISSING layer is reported
 * rather than silently applied or silently ignored.
 *
 * AN EXTRA LAYER IS NOT DRIFT, and calling it that was wrong. The plugin manager exists so a
 * user can switch on one of the bundles the harness ships switched off — voice input, session
 * search, the terminal, the plugin market. Enabling one appends it to this same list by
 * design, and the manager has already checked that the bundle loads and is version
 * compatible with the running runtime. Reporting it as "layers this build does not compose"
 * would put a misleading warning on every launch, for a configuration the product offers.
 *
 * A bundle that cannot load is still reported — by the Host, as a skipped bundle, which is
 * where the fact belongs because only the Host resolves them.
 *
 * @returns a description of the missing layers, or undefined when they are all present.
 */
export function profileBundleDrift(profileDir: string): string | undefined {
  const declared = readProfileBundles(profileDir)
  if (declared === undefined) return undefined
  const missing = PROFILE_BUNDLES.filter((name) => !declared.includes(name))
  if (missing.length === 0) return undefined
  return `the profile at ${profileDir} is missing layers this build composes (${missing.join(', ')})`
}

/**
 * Recover from a profile whose third-party plugins prevent the Host starting.
 *
 * Disables third-party bundles and moves the user's patch layer aside, keeping
 * it. Installed packages are left in place: the failure is nearly always a plugin
 * that no longer loads, and reinstalling everything to recover from one is a much
 * larger action than the problem calls for.
 *
 * Delegated rather than reimplemented — this is the harness's own recovery path
 * and it already renames the patch layer, rewrites the bundle list and returns
 * the backup path — but delegated *into the runtime tree*, because that is where
 * the harness exists at this point in the application's life.
 *
 * @param profileDir - the profile directory.
 * @param runtimeDir - the assembled runtime tree to load the profile API from.
 * @returns the backup path, or undefined when there was no patch layer to move.
 */
export async function disableThirdPartyPlugins(profileDir: string, runtimeDir: string): Promise<string | undefined> {
  const { sanitizeProfile } = await loadProfileApi(runtimeDir)
  return sanitizeProfile(BIN_NAME, profileDir, [...PROFILE_BUNDLES])
}
