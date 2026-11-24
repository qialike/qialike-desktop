/**
 * Making the pinned pnpm the one a child process resolves.
 *
 * WHY THIS IS NEEDED. `package.json` pins `packageManager: pnpm@11.28.5`, but that
 * pin is advisory to everything except pnpm itself: a tool that shells out to a bare
 * `pnpm` gets whatever is on `PATH`. electron-builder does exactly that when it
 * collects production dependencies, and pnpm then refuses —
 *
 *     ERR_PNPM_BAD_PM_VERSION: This project is configured to use 11.28.5 of pnpm.
 *     Your current pnpm is v12.2.0
 *
 * — because a pnpm whose version disagrees with the pin declines to act, which is the
 * right behaviour and the reason this cannot simply be ignored. Observed while
 * packaging on Windows, whose global pnpm was 12.2.0.
 *
 * A pin that only the outermost command honours is not a pin: `pnpm run build` and
 * the tools it drives would resolve dependencies with different pnpm versions, and the
 * difference does not announce itself. So the packaging step arranges for the pinned
 * version to be found first, by that name, by anything it spawns.
 *
 * THE SHIM IS A DIRECTORY ON `PATH`, NOT A COPY OF PNPM. It holds a `pnpm` script and
 * a `pnpm.cmd`, each of which execs the real pinned entry point through `node`. Both
 * spellings are written on every platform because the child may look for either and
 * writing both costs nothing.
 *
 * @module qialike-desktop/pnpm-path
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The `packageManager` field's shape, as npm defines it. */
const PACKAGE_MANAGER = /^(?<name>[^@]+)@(?<version>.+)$/u

/**
 * The pnpm version this repository pins, or undefined when it pins something else.
 *
 * @param root - the repository root, holding `package.json`.
 * @returns the pinned version, or undefined when the pin is absent or is not pnpm.
 */
export function pinnedPnpmVersion(root) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const match = PACKAGE_MANAGER.exec(typeof manifest.packageManager === 'string' ? manifest.packageManager : '')
  if (match?.groups === undefined) return undefined
  return match.groups.name === 'pnpm' ? match.groups.version : undefined
}

/**
 * The entry point of the pinned pnpm, when it can be located without downloading.
 *
 * Two sources, in order of directness:
 *
 *   1. the pnpm already running this build, when its version is the pinned one — the
 *      common case, because the build is normally started as `pnpm run …`;
 *   2. Corepack's cache, which holds `<COREPACK_HOME>/v1/pnpm/<version>/bin/pnpm.mjs`
 *      once that version has been prepared.
 *
 * Nothing is fetched. A missing entry point means the caller leaves `PATH` alone and
 * the ambient pnpm is used, which is the behaviour that already works on a machine
 * whose global pnpm matches the pin.
 *
 * @param options.root - the repository root.
 * @param options.env - the environment; injected so tests need no global state.
 * @returns the absolute path to the pinned `pnpm.mjs`, or undefined.
 */
export function pinnedPnpmEntry({ root, env = process.env }) {
  const version = pinnedPnpmVersion(root)
  if (version === undefined) return undefined

  const running = (env.npm_execpath ?? '').trim()
  const agent = env.npm_config_user_agent ?? ''
  if (running.length > 0 && agent.startsWith(`pnpm/${version} `) && existsSync(running)) return running

  const corepackHome = (env.COREPACK_HOME ?? '').trim()
  if (corepackHome.length > 0) {
    const cached = join(corepackHome, 'v1', 'pnpm', version, 'bin', 'pnpm.mjs')
    if (existsSync(cached)) return cached
  }
  return undefined
}

/**
 * Create a `PATH` entry through which the pinned pnpm answers to the name `pnpm`.
 *
 * Rebuilt from scratch on each call so a shim can never outlive the entry point it
 * points at — a stale shim is worse than none, because it would resolve `pnpm` to a
 * path that no longer exists and fail with ENOENT from inside a child process.
 *
 * @param options.dir - the directory to write the shims into.
 * @param options.entry - the pinned pnpm entry point (`pnpm.mjs`).
 * @returns the directory to prepend to `PATH`.
 */
export function writePnpmShim({ dir, entry }) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const node = process.execPath

  // POSIX: an executable script. `exec` so no extra shell lingers as the parent of
  // the child the caller then watches.
  const posix = join(dir, 'pnpm')
  writeFileSync(posix, `#!/bin/sh\nexec "${node}" "${entry}" "$@"\n`)
  chmodSync(posix, 0o755)

  // Windows: `pnpm.cmd`, the spelling a `.cmd`-aware caller looks for. `%*` forwards
  // the arguments verbatim; quoting both paths keeps a directory with a space working.
  writeFileSync(join(dir, 'pnpm.cmd'), `@ECHO off\r\n"${node}" "${entry}" %*\r\n`)

  return dir
}

/**
 * Whether a directory can be prepended to `PATH` for a child process.
 *
 * Exported so a caller can report what it did rather than silently changing the
 * environment a packaging run inherits.
 *
 * @param entry - the pinned pnpm entry point, or undefined.
 * @returns whether a shim is worth writing.
 */
export function shouldShimPnpm(entry) {
  return typeof entry === 'string' && entry.length > 0
}
