/**
 * The release configuration: targets, signing, notarization, and the feed.
 *
 * These are the settings that decide what a release *is*, and every one of them
 * fails in a way that is invisible until much later — a target that is never
 * built, a notarization that cannot run, a feed that is configured and then
 * overwritten. The config is a module rather than a static file precisely so it can
 * be imported here with different environments and asked what it decided.
 *
 * The entitlements are parsed rather than grepped. They are the macOS build's
 * security posture, and a malformed plist is an app that will not launch on
 * someone else's machine — `plistlib` is the same parser family that will read it in
 * anger, which a regular expression is not.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/**
 * Import the builder config under a given environment, and report what it decided.
 *
 * In a child process with real Node, not through Vite's transform. Two reasons: the
 * module reads `process.env` at import time, so each case needs an uncached load —
 * and what a release configuration *means* is decided by Node, so testing it
 * through a bundler's module graph would be testing something adjacent to the thing
 * that runs.
 *
 * Only plain data is reported; `afterPack` is a function and comes back as its type.
 *
 * @param env - variables to set for the import.
 * @returns the fields a caller asserts on.
 */
function configWith(env) {
  const script = [
    'const c = (await import(process.argv[1])).default',
    'console.log(JSON.stringify({',
    '  linux: c.linux.target, mac: c.mac, win: c.win.target, publish: c.publish,',
    '  files: c.files, afterPack: typeof c.afterPack,',
    '  artifactNames: { linux: c.linux.artifactName, mac: c.mac.artifactName, win: c.win.artifactName },',
    '  executableNames: { linux: c.linux.executableName, mac: c.mac.executableName, win: c.win.executableName },',
    '  productName: c.productName,',
    '}))',
  ].join('\n')
  const configPath = join(ROOT, 'apps', 'desktop', 'electron-builder.config.mjs')
  // The developer's own shell must not be able to change the answer.
  const cleared = [
    'QIALIKE_DESKTOP_UPDATE_URL', 'CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK',
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  ]
  const base = { ...process.env, ...env }
  for (const name of cleared) if (!(name in env)) delete base[name]
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(configPath).href], {
    encoding: 'utf8',
    env: base,
    cwd: ROOT,
  })
  return JSON.parse(output)
}

describe('targets', () => {
  it('builds every platform this application ships for', () => {
    const config = configWith({})
    const names = (targets) => targets.map((entry) => (typeof entry === 'string' ? entry : entry.target))
    expect(names(config.linux).sort()).toEqual(['AppImage', 'deb'])
    expect(names(config.mac.target).sort()).toEqual(['dmg', 'zip'])
    expect(names(config.win).sort()).toEqual(['nsis'])
  })

  it('builds both Linux architectures, so the packages are not x64-only', () => {
    const config = configWith({})
    for (const entry of config.linux) {
      expect(entry.arch.sort(), entry.target).toEqual(['arm64', 'x64'])
    }
  })

  it('ships macOS as zip as well as dmg', () => {
    // `zip` is what electron-updater consumes on macOS; `dmg` is what a person
    // downloads. Without the zip an update feed has nothing to point at.
    const config = configWith({})
    const zip = config.mac.target.find((entry) => entry.target === 'zip')
    expect(zip).toBeDefined()
  })
})

