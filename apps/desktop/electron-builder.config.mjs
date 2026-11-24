/**
 * electron-builder configuration (M7's first half: Linux artifacts).
 *
 * Run from `apps/desktop`, so every relative path below is relative to it:
 *
 *     node ../../node_modules/.bin/electron-builder --linux AppImage deb \
 *       --config electron-builder.config.mjs
 *
 * THREE DECISIONS WORTH READING BEFORE CHANGING THIS FILE.
 *
 * 1. **The runtime tree is an `extraResource`, not part of the asar.** It is a
 *    pnpm workspace: `node_modules` entries are symlinks into `packages/`, it
 *    holds native binaries (`system.node`), and it is the module root of a
 *    *separate* Node-mode process. asar represents none of those faithfully, so
 *    the tree ships as `resources/dsh` and `paths.ts` resolves it there. See that
 *    file's `runtimeDir` for the full reasoning.
 *
 * 2. **Nothing is rebuilt for Electron.** `npmRebuild: false` and no
 *    `nodeGypRebuild`: the shell's own code is plain JavaScript with no native
 *    dependencies, and the runtime tree's natives are Node-API 8 prebuilds that
 *    the Host process loads directly. Rebuilding them against Electron's ABI
 *    would be work with no consumer.
 *
 * 3. **The Electron version is pinned exactly, not by range.** A caret range
 *    resolved to 44.4.5 and the packaged application refused to start its Host:
 *    `node-addon-require-builtin` — a third-party native addon the harness's
 *    Loader uses — fingerprints the runtime and rejects anything outside a table
 *    naming Electron `43.0.0`, `44.0.0` and `45.0.0-alpha.6`. 44.4.5 is not
 *    44.0.0. The harness's own lockfile pins `electron@44.0.0` for the same
 *    reason; `apps/desktop/package.json` pins it exactly to match. Raising it is
 *    a real change: check the new version's fingerprint is in the table.
 *
 * 4. **`electron-updater` is deliberately kept, though nothing imports it yet.**
 *    It is declared for M7's second half (auto-update), and leaving it in place
 *    means this config already ships the dependency that half needs. It has no
 *    native modules, so it costs bytes and nothing else.
 *
 * @module @qialike/desktop/electron-builder.config
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyRuntimeTree } from '../desktop-bin/lib/pack-runtime.mjs'

/**
 * Absolute-from-here paths, so the config does not depend on the cwd.
 *
 * `fileURLToPath`, NOT `new URL(...).pathname`. On POSIX the two agree, which is
 * why `.pathname` survived here; on Windows `pathname` yields `/C:/qialike/...`,
 * and a drive-relative path with a leading slash resolves to `C:\C:\qialike\...`
 * — so `copyRuntimeTree` would find nothing to copy and the package would be
 * refused or, worse, shipped without the runtime tree it exists to place.
 */
const runtimeTree = fileURLToPath(new URL('../../dist/runtime/dsh', import.meta.url))

/**
 * The Electron payload to stage from, on Windows.
 *
 * WHY NOT LET electron-builder EXTRACT IT. `app-builder-lib@26.15.3` extracts the
 * Electron archive into `<appOutDir>.tmp` and then renames that onto `<appOutDir>`.
 * On Windows that rename fails with `EPERM` even though the destination does not
 * exist, because the extraction still holds a handle on a file inside the directory
 * being moved. Measured on Windows 10.0.26300: the same rename from a separate
 * process, once the tree has settled, succeeds; and renaming onto an *existing*
 * directory fails for the unrelated reason that Windows has no
 * "replace this directory" rename. POSIX renames a directory over a non-existent
 * target without consulting its contents, so Linux and macOS never reach either
 * failure — which is why this is gated rather than applied everywhere.
 *
 * `electronDist` is electron-builder's own documented input for "use this Electron
 * instead". Pointed at an ALREADY-UNPACKED distribution it takes the other branch in
 * `unpack()`: that branch empties `appOutDir` and copies the tree, so no extraction
 * and no rename happen. It is byte-equivalent rather than a substitute: `electron`'s
 * own postinstall extracts the same archive, and this tree's 19 entries match the
 * ones electron-builder produced into `win-unpacked.tmp` here name for name.
 *
 * THIS IS WHY `pnpm-workspace.yaml` APPROVES electron's BUILD SCRIPT. Without that
 * approval there is no `dist/`, and this branch is unavailable.
 *
 * KEPT OFF THE OTHER PLATFORMS DELIBERATELY. Linux is the built and verified target
 * and does not hit this; changing how it stages Electron would trade a known-good
 * path for an untested one. The asymmetry is the failure, not a preference.
 */
