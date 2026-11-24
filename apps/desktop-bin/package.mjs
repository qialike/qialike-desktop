/**
 * Package the application for one platform.
 *
 * A script rather than a bare `electron-builder` invocation, because four things
 * have to be true before it runs and none is expressible as an npm script argument.
 *
 * 1. **The runtime tree must exist.** electron-builder would happily package a
 *    tree that was never assembled, producing an application whose Host cannot
 *    start — a failure that shows up on someone's desktop rather than here.
 *
 * 2. **The target must be the host's.** A release target's native prebuilds cannot
 *    be cross-produced (DESIGN §3 D13): the macOS package needs a
 *    `bin/system.node` built on macOS, and this checkout does not carry one. So a
 *    cross-platform request is refused rather than producing an artifact that
 *    installs and then fails to keep a session lock.
 *
 * 3. **Signing is decided by policy, not by whichever environment happens to be
 *    set.** See `lib/signing.mjs`: the rules live there as a pure function so they
 *    can be exercised on every host, including the two platforms this one cannot
 *    build for. A refusal prints the remedy; an unsigned build is recorded beside
 *    the artifacts.
 *
 * 4. **The artifacts need checksums.** Linux packages are not signed (there is no
 *    Linux code-signing story worth the name) and an update feed is fetched over
 *    the network, so the digest is the integrity fact a downloader gets.
 *
 * Usage:
 *   node apps/desktop-bin/package.mjs [--target linux|mac|win] [--dir]
 *
 * @module qialike-desktop/package
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { DIST_DIR, ROOT, requireHostTarget } from './lib/paths.mjs'
import { pinnedPnpmEntry, pinnedPnpmVersion, shouldShimPnpm, writePnpmShim } from './lib/pnpm-path.mjs'
import { UNSIGNED_ENV, signingDecision } from './lib/signing.mjs'

/**
 * The electron-builder CLI entry point, resolved through its own manifest.
 *
 * WHY NOT `node_modules/.bin/electron-builder`. That path is a POSIX shell script
 * even on Windows — pnpm generates `electron-builder`, `.CMD` and `.ps1` side by
 * side, and the extensionless one is the `sh` script. Spawning it on Windows fails
 * with `ENOENT`, because there is no executable there, and spawning the `.CMD`
 * instead fails with `EINVAL`, because Node refuses to run a batch file without a
 * shell (the CVE-2024-27980 behaviour). Both were observed on this repository.
 *
 * The package's `bin` declaration is the portable answer, and it is the same
 * reasoning `lib/electron-binary.mjs` already applies to Electron: ask the package
 * where its executable is rather than guessing at a shim's spelling. `cli.js` is
 * plain JavaScript, so `node <cli> …` behaves identically on every platform and
 * needs no shell.
 *
 * @returns the absolute path to electron-builder's CLI script.
 * @throws Error when the package is absent, or declares no usable `bin`.
 */