describe('signing and notarization', () => {
  it('turns notarization on only when it can possibly succeed', () => {
    // It needs a signature to notarize *and* three credentials. Hard-coded `true`
    // would make the documented `DSH_DESKTOP_UNSIGNED=1` opt-out unusable on macOS.
    expect((configWith({})).mac.notarize).toBe(false)
    expect((configWith({ CSC_LINK: 'file:///tmp/c.pfx' })).mac.notarize).toBe(false)
    expect((configWith({
      CSC_LINK: 'file:///tmp/c.pfx',
      APPLE_ID: 'someone@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
      APPLE_TEAM_ID: 'ABCDE12345',
    })).mac.notarize).toBe(true)
  })

  it('runs the macOS build under the hardened runtime', () => {
    // Required for notarization, and the entitlements below exist because of it.
    expect((configWith({})).mac.hardenedRuntime).toBe(true)
  })

  it('points the entitlements at a plist that parses, and uses it for helpers too', () => {
    const config = configWith({})
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist')
    // Children are separate signed binaries; without the same entitlements the Host
    // child process is refused the libraries it loads.
    expect(config.mac.entitlementsInherit).toBe(config.mac.entitlements)

    const plist = join(ROOT, 'apps', 'desktop', config.mac.entitlements)
    const parsed = JSON.parse(execFileSync('python3', ['-c', [
      'import json,plistlib,sys',
      'with open(sys.argv[1], "rb") as handle:',
      '    print(json.dumps(plistlib.load(handle)))',
    ].join('\n'), plist], { encoding: 'utf8' }))

    // Each of these corresponds to something the application genuinely does; the
    // plist's own comments say which. An entitlement added without a reason is a
    // hole nobody can review later, which is why the set is asserted rather than
    // "at least these".
    expect(parsed).toEqual({
      'com.apple.security.cs.disable-library-validation': true,
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true,
      'com.apple.security.cs.allow-dyld-environment-variables': true,
    })
  })
})

describe('the update feed', () => {
  it('is absent for a build that has none, so no feed file is written', () => {
    expect((configWith({})).publish).toBeNull()
  })

  it('becomes a generic provider when the build is given a URL', () => {
    const config = configWith({ QIALIKE_DESKTOP_UPDATE_URL: 'https://updates.example/qialike' })
    expect(config.publish).toEqual([
      { provider: 'generic', url: 'https://updates.example/qialike', channel: 'latest' },
    ])
  })

  it('is not shadowed by a second publish key', () => {
    // It had two for a while — the conditional spread, and a `publish: null` at the
    // end for the no-feed case. In an object literal the later key wins, so the feed
    // was configured and then silently overwritten by the very line meant to be its
    // fallback: the build saw no feed at all and wrote no `app-update.yml`.
    //
    // The two tests above are the real guard, and checking them is what found it: if
    // a later key shadowed the spread, the URL case would resolve to null. This
    // states the invariant they establish together.
    expect(configWith({ QIALIKE_DESKTOP_UPDATE_URL: 'https://updates.example' }).publish).not.toBeNull()
    expect(configWith({}).publish).toBeNull()
  })
})

describe('artifact names', () => {
  /**
   * The scheme, as the config is expected to spell it.
   *
   * WHY THIS IS ASSERTED RATHER THAN LEFT TO THE BUILD. A name is the interface between this
   * repository and everything downstream of it — the release host's asset list, `SHA256SUMS`, the
   * update feed, and whatever a person types to run the file. It drifted twice in one day
   * (`qialike-${version}-…` → `qialike-…` → `qialike-desktop-linux-…`) and each move silently
   * invalidated the hand-run update probe, which is the failure
   * `probe-artifact-discovery.test.mjs` was written for. Two of the three targets carried no
   * `artifactName` at all until 2026-10-13, so Windows shipped as `Qialike Setup 0.3.3.exe` — a
   * name matching neither the scheme nor any other target's convention — and nothing noticed.
   */
  const EXPECTED = {
    linux: 'qialike-desktop-linux-${arch}.${ext}',
    mac: 'qialike-desktop-mac-${arch}.${ext}',
    win: 'qialike-desktop-win-${arch}.${ext}',
  }

  it('names every target qialike-desktop-<platform>-<arch>.<ext>', () => {
    const { artifactNames } = configWith({})
    expect(artifactNames).toEqual(EXPECTED)
  })

  it('spells the platform out, because `${os}` is not a macro electron-builder expands', () => {
    // The trap this records: `${os}` reads like it should work and appears nowhere in
    // app-builder-lib's expansion code, so an artifactName written with it would ship the literal
    // text into the file name. Spelled-out tokens also match `TARGETS` in `paths.mjs`, so a file
    // name and a target cannot disagree about what they call a platform.
    for (const [platform, name] of Object.entries(EXPECTED)) {
      expect(name, `${platform} does not spell its platform`).toContain(`-${platform}-`)
      expect(name, `${platform} uses \${os}, which is not a macro`).not.toContain('${os}')
    }
  })

  it('carries no version, which is what keeps an AppImage update in place', () => {
    // A version in the name is not merely cosmetic on Linux: `AppImageUpdater` treats a running
    // file whose name carries no `\d+.\d+.\d+` as "overwrite in place", so the update replaces the
    // path the user launches. With a version it writes the new file beside the old one and leaves
    // that behind. Keeping every target on the same rule keeps that behaviour true everywhere.
    for (const [platform, name] of Object.entries(EXPECTED)) {
      expect(name, `${platform} carries a version`).not.toContain('${version}')
      expect(name, `${platform} looks like it embeds a literal version`).not.toMatch(/\d+\.\d+\.\d+/u)
    }
  })
})

