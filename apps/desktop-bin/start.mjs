/**
 * Run the development build: `electron apps/desktop`, from a checkout.
 *
 * WHY THIS EXISTS. `pnpm run start:desktop` was `electron apps/desktop` — a bare command name that has never
 * resolved. Electron is a devDependency of the `apps/desktop` workspace package, so its shim lives in
 * `apps/desktop/node_modules/.bin/`, and pnpm does NOT hoist a workspace package's bins to the repository
 * root. `pnpm exec electron` fails with `Command "electron" not found`, and so did every run of the menu's
 * "start the application" step, from the commit that introduced it: the script has been dead since `ca2aa65`.
 *
 * Nobody noticed because nothing else runs this path. The probes and `e2e` launch an **artifact** — an
 * AppImage or an unpacked directory — by path, which works. The menu's start step is the only thing that runs
 * the checkout, and it reports the failure as `sh: 1: electron: not found`, which reads like a broken
 * environment rather than a broken script.
 *
 * HOW THE BINARY IS FOUND, rather than assumed. `./lib/electron-binary.mjs` resolves it — see that module for
 * the order it tries and why. It is separate so that a test can hold the resolution: this launcher spawns
 * Electron and stays in the foreground, which makes it awkward to assert on directly, and the resolution is
 * the part that was broken.
 *
 * IT STAYS IN THE FOREGROUND, deliberately: this step exists so a person can look at the application, and it
 * returns when they close the window. Signals are forwarded so Ctrl-C reaches Electron rather than orphaning
 * it.
 *
 * Usage: `node apps/desktop-bin/start.mjs` (or `pnpm run start:desktop`).
 *
 * @module qialike-desktop/start
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { electronBinary } from './lib/electron-binary.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '')

let binary
try {
  binary = electronBinary(ROOT)
} catch (error) {
  process.stderr.write(`qialike desktop: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const child = spawn(binary, ['apps/desktop', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
})

// Forwarded so Ctrl-C closes the application instead of leaving an Electron process behind while this script
// exits — the failure mode that makes someone reach for `pkill`.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { child.kill(signal) } catch { /* already gone */ } })
}

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1)
})