function electronBuilderCli() {
  const require = createRequire(join(ROOT, 'package.json'))
  const manifestPath = require.resolve('electron-builder/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['electron-builder']
  if (typeof declared !== 'string' || declared.length === 0) {
    throw new Error(
      `qialike-desktop: ${manifestPath} declares no "electron-builder" bin entry, so the packaging `
      + 'step cannot find its CLI. That entry is how this script locates the program on every '
      + 'platform; re-check it against the installed electron-builder version.',
    )
  }
  return join(dirname(manifestPath), declared)
}

/** Parse `--flag value` pairs and bare flags. */
function parseArgs(argv) {
  const options = { target: undefined, dir: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dir') { options.dir = true; continue }
    if (arg === '--target') { options.target = argv[index + 1]; index += 1; continue }
    if (arg === '--help' || arg === '-h') {
      console.log('usage: package.mjs [--target linux|mac|win] [--dir]')
      process.exit(0)
    }
    console.error(
      `qialike-desktop: unknown argument ${JSON.stringify(arg)}\n`
      + 'usage: package.mjs [--target linux|mac|win] [--dir]',
    )
    process.exit(2)
  }
  return options
}

/** The digest of one file, in the format `sha256sum` prints. */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Write `SHA256SUMS` beside the artifacts, covering every downloadable one.
 *
 * @param outputDir - where electron-builder wrote the artifacts.
 * @param log - progress sink.
 * @returns the file it wrote, or undefined when there was nothing to cover.
 */
function writeChecksums(outputDir, log) {
  const artifacts = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    // The feed files are metadata the updater reads, not downloads; `builder-*`
    // is electron-builder's own scratch.
    .filter((entry) => !/^(latest.*\.ya?ml|builder-.*\.ya?ml|SHA256SUMS|UNSIGNED)$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (artifacts.length === 0) return undefined
  const lines = artifacts.map((name) => `${sha256(join(outputDir, name))}  ${name}`)
  const file = join(outputDir, 'SHA256SUMS')
  writeFileSync(file, `${lines.join('\n')}\n`)
  log(`checksums: ${String(artifacts.length)} artifact(s) -> ${file}`)
  return file
}

/**
 * Record that this build is unsigned, beside the artifacts.
 *
 * A file rather than a console line: the warning scrolls away, and whoever finds
 * the artifact later needs to know what they have. Its presence is the difference
 * between "we lost the signature" and "this was never signed on purpose".
 *
 * @param outputDir - where electron-builder wrote the artifacts.
 * @param targetName - the platform name.
 * @param log - progress sink.
 */
function writeUnsignedNotice(outputDir, targetName, log) {
  const file = join(outputDir, 'UNSIGNED')
  writeFileSync(file, [
    `${targetName} artifacts in this directory are NOT code-signed.`,
    '',
    `They were produced with ${UNSIGNED_ENV}=1, which is the deliberate opt-out.`,
    'Do not distribute them as a release: an unsigned build of this application',
    'cannot be updated in place on macOS or Windows, and a user installing it is',
    'trusting a file that nothing vouches for.',
    '',
    'To sign, set CSC_LINK and CSC_KEY_PASSWORD (and for macOS notarization also',
    'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) and rebuild without',
    `the ${UNSIGNED_ENV} opt-out.`,
    '',
  ].join('\n'))
  log(`unsigned: recorded in ${file}`)
}

const options = parseArgs(process.argv.slice(2))
// `requireHostTarget` rather than `hostTarget`: this used to be a bare
// `hostTarget().split('-')[0]`, which on a host outside the target table — any non-x64 Linux
// machine, since the table has no `linux-arm64` — died with a TypeError instead of saying
// which host was unsupported. See its note in paths.mjs.
//
// The `split` is a real translation, not string surgery for its own sake: target names are
// `<signing-name>-<arch>` and the signing policy is keyed by the coarse name, so the prefix
// IS the key. `tests/checkout-resolution.test.mjs` asserts that for every target.
const targetName = options.target ?? requireHostTarget().split('-')[0]

if (!existsSync(join(DIST_DIR, 'runtime', 'dsh', 'desktop-runtime.json'))) {
  console.error(
    'qialike-desktop: no runtime tree at dist/runtime/dsh. Assemble it first:\n'
    + '  pnpm run build',
  )
  process.exit(1)
}

const decision = signingDecision({ targetName, hostPlatform: process.platform, env: process.env })
if (!decision.ok) {
  console.error(`qialike-desktop: ${decision.reason}`)
  process.exit(1)
}
const { target } = decision

// Electron's download cache, electron-builder's own, and npm's, all into the
// workspace: the defaults live under `$HOME`, which is not always writable. The
// same constraint `pnpm-workspace.yaml` records for the pnpm store.
const scratch = join(ROOT, '.build-scratch')
const cache = join(scratch, 'electron-cache')
const builderCache = join(scratch, 'electron-builder-cache')
// The child's TEMP and TMP, into the workspace for the same reason and one more.
//
// WHY THIS HAS TO BE SET RATHER THAN INHERITED. `makensis` creates a temporary file at
// compile time: `LogicLib.nsh`'s `_Switch` macro needs one, and electron-builder reaches
// it from `assistedInstaller.nsh` via `PAGE_INSTALL_MODE`. Where the ambient temp
// directory cannot be written, the compile stops with
//
//     !tempfile: Unable to create temporary file!
//     Error in macro _Switch on macroline 8
//     !include: error in script: "assistedInstaller.nsh" on line 75
//
// which names a macro and a line but never a directory. On this repository that arrives
// after about nine minutes of work — the whole 189.9 MB intermediate archive is written
// first — so it reads as a packaging bug rather than a machine one, and the step it
// fails at has nothing to do with the installer's own logic.
//
// The ambient value is not something this script can check for and recover from, because
// the failure is inside a child process that reports it as a bare NSIS macro error.
// Redirecting it is the recovery: the workspace is where this build already writes
// everything else, and it is the one location the confined environment always permits.
const childTmp = join(scratch, 'tmp')
mkdirSync(cache, { recursive: true })
mkdirSync(builderCache, { recursive: true })
mkdirSync(childTmp, { recursive: true })

// MARK THE BUILDER CACHE AS COMMONJS, BECAUSE IT SITS UNDER A `type: module` ROOT.
// electron-builder extracts tool bundles into this directory and runs them with the
// ambient node. Node resolves the nearest `package.json` for a `.js` file, finds this
// repository's root manifest, and — because it declares `"type": "module"` — treats
// the tool as ESM. electron-builder's own tools are CommonJS, so the run dies with
// `ReferenceError: require is not defined in ES module scope` inside a file none of
// this repository's code wrote.
//
// It bites on Windows first because that is where the icon conversion runs: the NSIS
// target needs an `.ico`, and `icons@1.1.0`'s `icon-tool.js` is CommonJS. Linux's
// AppImage and deb need no `.ico`, so the Linux builds never extracted or executed it
// and the placement looked harmless.
//
// The marker is written here rather than moving the cache out of the repository: the
// comment above records why these caches are inside the workspace at all. A
// `package.json` in the cache root is the smallest thing that stops the ancestor
// manifest from reaching into a directory this build does not own the contents of.
writeFileSync(join(builderCache, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)

// Make the PINNED pnpm the one electron-builder's child processes find. It shells out
// to a bare `pnpm` to collect production dependencies, and the ambient one refuses
// with `ERR_PNPM_BAD_PM_VERSION` whenever its version disagrees with `packageManager`
// — which is the guard working, so it is satisfied rather than bypassed. See
// `lib/pnpm-path.mjs` for why a pin only the outermost command honours is not a pin.
const pinnedPnpm = pinnedPnpmVersion(ROOT)
const pnpmEntry = pinnedPnpmEntry({ root: ROOT })
let childPath = process.env.PATH
if (shouldShimPnpm(pnpmEntry)) {
  const shimDir = writePnpmShim({ dir: join(scratch, 'pnpm-bin'), entry: pnpmEntry })
  childPath = `${shimDir}${delimiter}${process.env.PATH ?? ''}`
  console.log(`  • pnpm ${pinnedPnpm} pinned for electron-builder via ${shimDir}`)
} else if (pinnedPnpm !== undefined) {
  console.log(
    `  • note: the pinned pnpm ${pinnedPnpm} could not be located, so electron-builder will use the one on `
    + 'PATH; if it disagrees with packageManager the packaging step fails with ERR_PNPM_BAD_PM_VERSION',
  )
}

const args = [
  ...target.args,
  ...(options.dir ? ['--dir'] : []),
  '--config', 'electron-builder.config.mjs',
]
// `node <cli.js>`, not the `.bin` shim: see `electronBuilderCli`.
const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
  cwd: join(ROOT, 'apps', 'desktop'),
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: childPath,
    electron_config_cache: cache,
    ELECTRON_CACHE: cache,
    ELECTRON_BUILDER_CACHE: builderCache,
    XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
    npm_config_cache: join(scratch, 'npm-cache'),
    TEMP: childTmp,
    TMP: childTmp,
  },
})

if (result.error !== undefined) {
  console.error(`qialike-desktop: cannot run electron-builder: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

const outputDir = join(DIST_DIR, 'packages')
const log = (message) => { console.log(`  • ${message}`) }
// Both facts come from the decision rather than being re-derived here. An earlier
// version tested `!decision.signed` for the notice, which is true on Linux — where
// there is no signature to have lost — and wrote an UNSIGNED file for every build.
if (decision.checksums) writeChecksums(outputDir, log)
if (decision.unsigned) writeUnsignedNotice(outputDir, targetName, log)