describe('executable names', () => {
  it('installs the program as `qialike-desktop` on Windows, not `Qialike`', () => {
    // THE KEY IS NOT OBVIOUS AND THE FAILURE IS SILENT. On Windows electron-builder renames the
    // Electron binary to `appInfo.productFilename`, and that is `sanitizeFileName(executableName)`
    // when set and the sanitized product name otherwise. So dropping this key does not fail
    // anything — it quietly ships `Qialike.exe`, which is what the build did until now. The
    // installer's directory name and its shortcuts follow the same value, so one missing key
    // moves three things at once.
    expect(configWith({}).executableNames.win).toBe('qialike-desktop')
  })

  it('does not reuse the CLI’s executable name, which is plain `qialike`', () => {
    // `qialike` is the CLI's own command name, and the two products are meant to be installed
    // side by side and share one `$DSH_HOME`. A Windows binary called `qialike.exe` would make
    // `tasklist`, Task Manager and a shortcut's target ambiguous between them.
    expect(configWith({}).executableNames.win).not.toBe('qialike')
  })

  it('leaves the Linux executable name alone, where `qialike` is already shipped', () => {
    // Asserted rather than assumed: the `linux` block's name is what the `.desktop` entry's
    // `Exec=` and the README's AppImage instructions use, so changing the Windows key must not
    // drag it along. The two blocks are independent, and this is what says so.
    expect(configWith({}).executableNames.linux).toBe('qialike')
  })

  it('keeps the product name capitalised, which is what a shortcut reads', () => {
    // The split the file names follow and the interface must not: `Qialike` is what a person
    // reads — the window, the About panel, the installer, the shortcut — and the lower case
    // belongs to the file system. Asserting both together is the point: a change that made them
    // agree would be a different change, and this is where that would show.
    const config = configWith({})
    expect(config.productName).toBe('Qialike')
    expect(config.executableNames.win).not.toBe(config.productName)
  })

  it('leaves macOS alone, where the same key would rename the bundle', () => {
    // Reported rather than left silent: `Qialike.app` is deliberate, and the assertion records
    // which platforms were considered rather than only which one was changed.
    expect(configWith({}).executableNames.mac).toBeUndefined()
  })
})

describe('the packaged runtime tree', () => {
  it('is copied by the pack hook', () => {
    const config = configWith({})
    // Reported as its type by the child process; the hook cannot cross as JSON.
    expect(config.afterPack).toBe('function')
    expect(config.files).toContain('lib/**/*')
  })

  it('is not declared through extraResources, which drops node_modules', () => {
    // The regression guard. Configured this way electron-builder copied 13105 of
    // ~35000 files and omitted `node_modules` entirely — the one directory the Host
    // resolves every import through. The hook replaces it; this keeps it replaced.
    const source = readFileSync(join(ROOT, 'apps', 'desktop', 'electron-builder.config.mjs'), 'utf8')
    expect(source).not.toMatch(/^\s*extraResources:/mu)
  })
})

describe('the Electron version', () => {
  it('is pinned exactly, not by range', () => {
    // A caret range resolved to 44.4.5, and the harness's Loader refused to start:
    // its native addon fingerprints the runtime and rejects anything outside a table
    // naming 43.0.0, 44.0.0 and 45.0.0-alpha.6. The harness's own lockfile pins
    // 44.0.0 for the same reason.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'))
    expect(manifest.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/u)
  })
})
