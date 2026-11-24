/**
 * Where the application keeps its state, and which state it owns.
 *
 * The application shares `$DSH_HOME` with the qialike CLI and with upstream's
 * Electron shell — that sharing is the point, since sessions, settings and
 * provider credentials are meant to be visible from all three. What it must not
 * share is *executable* state: a profile directory is a package set plus a
 * lockfile, and two applications writing one would race. So this application
 * owns exactly one profile name, distinct from `desktop` (upstream) and `tui`
 * (the CLI).
 *
 * This module deliberately does **not** import `electron`. Electron's paths are
 * passed in by the caller that has them, which keeps the resolution rules
 * testable under plain Node and makes the electron-owned inputs visible at the
 * one call site instead of hidden behind a global.
 *
 * @module @qialike/desktop/paths
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The profile this application owns; never `desktop` (upstream) or `tui` (the CLI). */
export const PROFILE_NAME = 'qialike-desktop'

/** The bundle layers the profile composes, in application order. */
export const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qialike/qialike-desktop-app',
]

/** The product name used in window titles, the About panel and the tray. */
export const PRODUCT_NAME = 'Qialike'

/**
 * What this application is, in one line — the About panel's description line.
 *
 * It names qialike first and the harness second, which is the order the README opens with and the order
 * the relationship actually has: this is qialike's desktop application, which is *built on* the harness
 * rather than being a surface of it. The About panel previously read "Desktop surface for
 * deepseek-harness", introducing the product as someone else's — the same framing the startup card was
 * changed to stop using.
 *
 * IT WAS FOLLOWED BY `Profile: qialike-desktop`, WHICH WAS REMOVED RATHER THAN SHORTENED. That value
 * comes from `PROFILE_NAME` above: this application owns exactly one profile and never varies it, so the
 * line printed the same string to every user on every run. A dialog may state a fact; it should not
 * recite a constant.
 */
export const PRODUCT_DESCRIPTION = 'A desktop application for qialike, built on deepseek-harness.'

/**
 * The copyright and licence line: shown in the About panel, and written into the package metadata.
 *
 * ONE HOME, TWO READERS. This is used by the About panel in `main.ts` and by
 * `apps/desktop/electron-builder.config.mjs` for the `copyright` field electron-builder writes into the
 * artifacts it builds. It was a literal in the config before, and the About panel needs the same string,
 * which would have made two homes for a line that is partly legal — the kind of drift this project has
 * spent several commits removing.
 */
export const COPYRIGHT = 'Copyright © qialike contributors. MIT licensed.'

/** The port the Host binds unless told otherwise. */
export const DEFAULT_HOST_PORT = 19388

/**
 * The harness home, matching `@deepseek-ai/dsh-home-paths`' own resolution.
 *
 * Read from the environment rather than imported: the shell resolves this before
 * the runtime tree is loaded, and the value is needed to *find* that tree.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.DSH_HOME ?? '').trim()
  return override.length > 0 ? resolve(override) : join(homedir(), '.dsh')
}

/**
 * The runtime tree this build ships: `resources/dsh` when packaged, the build
 * output when running from a checkout.
 *
 * WHY `resources/` RATHER THAN INSIDE `app.asar`. The obvious home is
 * `app.asar/dsh`, beside the shell's own code, and it does not work. Electron's
 * asar support covers `fs` reads, not everything the tree needs:
 *
 *   · **It holds symlinks.** The tree is a pnpm workspace, so `node_modules`
 *     entries are links into `packages/`. asar has no representation for a
 *     symlink, and the packer resolves them at build time — silently producing a
 *     tree whose layout differs from the one every test in this repository
 *     exercises.
 *   · **It is a child process's module root.** The Host is spawned as a separate
 *     Node-mode process and resolves every `@deepseek-ai/*` package through that
 *     `node_modules`.
 *   · **It holds native binaries** (`system.node`). Those must be real files on
 *     disk; `asarUnpack` would handle them, but only by splitting the tree across
 *     two locations that must agree.
 *
 * A plain directory under `resources/` sidesteps all three: what the Host sees is
 * what the build assembled.
 *
 * @param options.packaged - `app.isPackaged`.
 * @param options.resourcesPath - `process.resourcesPath`, i.e. the packaged app's
 *   resource directory. Read by the caller rather than here, for the reason this
 *   module gives at the top: it stays Electron-free so it can be tested.
 * @param options.cwd - the process working directory, used when unpackaged.
 * @param options.env - environment, for the development override.
 */
export function runtimeDir(options: {
  packaged: boolean
  resourcesPath: string
  cwd: string
  env?: NodeJS.ProcessEnv
}): string {
  const override = ((options.env ?? process.env).QIALIKE_DESKTOP_DSH_DIR ?? '').trim()
  if (override.length > 0) return resolve(override)
  return options.packaged
    ? join(options.resourcesPath, 'dsh')
    : resolve(options.cwd, 'dist', 'runtime', 'dsh')
}

/** The profile directory: `$DSH_HOME/profiles/qialike-desktop`. */
export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'profiles', PROFILE_NAME)
}

/**
 * Browser data and shell preferences.
 *
 * Kept inside Electron's own `userData`, separate from `$DSH_HOME`: keybindings
 * and window state belong to the shell, not the agent, and removing the
 * application's data should not disturb a user's sessions.
 *
 * `QIALIKE_DESKTOP_USER_DATA_DIR` isolates it for development, so a test launch
 * cannot overwrite the preferences of the instance the user actually runs.
 */
export function userDataDir(options: { userDataPath: string; env?: NodeJS.ProcessEnv }): string {
  const override = ((options.env ?? process.env).QIALIKE_DESKTOP_USER_DATA_DIR ?? '').trim()
  return override.length > 0 ? resolve(override) : options.userDataPath
}

/** Every path this application reads or writes, resolved once at startup. */
export interface DesktopPaths {
  readonly home: string
  readonly profile: string
  readonly runtime: string
  readonly userData: string
}

/** The Electron-owned inputs {@link resolvePaths} needs. */
export interface ElectronPaths {
  readonly packaged: boolean
  /** `process.resourcesPath`; where the shipped runtime tree lives when packaged. */
  readonly resourcesPath: string
  readonly userDataPath: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Resolve every path, and create the two directories that must exist.
 *
 * The profile must exist before the Host starts — the Host reads its manifest
 * during boot and does not create it — and the user-data directory holds the
 * window state written on first quit.
 */
export function resolvePaths(electron: ElectronPaths): DesktopPaths {
  const env = electron.env ?? process.env
  const paths: DesktopPaths = {
    home: dshHome(env),
    profile: profileDir(env),
    runtime: runtimeDir({
      packaged: electron.packaged,
      resourcesPath: electron.resourcesPath,
      cwd: electron.cwd ?? process.cwd(),
      env,
    }),
    userData: userDataDir({ userDataPath: electron.userDataPath, env }),
  }
  mkdirSync(paths.profile, { recursive: true, mode: 0o700 })
  mkdirSync(paths.userData, { recursive: true, mode: 0o700 })
  return paths
}
