/**
 * The shell's Host protocol and its IPC boundary.
 *
 * Both are contracts with a peer the shell does not control at runtime — a Host
 * child that a different build may have produced, and a renderer that is
 * untrusted by construction. The tests below are mostly about what happens when
 * the peer is *wrong*: an unknown message, a frame from the wrong document. A
 * check that only covers the happy path is the one that misses a version skew.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOST_PROTOCOL_VERSION, hostEnvironment, isHostEvent } from '../apps/desktop/src/host-process.ts'
import { APP_HOSTNAME, DESKTOP_IPC, SHELL_HOSTNAME, isApplicationFrame } from '../apps/desktop/src/ipc.ts'
import { PROFILE_BUNDLES, PROFILE_NAME, dshHome, profileDir, runtimeDir, userDataDir } from '../apps/desktop/src/paths.ts'

// `fileURLToPath`, not `new URL(...).pathname`: on Windows `pathname` is
// `/C:/qialike/...`, and `join` then makes that drive-relative, so every read
// below looked for `C:\C:\qialike\...` and failed with ENOENT.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('isHostEvent', () => {
  it('accepts a well-formed ready event', () => {
    expect(isHostEvent({ type: 'ready', url: 'http://127.0.0.1:1/?token=t', injections: [] })).toBe(true)
  })

  it('accepts a fatal event with and without a diagnostic', () => {
    expect(isHostEvent({ type: 'fatal', message: 'boom' })).toBe(true)
    expect(isHostEvent({ type: 'fatal', message: 'boom', diagnostic: 'stack' })).toBe(true)
  })

  it('accepts shutdown-complete', () => {
    expect(isHostEvent({ type: 'shutdown-complete' })).toBe(true)
  })

  it('rejects a ready event with no usable url', () => {
    // A Host that reported readiness without a URL would send the shell into an
    // authentication exchange against nothing.
    expect(isHostEvent({ type: 'ready', injections: [] })).toBe(false)
    expect(isHostEvent({ type: 'ready', url: '', injections: [] })).toBe(false)
    expect(isHostEvent({ type: 'ready', url: 123, injections: [] })).toBe(false)
  })

  it('rejects a ready event whose injections are not a list', () => {
    // The renderer iterates this; a string would be iterated character by
    // character and mount nothing.
    expect(isHostEvent({ type: 'ready', url: 'http://x/', injections: 'nope' })).toBe(false)
    expect(isHostEvent({ type: 'ready', url: 'http://x/', injections: undefined })).toBe(false)
  })

  it('rejects a fatal event with no message', () => {
    expect(isHostEvent({ type: 'fatal' })).toBe(false)
    expect(isHostEvent({ type: 'fatal', message: 42 })).toBe(false)
  })

  it('rejects an unknown type, which is a protocol disagreement', () => {
    expect(isHostEvent({ type: 'progress', percent: 50 })).toBe(false)
    expect(isHostEvent({})).toBe(false)
  })

  it('rejects non-objects rather than throwing', () => {
    for (const value of [null, undefined, 1n, 'ready', [], Symbol('ready')]) {
      expect(isHostEvent(value)).toBe(false)
    }
  })
})

describe('hostEnvironment', () => {
  it('sets the variable that turns the Electron binary into Node', () => {
    expect(hostEnvironment({}).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('preserves the rest of the environment', () => {
    const env = hostEnvironment({ DSH_HOME: '/home/x/.dsh', PATH: '/usr/bin' })
    expect(env.DSH_HOME).toBe('/home/x/.dsh')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('does not mutate its input', () => {
    const base = { PATH: '/usr/bin' }
    hostEnvironment(base)
    expect(base.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('isApplicationFrame', () => {
  it('accepts the product document', () => {
    expect(isApplicationFrame('qialike-app://app/')).toBe(true)
    expect(isApplicationFrame('qialike-app://app/index.html?x=1')).toBe(true)
  })

  it('rejects the scheme shell documents on a product channel', () => {
    // The loading page is a different document with no preload; it has no
    // business reading product state.
    expect(isApplicationFrame(`qialike-app://${SHELL_HOSTNAME}/`)).toBe(false)
  })

  it('accepts the shell documents when they are what is asked for', () => {
    expect(isApplicationFrame(`qialike-app://${SHELL_HOSTNAME}/index.html`, [SHELL_HOSTNAME])).toBe(true)
  })

  it('rejects every other scheme and origin', () => {
    for (const url of [
      'file:///etc/passwd',
      'https://app/',
      'http://app/',
      'qialike-app://other/',
      'about:blank',
      '',
      'not a url',
      // A lookalike host must not pass: the check is on the parsed hostname.
      'qialike-app://app.evil.example/',
    ]) {
      expect(isApplicationFrame(url), url).toBe(false)
    }
  })

  it('accepts any port on the application hostname', () => {
    // The scheme is registered without a port, but a URL may still carry one.
    expect(isApplicationFrame(`qialike-app://${APP_HOSTNAME}:0/`)).toBe(true)
  })
})

describe('DESKTOP_IPC', () => {
  it('namespaces every channel', () => {
    // A channel without the prefix is one a future `ipcMain.handle` elsewhere
    // could collide with, and the collision would be silent.
    for (const [key, channel] of Object.entries(DESKTOP_IPC)) {
      expect(channel.startsWith('qialike-desktop:'), key).toBe(true)
    }
  })
})

describe('paths', () => {
  // WHY THESE EXPECTATIONS ARE COMPUTED RATHER THAN SPELLED OUT. Each function
  // below `resolve`s or `join`s what it is given, which is correct on every
  // platform and observable as such: on Windows `resolve('/tmp/home')` is
  // `C:\tmp\home` and a `join` separates with `\`. Hard-coding the POSIX spelling
  // therefore asserted the *host* rather than the *rule*, and failed on Windows
  // while the code was right. Stating the rule in the same terms the
  // implementation uses keeps the assertion about what the function does.
  it('reads DSH_HOME from the environment', () => {
    expect(dshHome({ DSH_HOME: '/tmp/home' })).toBe(resolve('/tmp/home'))
    expect(dshHome({ DSH_HOME: '  ' })).toMatch(/\.dsh$/)
    expect(dshHome({})).toMatch(/\.dsh$/)
  })

  it('owns a profile name no other product uses', () => {
    // The three applications may run at once against one $DSH_HOME; two of them
    // sharing a profile directory would race on its lockfile.
    expect(PROFILE_NAME).toBe('qialike-desktop')
    expect(['desktop', 'tui', 'web']).not.toContain(PROFILE_NAME)
    expect(profileDir({ DSH_HOME: '/tmp/home' })).toBe(join(resolve('/tmp/home'), 'profiles', 'qialike-desktop'))
  })

  it('declares the browser surface beneath our own bundle', () => {
    // Order is the composition order: our patch layer is applied last so it can
    // override a row the web bundle set.
    expect(PROFILE_BUNDLES.at(-1)).toBe('@qialike/qialike-desktop-app')
    expect(PROFILE_BUNDLES).toContain('@deepseek-ai/dsh-web-app')
  })

  it('resolves the runtime tree beside the app when packaged', () => {
    // Beside `app.asar`, not inside it: the tree holds symlinks and native
    // binaries, and asar can represent neither.
    expect(runtimeDir({ packaged: true, resourcesPath: '/opt/app/resources', cwd: '/tmp' }))
      .toBe(join('/opt/app/resources', 'dsh'))
  })

  it('resolves the runtime tree from the build output when not packaged', () => {
    expect(runtimeDir({ packaged: false, resourcesPath: '/unused', cwd: '/repo' }))
      .toBe(resolve('/repo', 'dist', 'runtime', 'dsh'))
  })

  it('lets the development override win over both', () => {
    expect(runtimeDir({ packaged: true, resourcesPath: '/x', cwd: '/y', env: { QIALIKE_DESKTOP_DSH_DIR: '/custom' } }))
      .toBe(resolve('/custom'))
  })

  it('isolates user data only when asked', () => {
    // The no-override branch is a pass-through, so it stays the string it was
    // given even where that string is not the host's idea of absolute.
    expect(userDataDir({ userDataPath: '/home/u/.config/Qialike' })).toBe('/home/u/.config/Qialike')
    expect(userDataDir({ userDataPath: '/x', env: { QIALIKE_DESKTOP_USER_DATA_DIR: '/tmp/isolated' } }))
      .toBe(resolve('/tmp/isolated'))
  })
})

describe('the protocol generation', () => {
  it('is a positive integer', () => {
    expect(Number.isSafeInteger(HOST_PROTOCOL_VERSION)).toBe(true)
    expect(HOST_PROTOCOL_VERSION).toBeGreaterThan(0)
  })

  it('matches the one the preload reports to the renderer', () => {
    // A source-text check, because the preload is hand-written CommonJS that
    // cannot import this constant — a sandboxed preload resolves only
    // `electron`, `events`, `timers` and `url`. The duplication is deliberate;
    // letting the two drift is not, and nothing else would notice.
    const preload = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'preload', 'preload.cjs'), 'utf8')
    const declared = /const PROTOCOL_VERSION = (\d+)/u.exec(preload)
    expect(declared, 'the preload declares no PROTOCOL_VERSION').not.toBeNull()
    expect(Number(declared[1])).toBe(HOST_PROTOCOL_VERSION)
  })

  it('installs its bridge only on the product document', () => {
    // The shell's own pages get no bridge: their job is to render when the rest
    // of the application cannot, and a bridge would be a second surface for no
    // benefit.
    const preload = readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'preload', 'preload.cjs'), 'utf8')
    expect(preload).toContain("location.hostname === 'app'")
    // And it must not hand out the raw IPC object.
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*\)/)
  })
})