const localElectronDist = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'node_modules', 'electron', 'dist',
)
const useLocalElectronDist = process.platform === 'win32'
  && existsSync(join(localElectronDist, 'electron.exe'))

/**
 * Whether this build will be signed, and whether it can be notarized.
 *
 * Read here rather than left to electron-builder because notarization has to be
 * *disabled* when signing is: it needs a signature to notarize and its own three
 * credentials besides, so a hard-coded `notarize: true` would make the documented
 * `DSH_DESKTOP_UNSIGNED=1` opt-out unusable on macOS — the guard would stand aside
 * and notarization would fail the build instead.
 *
 * `lib/signing.mjs` owns the policy these mirror; this only reports what the
 * environment holds.
 */
const willSign = Boolean(process.env.CSC_LINK ?? process.env.CSC_NAME)
const notarize = willSign
  && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

export default {
  appId: 'com.qialike.desktop',
  productName: 'Qialike',
  // Omitted entirely off Windows, where electron-builder's own extraction works; see
  // the note on `localElectronDist`. Not a key with an undefined value: electron-builder
  // branches on whether `electronDist` is a non-empty string, so leaving it absent is
  // what selects its default behaviour.
  ...(useLocalElectronDist ? { electronDist: localElectronDist } : {}),
  // MUST MATCH `COPYRIGHT` IN `apps/desktop/src/paths.ts`, which the About panel shows.
  //
  // Not imported from there, deliberately. `paths.ts` compiles to `apps/desktop/lib/paths.js`, which is
  // generated and untracked, while this file imports only handwritten code
  // (`../desktop-bin/lib/pack-runtime.mjs`). Importing generated output would turn "assembled the
  // runtime tree without compiling the shell first" into a module-resolution error from inside
  // electron-builder, instead of the clear "no runtime tree" message `package.mjs` already prints. The
  // duplication is guarded instead: `tests/about-panel.test.mjs` reads both files and fails when they
  // disagree.
  copyright: 'Copyright © qialike contributors. MIT licensed.',

  directories: {
    // Holds `icon.png`, which `linux.icon` below points at.
    buildResources: 'build',
    // Repo-level, beside the runtime tree and the build descriptors, so one
    // `dist/` holds everything a run produced.
    output: '../../dist/packages',
  },

  /**
   * What goes inside `app.asar`.
   *
   * `node_modules` is intentionally absent: the pattern list replaces
   * electron-builder's default, and the only production dependency declared here
   * is `electron-updater`, which no shipped module imports yet. Leaving it out
   * keeps the archive to the shell's own code — and means the packaged tree has
   * exactly one place a runtime module can come from, `resources/dsh`.
   */
  files: [
    'lib/**/*',
    'preload/**/*',
    'renderer/**/*',
    'package.json',
  ],

  /**
   * The runtime tree is placed by a hook, not by `extraResources`.
   *
   * `extraResources` silently omits `node_modules` — 13105 of the tree's ~35000
   * files arrived and the one directory the Host resolves every import through did
   * not. `copyRuntimeTree` does the copy with `cpSync` and verifies the result
   * against the source before the pack continues.
   */
  afterPack: async (context) => {
    copyRuntimeTree({
      from: runtimeTree,
      appOutDir: context.appOutDir,
      log: (message) => { console.log(`  • ${message}`) },
    })
  },

  /**
   * One artifact-name scheme for every target: `qialike-desktop-<platform>-<arch>.<ext>`.
   *
   * PER PLATFORM RATHER THAN ONE TOP-LEVEL `artifactName`, because neither half of the name can
   * be centralised:
   *
   *   · **the platform is written out, never `${os}`.** `${os}` is not a macro electron-builder
   *     expands — it appears nowhere in app-builder-lib's expansion code, while `${arch}`,
   *     `${ext}`, `${version}` and `${productName}` all do. So each platform block below spells
   *     its own token — `linux`, `win`, `mac` — matching this repository's own target names
   *     (`TARGETS` in `apps/desktop-bin/lib/paths.mjs`), so a file name and a target cannot
   *     disagree about what they call a platform.
   *   · **`${arch}` is left to electron-builder, and each spelling is right.** The AppImage gets
   *     `x86_64` (uname), the deb gets `amd64` (the Debian architecture name `dpkg` expects), and
   *     Windows and macOS get `x64`. One hardcoded spelling would misname two of the three.
   *
   * **No `${version}`, deliberately.** A file name is a name, not a version record; the version
   * lives in `latest.yml` / `latest-linux.yml`, which is what the updater reads. Dropping it also
   * fixes an update behaviour rather than only tidying a string: `AppImageUpdater` treats a
   * running file whose name carries no `\d+.\d+.\d+` as "overwrite in place", so an update
   * replaces the very path the user launches — with a version in the name it writes the new file
   * *beside* the old one and leaves that behind.
   *
   * **The file name's `qialike` is not `${productName}`, and that is the point.** The product name
   * stays capitalised — it is what the window, the `.desktop` entry, the installer and the About
   * panel show — while the file name is lower case because a release host refused the capitalised
   * form with `附件名称存在违规内容`, and every asset its own repository carries is lower case
   * (`qialike-linux-x64.tar.gz`, `sha256sums.txt`). The two were the same string until
   * 2026-10-13, so this is the one place the distinction has to be written down.
   *
   * A scoped package name is not a usable artifact name either: left to derive them,
   * electron-builder names the deb from the `name` field — `@qialike/desktop_0.1.0_amd64.deb`,
   * which is a path with a directory in it and which it cannot create. `packageName` fixes the
   * deb's own identifier, and `artifactName` fixes the files.
   */
  deb: {
    packageName: 'qialike',
    // The control file's Description is multi-line by design (first line is the
    // synopsis, the indented block is the long description).
    description: [
      'The qialike desktop application: the deepseek-harness browser surface in an',
      'Electron window, with qialike\'s provider catalogue, branding and file tools.',
      '',
      'It shares its session store, settings, credentials and provider configuration',
      'with the qialike terminal client.',
    ].join('\n'),
  },

  npmRebuild: false,

  /**
   * Do not let electron-builder rewrite the Windows executable's resources.
   *
   * WHY. On Windows, electron-builder renames Electron's binary and then uses
   * `resedit` to add an `INTEGRITY`/`ELECTRONASAR` resource carrying the asar hash.
   * With Electron 44 on Windows 10.0.26300 that rewrite produces an image Windows
   * refuses to load: `CreateProcess` fails with an unmappable error, which Node
   * surfaces as `spawn UNKNOWN`. Measured directly —
   *
   *   · the untouched Electron binary, copied into the same `win-unpacked` directory,
   *     starts and runs this application's asar (it prints the product's own startup
   *     line), so the packaged resources are correct;
   *   · the same binary after the integrity rewrite cannot be spawned at all;
   *   · packaging with this flag set produces a 512-byte-smaller executable that runs.
   *
   * WHY SKIPPING IT COSTS NOTHING HERE. That resource is read only when Electron's
   * `EnableEmbeddedAsarIntegrityValidation` fuse is enabled, and this build sets no
   * fuses — `electronFuses` appears nowhere in this repository. The resource is
   * therefore inert in the application as configured, and omitting it removes an
   * unused blob rather than a validation step.
   *
   * WHAT WOULD INVALIDATE THAT. Enabling that fuse, or any future fuse that reads the
   * embedded integrity data. The resource would then be load-bearing and this flag
   * would have to come off — together with a fix for the rewrite itself, which is
   * upstream of this repository. Stated here because the flag reads like a weakening
   * of packaging and is not one today: it is the difference between a binary that
   * runs and one that does not.
   *
   * NOT GATED BY PLATFORM, because `asarIntegrity` is only consulted for Windows in
   * `ElectronFramework`; macOS receives the same hashes through `Info.plist` and is
   * unaffected by this key.
   */
  disableAsarIntegrity: true,

  // The default is a 7z pass over half a gigabyte of tree; `store` trades a larger
  // artifact for a build that finishes. Left at the default because a release
  // artifact is downloaded far more often than it is built.
  compression: 'normal',

  /**
   * The update feed, when the build has one.
   *
   * LAST KEY IN THIS OBJECT ON PURPOSE. It used to be declared before `mac`, with
   * a second `publish: null` at the end for the no-feed case — and in an object
   * literal the later key wins, so the feed was configured and then silently
   * overwritten. Two keys for one setting is a bug waiting for whoever edits the
   * file next; one conditional key is not.
   *
   * electron-builder writes `app-update.yml` from this, which is what the updater
   * reads in a packaged application. Absent, no `app-update.yml` is produced, the
   * shell reports "no feed configured" once at startup, and the update badge stays
   * out of the way — the correct behaviour for the many builds of this application
   * that nobody publishes updates for.
   */
  ...(process.env.QIALIKE_DESKTOP_UPDATE_URL === undefined || process.env.QIALIKE_DESKTOP_UPDATE_URL === ''
    ? { publish: null }
    : {
        publish: [{
          provider: 'generic',
          url: process.env.QIALIKE_DESKTOP_UPDATE_URL,
          // Both channels electron-builder emits, so one directory can serve every
          // platform's feed without a rewrite.
          channel: 'latest',
        }],
      }),

  /**
   * macOS.
   *
   * The hardened runtime is required for notarization, and the entitlement list it
   * needs is in `build/entitlements.mac.plist` — read that file before changing
   * anything here, because every entry it holds corresponds to something the
   * application genuinely does.
   *
   * SIGNING IS DRIVEN BY THE ENVIRONMENT. electron-builder reads `CSC_LINK` and
   * `CSC_KEY_PASSWORD` on its own; notarization additionally needs `APPLE_ID`,
   * `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. With none of them set the
   * build still runs and produces an unsigned artifact — `package.mjs` is what
   * decides whether that is allowed, and by default for a release it is not.
   */
  mac: {
    // `qialike-desktop-mac-${arch}.${ext}` — the shared scheme, stated above the platform keys.
    artifactName: 'qialike-desktop-mac-${arch}.${ext}',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // `zip` is what electron-updater consumes on macOS; `dmg` is what a person
    // downloads. Both, so the feed and the website need not be served differently.
    notarize: notarize,
    // The Host is a child process that must survive Gatekeeper's per-binary
    // checks; without this the notarization staple covers the bundle but the
    // re-executed binary is judged separately.
    gatekeeperAssess: false,
  },

  /**
   * Windows.
   *
   * NSIS rather than a portable exe: the application owns a profile directory and
   * a `$DSH_HOME`, and an installer that can uninstall cleanly is what a user
   * expects from something that writes outside its own folder.
   *
   * SIGNING: `CSC_LINK` / `CSC_KEY_PASSWORD` hold a certificate, and for an
   * EV/token-based signer electron-builder also accepts `WIN_CSC_LINK`. v1 ships
   * unsigned by decision (DESIGN §12.2 R7) — SmartScreen warns until a certificate
   * exists, and `package.mjs` refuses an unsigned build unless that is explicit.
   */
  win: {
    // Derives `qialike-desktop-win-x64.exe`, and `…-win-arm64.exe` for the other arch. Without
    // this the installer is named from the product name and version — `Qialike Setup 0.3.3.exe` —
    // which is a name no other target's file shares a convention with.
    artifactName: 'qialike-desktop-win-${arch}.${ext}',
    /**
     * The installed program is `qialike-desktop.exe`, not `Qialike.exe`.
     *
     * HOW THIS WORKS, BECAUSE IT IS NOT OBVIOUS. On Windows electron-builder names the renamed
     * Electron binary after `appInfo.productFilename`, and `productFilename` is
     * `sanitizeFileName(executableName)` **when `executableName` is set**, falling back to the
     * sanitized product name when it is not. So this one key is what renames the executable —
     * `executableName` is not Linux-only despite the `linux` block below being the first place
     * this repository set it.
     *
     * WHY `qialike-desktop` RATHER THAN `qialike`. `qialike` is the CLI's own executable name —
     * its README installs a `qialike` command — so naming this application's binary `qialike`
     * too would make `tasklist`, Task Manager and a shortcut's target ambiguous between two
     * products that are meant to be installed side by side. It also matches the artifact scheme
     * above, where `qialike-desktop` is what distinguishes this application from the CLI.
     *
     * TWO CONSEQUENCES WORTH KNOWING. The NSIS installer derives the installation directory from
     * the same value (`getWindowsInstallationDirName`), so the program installs to
     * `…\qialike-desktop\` rather than `…\Qialike\`; and the shortcuts still read **Qialike**,
     * because a shortcut's name comes from `productName`, which stays capitalised. That is the
     * same split the file names already follow — the product is `Qialike` wherever a person reads
     * it, and the files are lower case.
     *
     * NOT SET AT THE TOP LEVEL, so macOS is unaffected: its bundle is still `Qialike.app`, and
     * renaming a bundle is a different change with its own consequences. The same line in the
     * `mac` block would do it if that is ever wanted. The `linux` block keeps `qialike`, which is
     * the name its shipped `.desktop` entry and README instructions already use.
     */
    executableName: 'qialike-desktop',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.png',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // The updater runs the installer to apply a downloaded update; without this it
    // cannot do so silently.
    differentialPackage: true,
  },

  linux: {
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
    ],
    // The shared scheme, stated once above the platform keys. This target is the one that
    // carried a name before the others did, which is why the explanation lives up there now
    // rather than here: one home per fact.
    artifactName: 'qialike-desktop-linux-${arch}.${ext}',
    category: 'Development',
    icon: 'build/icon.png',
    // Derived from the package name (`@qialike/desktop`) this would be
    // `@qialikedesktop`, which electron-builder refuses: a scoped name is not a
    // usable file name. The window's WM_CLASS is what a desktop environment links
    // the running window to; `syncDesktopName` keeps the .desktop entry's basename
    // — and therefore that association — matching.
    executableName: 'qialike',
    synopsis: 'Desktop coding agent on deepseek-harness',
    // `deb` requires one; electron-builder otherwise infers it from the author
    // field, which this package does not set.
    maintainer: 'qialike contributors',
    // Single line on purpose: electron-builder feeds this to the .desktop entry's
    // `Comment`, which is a one-line field — a multi-line value renders as literal
    // `\n` in a desktop menu. The long form lives on `deb.description` below,
    // where the control file's `Description` genuinely is multi-line.
    description: 'Desktop coding agent on deepseek-harness',
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: 'Qialike',
        Comment: 'Desktop coding agent on deepseek-harness',
        Categories: 'Development;Utility;',
        // The window is the application; there is no document to open, so no
        // `MimeType` and no `%U` argument.
        StartupWMClass: 'Qialike',
      },
    },
  },

}
