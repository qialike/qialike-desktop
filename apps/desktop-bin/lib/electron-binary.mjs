/**
 * Find the Electron executable, without relying on `PATH` or on a generated shim.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE LAUNCHER. `pnpm run start:desktop` used to be
 * `electron apps/desktop` — a bare command name — and it NEVER resolved. Electron is a devDependency of the
 * `apps/desktop` workspace package, so its shim lands in `apps/desktop/node_modules/.bin/`, and pnpm does not
 * hoist a workspace package's bins to the repository root: `pnpm exec electron` answers
 * `Command "electron" not found`. The menu's "start the application" step therefore failed with
 * `sh: 1: electron: not found` from the commit that introduced it (`ca2aa65`) until it was noticed.
 *
 * Nothing caught it because nothing else runs this path, and because the failure reads like a broken
 * environment rather than a broken script. So the resolution is separated here where a test can hold it.
 *
 * THE ORDER MATTERS. The package's own `bin` declaration is asked first, because that is the supported way to
 * locate the real executable — it resolves through the dependency edge that the application itself uses, and
 * it does not depend on a shim having been generated or on pnpm's linking layout. The shim is the fallback.
 *
 * @module qialike-desktop/electron-binary
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * The Electron executable for a checkout.
 *
 * @param root - the repository root.
 * @returns the absolute path to an existing executable.
 * @throws Error naming every location tried, so the message says what is missing and what to run.
 */
export function electronBinary(root) {
  const appDir = join(root, 'apps', 'desktop')
  const tried = []

  try {
    // Resolved from the package that depends on Electron, so this walks the same edge the application's own
    // `require('electron')` would. `require('electron')` from Node returns the path to the executable; the
    // manifest lookup is there for the case where that ever stops being true.
    const require = createRequire(join(appDir, 'package.json'))
    const declared = require('electron')
    const manifest = join(require.resolve('electron/package.json'), '..', 'index.js')
    const entry = typeof declared === 'string' ? declared : manifest
    tried.push(entry)
    if (existsSync(entry)) return entry
  } catch (error) {
    tried.push(`(electron is not resolvable from apps/desktop: ${error instanceof Error ? error.message : String(error)})`)
  }

  const shim = join(appDir, 'node_modules', '.bin', 'electron')
  tried.push(shim)
  if (existsSync(shim)) return shim

  throw new Error(
    'could not find the electron executable. Looked for:\n'
    + tried.map((candidate) => `  ${candidate}`).join('\n')
    + '\nElectron is a devDependency of apps/desktop, so run `pnpm install` first.',
  )
}
