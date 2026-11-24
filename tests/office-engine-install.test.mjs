/**
 * Fetching, verifying and unpacking the LibreOffice engine.
 *
 * WHY THIS SUITE IS MOSTLY ABOUT REFUSALS. Two things here can hurt a user, and neither is the
 * happy path. The first is an archive that writes outside the directory it was unpacked into: the
 * digest proves the bytes are the ones the registry published, which says nothing about whether the
 * published package is benign, so the containment checks are the actual defence and are tested from
 * four directions. The second is a half-finished install: 145 MiB of engine that is there and
 * unusable, or an upgrade that failed and took the working copy with it.
 *
 * HOW THE FIXTURES ARE BUILT. Archives come from the system `tar`, in all three of the formats that
 * extend a file name past the 100-byte header field — because those are three different code paths
 * (`ustar` prefix, pax `x`, GNU `L`) and testing one would leave the other two unexercised. The
 * escaping archives cannot come from `tar`, which refuses to write them, so they are assembled from
 * raw headers: that is also how the pax-global and unsupported-typeflag cases are reached.
 *
 * NOTHING HERE TOUCHES THE NETWORK except a server on loopback, so the suite cannot fail because a
 * registry is having a bad day, and cannot quietly pass because it downloaded something different
 * from what it was written against.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENGINE_PREFIX,
  engineInstallRoot,
  enginePackageCandidates,
  enginePackageDir,
  enginePackageName,
  bareName,
  bundledEngineVersion,
  engineSearchDir,
  engineSearchPath,
  engineTarget,
  engineVersion,
  extractTarGz,
  installEngine,
  integrityOf,
  readInstalledVersion,
  resolveEngineSource,
  stripPackagePrefix,
  tarballUrl,
  verifyIntegrity,
  writeEntries,
} from '../packages/qialike-desktop-office-engine/lib/install.js'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-engine-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file, creating its directory. */
function place(path, body = 'x') {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

/** A raw 512-byte tar header, for the archives `tar` will not write. */
function rawHeader({ name, size = 0, type = '0', link = '', prefix = '', mode = 0o644 }) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8)
  block.write('0000000\0', 108, 8)
  block.write('0000000\0', 116, 8)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  block.write('00000000000\0', 136, 12)
  block.write('        ', 148, 8)
  block.write(type, 156, 1)
  if (link !== '') block.write(link, 157, 100, 'utf8')
  block.write('ustar\0', 257, 6)
  block.write('00', 263, 2)
  if (prefix !== '') block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return block
}

/** Assemble a tar from raw entries and gzip it. */
function rawTarGz(entries) {
  const parts = []
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0)
    parts.push(rawHeader({ ...entry, size: body.length }))
    if (body.length > 0) {
      parts.push(body)
      parts.push(Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length))
    }
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** The SRI string for a buffer, as a registry would publish it. */
const sri = (buffer) => `sha512-${createHash('sha512').update(buffer).digest('base64')}`

describe('which engine a host gets', () => {
  it('follows the kit: darwin and win32 by platform and arch, linux only with glibc', () => {
    // The kit's own `platformTarget`. Mirroring it is what keeps this from promising an engine the
    // kit will not look for.
    expect(engineTarget('linux', 'x64', { glibc: true })).toBe('linux-x64-glibc')
    expect(engineTarget('linux', 'arm64', { glibc: true })).toBe('linux-arm64-glibc')
    expect(engineTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(engineTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(engineTarget('win32', 'x64')).toBe('win32-x64')
    expect(engineTarget('win32', 'arm64')).toBe('win32-arm64')
  })

  it('has no native engine for musl linux or for an unsupported arch', () => {
    expect(engineTarget('linux', 'x64', { glibc: false })).toBeUndefined()
    expect(engineTarget('win32', 'ia32')).toBeUndefined()
    expect(engineTarget('freebsd', 'x64')).toBeUndefined()
  })

  it('falls back to WebAssembly on Linux, because that is where the kit falls back', () => {
    // musl Linux has no native package, and the kit continues to the wasm engine when
    // `platform === 'linux'`. Installing the wasm package anywhere else would be 145 MiB of
    // download for a file the kit never opens.
    expect(enginePackageName('linux', 'x64', { glibc: false })).toBe(`${ENGINE_PREFIX}wasm`)
    expect(enginePackageName('linux', 'x64', { glibc: true })).toBe(`${ENGINE_PREFIX}linux-x64-glibc`)
  })

  it('offers the wasm engine as Linux’s fallback, and only Linux’s', () => {
    // A DECLARED TARGET IS NOT A PUBLISHED PACKAGE. The kit's target table names
    // `linux-x64-glibc`, and measured, that package answers 404 on both registries — so a caller
    // that took the preferred name and tried to install it would fail on a host the kit serves
    // perfectly well through WebAssembly. The list is a preference order, not an answer.
    expect(enginePackageCandidates('linux', 'x64', { glibc: true }).map((entry) => entry.target))
      .toEqual(['linux-x64-glibc', 'wasm'])
    expect(enginePackageCandidates('linux', 'x64', { glibc: false }).map((entry) => entry.target))
      .toEqual(['wasm'])
    // Off Linux the kit never looks at the wasm engine, so offering it would be 145 MiB of download
    // for a file nothing opens.
    expect(enginePackageCandidates('win32', 'x64').map((entry) => entry.target)).toEqual(['win32-x64'])
    expect(enginePackageCandidates('darwin', 'arm64').map((entry) => entry.target)).toEqual(['darwin-arm64'])
  })

  it('refuses rather than naming an engine that cannot exist', () => {
    // A caller that got a name back would go on to download it. There is no wasm fallback off
    // Linux, so the honest answer is a refusal that names the host.
    expect(() => enginePackageName('win32', 'ia32')).toThrow(/no LibreOffice engine exists for win32-ia32/u)
    expect(() => enginePackageName('freebsd', 'x64')).toThrow(/no LibreOffice engine/u)
    expect(() => enginePackageCandidates('freebsd', 'x64')).toThrow(/no LibreOffice engine/u)
  })

  it('reads the engine version out of the kit rather than assuming one', () => {
    // The kit refuses an engine whose version differs from its own table, and that table is not a
    // public API — so it is parsed, and an unparsable file is a failure rather than a default.
    const kit = join(root, 'kit')
    mkdirSync(join(kit, 'lib'), { recursive: true })
    writeFileSync(join(kit, 'lib', 'index.js'), 'const ENGINE_VERSION = "9.9.9";\n')
    expect(engineVersion(kit)).toBe('9.9.9')
    writeFileSync(join(kit, 'lib', 'index.js'), 'const SOMETHING_ELSE = 1;\n')
    expect(() => engineVersion(kit)).toThrow(/read no ENGINE_VERSION/u)
  })
})

describe('registry URLs and digests', () => {
  it('builds the tarball URL both registries actually serve', () => {
    // Measured: the scope stays literal in the path and the file name is the unscoped one.
    expect(tarballUrl('https://registry.npmmirror.com', ENGINE_PREFIX + 'wasm', '0.1.5'))
      .toBe('https://registry.npmmirror.com/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.5.tgz')
    expect(tarballUrl('https://example.test/', 'plain', '1.0.0'))
      .toBe('https://example.test/plain/-/plain-1.0.0.tgz')
  })

  it('refuses metadata that cannot vouch for the bytes', () => {
    // The digest is the only thing between a download and 145 MiB of executable content on a
    // user's disk. Metadata without one is uninstallable, not installable-without-verification.
    expect(integrityOf({ versions: { '1.0.0': { dist: { integrity: 'sha512-AAA' } } } }, '1.0.0'))
      .toBe('sha512-AAA')
    expect(() => integrityOf({ versions: {} }, '1.0.0')).toThrow(/no version/u)
    expect(() => integrityOf({ versions: { '1.0.0': { dist: {} } } }, '1.0.0')).toThrow(/no dist\.integrity/u)
  })

  it('checks sha512 and only sha512', () => {
    const body = Buffer.from('the bytes\n')
    expect(verifyIntegrity(body, sri(body))).toBe(true)
    expect(verifyIntegrity(Buffer.from('other bytes\n'), sri(body))).toBe(false)
    // A weaker algorithm would quietly lower the guarantee this check exists to give.
    expect(() => verifyIntegrity(body, 'sha1-abc')).toThrow(/not a sha512/u)
    expect(() => verifyIntegrity(body, 'nonsense')).toThrow(/not a sha512/u)
  })
})

describe('reading tar archives', () => {
  /** A small tree, including a path long enough to need one of the name extensions. */
  function buildTree() {
    const dir = join(root, 'tree')
    const long = join(dir, 'package', 'a'.repeat(60), 'b'.repeat(60), 'deep.txt')
    mkdirSync(join(long, '..'), { recursive: true })
    writeFileSync(long, 'deep\n')
    mkdirSync(join(dir, 'package', 'nested'), { recursive: true })
    writeFileSync(join(dir, 'package', 'nested', 'file.txt'), 'hello\n')
    const script = join(dir, 'package', 'run.sh')
    writeFileSync(script, '#!/bin/sh\n')
    execFileSync('chmod', ['755', script])
    symlinkSync('nested/file.txt', join(dir, 'package', 'link.txt'))
    return dir
  }

  /** Create an archive with the system tar, which is how a real one is made. */
  function tarIt(dir, format) {
    const out = join(root, `f-${format}.tgz`)
    execFileSync('tar', [`--format=${format}`, '-czf', out, '-C', dir, 'package'])
    return readFileSync(out)
  }

  it('reads every entry name the way tar does, in all three long-name formats', () => {
    // These are three separate code paths — the ustar `prefix` field, pax `x` records, and GNU `L`
    // headers — and the real wasm tarball's longest path is 92 bytes, so none of them is exercised
    // by the artifact we happen to ship today. A future release with a deeper path would hit them.
    const dir = buildTree()
    for (const format of ['ustar', 'pax', 'gnu']) {
      const archive = tarIt(dir, format)
      // Every entry, not only the regular files: comparing files alone would leave a dropped
      // directory or symlink invisible, and tar's own listing already names them all.
      const mine = extractTarGz(archive).map((entry) => entry.path).sort()
      const theirs = execFileSync('tar', ['-tzf', '-'], { input: archive })
        .toString('utf8').trim().split('\n').map((line) => line.replace(/\/$/u, '')).sort()
      expect(mine, `format ${format}`).toEqual(theirs)
      expect(mine.some((path) => path.includes('a'.repeat(60))), `format ${format}`).toBe(true)
    }
  })

  it('reproduces the bytes and the mode tar reports', () => {
    const dir = buildTree()
    const entries = extractTarGz(tarIt(dir, 'ustar'))
    const out = join(root, 'out')
    writeEntries(entries, out)
    expect(readFileSync(join(out, 'package', 'nested', 'file.txt'), 'utf8')).toBe('hello\n')
    const script = join(out, 'package', 'run.sh')
    expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\n')
    // The executable bit is how the engine's launcher works on macOS and Windows-on-ARM trees.
    expect(execFileSync('stat', ['-c', '%a', script]).toString('utf8').trim()).toBe('755')
    // A symlink stays a symlink rather than becoming a copy of its target.
    expect(execFileSync('stat', ['-c', '%F', join(out, 'package', 'link.txt')]).toString('utf8').trim())
      .toBe('symbolic link')
  })

  it('refuses an entry that escapes the root, and writes nothing outside it', () => {
    // The tar equivalent of zip-slip. An SRI digest proves the bytes are the ones the registry
    // published — not that the published package is benign.
    const escape = join(root, 'escaped.txt')
    for (const name of ['../escaped.txt', '../../escaped.txt', '/tmp/escaped.txt', 'package/../../escaped.txt']) {
      const archive = rawTarGz([{ name, body: Buffer.from('owned\n') }])
      expect(() => extractTarGz(archive), name).toThrow(/absolute path|escapes the extraction root/u)
    }
    expect(existsSync(escape)).toBe(false)
  })

  it('refuses a symlink that points outside, including one that escapes from a nested entry', () => {
    expect(() => extractTarGz(rawTarGz([{ name: 'package/evil', type: '2', link: '../../outside' }])))
      .toThrow(/escapes the extraction root/u)
    expect(() => extractTarGz(rawTarGz([{ name: 'package/evil', type: '2', link: '/etc/passwd' }])))
      .toThrow(/absolute path/u)
    // A link that stays inside its own directory is legitimate and must not be refused.
    const ok = extractTarGz(rawTarGz([{ name: 'package/sub/link', type: '2', link: 'sibling' }]))
    expect(ok[0]).toMatchObject({ kind: 'symlink', link: 'sibling' })
  })

  it('refuses a global pax header instead of reading the archive as if it were not there', () => {
    // A global header changes how every later entry is read. Ignoring it would extract the archive
    // as though it were written differently than it is.
    const archive = rawTarGz([{ name: 'pax_global_header', type: 'g', body: Buffer.from('12 comment=x\n') }])
    expect(() => extractTarGz(archive)).toThrow(/global pax header/u)
  })

  it('refuses an entry type it does not implement', () => {
    // A character device or a FIFO appearing in a package archive is not something to skip past.
    expect(() => extractTarGz(rawTarGz([{ name: 'package/dev', type: '3' }])))
      .toThrow(/unsupported type/u)
  })

  it('notices a corrupt header rather than extracting the wrong bytes', () => {
    const archive = rawTarGz([{ name: 'package/a.txt', body: Buffer.from('a\n') }])
    const plain = gunzipSync(archive)
    plain[0] = plain[0] ^ 0xff
    const damaged = gzipSync(plain)
    expect(() => extractTarGz(damaged)).toThrow(/corrupt/u)
  })
})

describe('the npm package wrapper', () => {
  it('strips exactly one leading package/ segment', () => {
    // npm wraps every tarball in one level. Removing every matching prefix would flatten a member
    // genuinely named `package/x` into `x`.
    const stripped = stripPackagePrefix([
      { kind: 'file', path: 'package/index.js' },
      { kind: 'file', path: 'package/package/inner.txt' },
      { kind: 'file', path: 'other.txt' },
    ])
    expect(stripped.map((entry) => entry.path)).toEqual(['index.js', 'package/inner.txt'])
  })
})

describe('installing an engine', () => {
  /** Serve one package over loopback, counting the requests that arrive. */
  async function registry(tarball, { metadata } = {}) {
    const requests = []
    const server = createServer((request, response) => {
      requests.push(request.url)
      if (request.url === `/${ENGINE_PREFIX}wasm`) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(metadata ?? {
          versions: { '0.1.5': { dist: { integrity: sri(tarball) } } },
        }))
        return
      }
      if (request.url.endsWith('.tgz')) {
        response.end(tarball)
        return
      }
      response.statusCode = 404
      response.end('no')
    })
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    return {
      base: `http://127.0.0.1:${String(server.address().port)}`,
      requests,
      close: () => new Promise((resolve) => { server.close(resolve) }),
    }
  }

  /** A tarball holding one engine, as npm would publish it. */
  function engineTarball(version = '0.1.5') {
    const dir = join(root, `src-${version}`)
    mkdirSync(join(dir, 'package', 'assets'), { recursive: true })
    writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: `${ENGINE_PREFIX}wasm`, version }))
    writeFileSync(join(dir, 'package', 'assets', 'engine.bin'), 'engine\n')
    const out = join(root, `engine-${version}.tgz`)
    execFileSync('tar', ['--format=ustar', '-czf', out, '-C', dir, 'package'])
    return readFileSync(out)
  }

  const install = (base, extra = {}) => installEngine({
    platform: 'linux',
    arch: 'x64',
    glibc: false,
    version: '0.1.5',
    home: join(root, 'home'),
    registry: base,
    ...extra,
  })

  it('downloads, verifies and unpacks, with the wrapper stripped', async () => {
    const tarball = engineTarball()
    const server = await registry(tarball)
    try {
      const result = await install(server.base)
      const pkg = join(root, 'home', 'engines', 'libreoffice-kit', '0.1.5', 'wasm', 'node_modules', ENGINE_PREFIX + 'wasm')
      expect(result.files).toBe(2)
      expect(readFileSync(join(pkg, 'assets', 'engine.bin'), 'utf8')).toBe('engine\n')
      expect(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version).toBe('0.1.5')
      expect(readInstalledVersion(pkg)).toBe('0.1.5')
    } finally {
      await server.close()
    }
  })

  it('reports the phases of an install, and a byte count that ends at the download size', async () => {
    // The interface is the only caller that cares, and a 46 MiB download with nothing to show for a
    // minute reads as a button that did nothing. `total` is asserted here because the local server
    // sends `content-length`; a server that does not must leave it undefined rather than guessed.
    const tarball = engineTarball()
    const server = await registry(tarball)
    const seen = []
    try {
      await install(server.base, { onProgress: (update) => seen.push(update) })
      const phases = [...new Set(seen.map((update) => update.phase))]
      expect(phases).toEqual(['resolving', 'downloading', 'verifying', 'unpacking', 'done'])
      const download = seen.filter((update) => update.phase === 'downloading')
      expect(download.at(-1).received).toBe(tarball.length)
      expect(download.at(-1).total).toBe(tarball.length)
      // Strictly increasing, so the caller cannot be shown a bar that goes backwards.
      for (let index = 1; index < download.length; index += 1) {
        expect(download[index].received).toBeGreaterThanOrEqual(download[index - 1].received)
      }
    } finally {
      await server.close()
    }
  })

  it('does not re-download an engine that is already there', async () => {
    // Re-fetching 46-68 MiB to replace a working copy is the one outcome a user would notice, and
    // this is the check that stops a retry from doing it.
    const tarball = engineTarball()
    const server = await registry(tarball)
    try {
      await install(server.base)
      const before = server.requests.length
      const second = await install(server.base)
      expect(second.alreadyInstalled).toBe(true)
      expect(server.requests.length).toBe(before)
    } finally {
      await server.close()
    }
  })

  it('refuses a tarball whose digest disagrees, and writes nothing', async () => {
    const tarball = engineTarball()
    const server = await registry(tarball, {
      metadata: { versions: { '0.1.5': { dist: { integrity: sri(Buffer.from('something else')) } } } },
    })
    try {
      await expect(install(server.base)).rejects.toThrow(/does not match the published digest/u)
      const engines = join(root, 'home', 'engines')
      // Nothing at the destination, and no staging directory left behind on the way out.
      expect(existsSync(join(engines, 'libreoffice-kit', '0.1.5', 'wasm', 'node_modules'))).toBe(false)
      const leftovers = existsSync(engines)
        ? readdirSync(engines, { recursive: true }).filter((name) => String(name).includes('.staging-'))
        : []
      expect(leftovers).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('leaves an existing install untouched when the download fails', async () => {
    // The path is version-keyed, so a directory here that holds a different version is one this
    // code did not put there. A failed install must not take it with it.
    const destination = enginePackageDir(engineInstallRoot(join(root, 'home'), '0.1.5', 'wasm'), `${ENGINE_PREFIX}wasm`)
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: `${ENGINE_PREFIX}wasm`, version: '0.0.0' }))
    const tarball = engineTarball()
    const server = await registry(tarball, {
      metadata: { versions: { '0.1.5': { dist: { integrity: sri(Buffer.from('wrong')) } } } },
    })
    try {
      await expect(install(server.base)).rejects.toThrow(/does not match/u)
      expect(readInstalledVersion(destination)).toBe('0.0.0')
    } finally {
      await server.close()
    }
  })

  it('reinstalls over an incomplete directory instead of failing forever', async () => {
    // A directory left by an interrupted swap has no readable manifest. Deciding the move-aside by
    // `readInstalledVersion` would skip it and then fail on the rename, because renaming onto an
    // existing non-empty directory is refused — a reinstall that could never succeed.
    const destination = enginePackageDir(engineInstallRoot(join(root, 'home'), '0.1.5', 'wasm'), `${ENGINE_PREFIX}wasm`)
    mkdirSync(join(destination, 'assets'), { recursive: true })
    writeFileSync(join(destination, 'assets', 'stale.bin'), 'stale')
    const tarball = engineTarball()
    const server = await registry(tarball)
    try {
      const result = await install(server.base)
      expect(result.files).toBe(2)
      expect(readInstalledVersion(destination)).toBe('0.1.5')
      expect(existsSync(join(destination, 'assets', 'stale.bin'))).toBe(false)
      // The copy moved aside is removed, so a reinstall does not double the disk cost.
      const siblings = readdirSync(join(root, 'home', 'engines', 'libreoffice-kit', '0.1.5', 'wasm'))
      expect(siblings.filter((name) => name.includes('.replaced-'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('stops on an aborted signal and leaves no half-install', async () => {
    const tarball = engineTarball()
    const server = await registry(tarball)
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(install(server.base, { signal: controller.signal })).rejects.toThrow()
      expect(existsSync(join(root, 'home', 'engines', 'libreoffice-kit', '0.1.5', 'wasm', 'node_modules'))).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('raises a non-2xx answer instead of installing whatever came back', async () => {
    // The wording moved when resolution moved into the library: a candidate the registry does not
    // have is now one entry in the list of everything that was tried. What the assertion is about is
    // unchanged — metadata with no usable version installs nothing.
    const server = await registry(engineTarball(), { metadata: { versions: {} } })
    try {
      await expect(install(server.base)).rejects.toThrow(/no version 0\.1\.5/u)
    } finally {
      await server.close()
    }
  })
})

describe('resolving which engine to fetch', () => {
  /** A registry whose answers are scripted per package name. */
  function scripted(answers, calls) {
    return async (url) => {
      calls.push(url)
      const name = /libreoffice-kit-[a-z0-9.-]+/u.exec(url)?.[0]
      const answer = answers[name]
      if (answer === undefined) return { ok: false, status: 404 }
      return {
        ok: true,
        json: async () => ({ versions: { '0.1.5': { dist: { integrity: 'sha512-AAA', ...answer } } } }),
      }
    }
  }

  it('walks past a preferred engine that was never published', async () => {
    // MEASURED AGAINST THE REAL REGISTRIES: on Linux with glibc the kit prefers
    // `libreoffice-kit-linux-x64-glibc`, and that package answers 404 on both. So the first
    // candidate is a preference rather than an answer, and a caller that took it at face value
    // would fail on a host the kit serves perfectly well through WebAssembly.
    const calls = []
    const resolved = await resolveEngineSource({
      platform: 'linux',
      arch: 'x64',
      glibc: true,
      version: '0.1.5',
      fetchImpl: scripted({ 'libreoffice-kit-wasm': { size: 48080284 } }, calls),
    })
    expect(resolved.candidate.target).toBe('wasm')
    // Both candidates were tried on the first registry before the second registry was consulted:
    // the candidate order encodes a preference about engines, and an unreachable registry must not
    // silently downgrade it.
    expect(calls.map((url) => `${url.includes('npmjs') ? 'npmjs' : 'mirror'}:${/libreoffice-kit-[a-z0-9.-]+/u.exec(url)[0]}`))
      .toEqual([
        'mirror:libreoffice-kit-linux-x64-glibc',
        'npmjs:libreoffice-kit-linux-x64-glibc',
        'mirror:libreoffice-kit-wasm',
      ])
  })

  it('falls back to the second registry when the first cannot be reached', async () => {
    const calls = []
    const resolved = await resolveEngineSource({
      platform: 'win32',
      arch: 'x64',
      version: '0.1.5',
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.includes('npmmirror')) throw new Error('simulated network failure')
        return { ok: true, json: async () => ({ versions: { '0.1.5': { dist: { integrity: 'sha512-AAA', size: 1 } } } }) }
      },
    })
    expect(resolved.registry).toContain('npmjs')
    expect(resolved.candidate.target).toBe('win32-x64')
    expect(calls).toHaveLength(2)
  })

  it('skips a registry that cannot vouch for the bytes', async () => {
    // Metadata without a digest is unusable, and it is skipped like any other unusable source rather
    // than failing after a caller has committed to it. The digest is the only thing between a
    // download and 145 MiB of executable content on a user's disk.
    const resolved = await resolveEngineSource({
      platform: 'win32',
      arch: 'x64',
      version: '0.1.5',
      fetchImpl: async (url) => (url.includes('npmmirror')
        ? { ok: true, json: async () => ({ versions: { '0.1.5': { dist: {} } } }) }
        : { ok: true, json: async () => ({ versions: { '0.1.5': { dist: { integrity: 'sha512-BBB' } } } }) }),
    })
    expect(resolved.registry).toContain('npmjs')
    expect(resolved.integrity).toBe('sha512-BBB')
  })

  it('refuses, naming every attempt, when no registry publishes one', async () => {
    await expect(resolveEngineSource({
      platform: 'win32',
      arch: 'x64',
      version: '0.1.5',
      fetchImpl: async () => ({ ok: false, status: 404 }),
    })).rejects.toThrow(/no registry publishes an engine for win32-x64/u)
  })

  it('is what installEngine uses when the caller has not planned', async () => {
    // THE BUG THIS PREVENTS, AND IT WAS LIVE: `installEngine` called with only `home` and `version`
    // took the host's PREFERRED candidate, which on Linux is unpublished, and threw a 404. The row
    // plans and passes an explicit choice, so the interface never showed it — which is exactly why
    // the resolution lives in the library now.
    const calls = []
    const home = join(root, 'home')
    const tarball = (() => {
      const dir = join(root, 'src-resolve')
      mkdirSync(join(dir, 'package', 'assets'), { recursive: true })
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: `${ENGINE_PREFIX}wasm`, version: '0.1.5' }))
      writeFileSync(join(dir, 'package', 'assets', 'engine.bin'), 'engine\n')
      const out = join(root, 'resolve.tgz')
      execFileSync('tar', ['--format=ustar', '-czf', out, '-C', dir, 'package'])
      return readFileSync(out)
    })()
    const body = tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)
    const fetchImpl = async (url) => {
      calls.push(url)
      if (/libreoffice-kit-linux-x64-glibc/u.test(url)) return { ok: false, status: 404 }
      if (url.endsWith('.tgz')) return { ok: true, arrayBuffer: async () => body }
      const metadata = JSON.stringify({ versions: { '0.1.5': { dist: { integrity: sri(tarball), size: tarball.length } } } })
      // Both shapes: the resolver reads `json()`, and the installer's digest fallback reads bytes.
      return { ok: true, json: async () => JSON.parse(metadata), arrayBuffer: async () => new TextEncoder().encode(metadata).buffer }
    }
    const result = await installEngine({
      platform: 'linux',
      arch: 'x64',
      glibc: true,
      version: '0.1.5',
      home,
      fetchImpl,
    })
    expect(result.target).toBe('wasm')
    expect(result.name).toBe(`${ENGINE_PREFIX}wasm`)
    expect(readInstalledVersion(enginePackageDir(result.root, result.name))).toBe('0.1.5')
    expect(calls.some((url) => url.includes('linux-x64-glibc'))).toBe(true)
  })
})

describe('telling a bundled engine from an installed one', () => {
  /** A tree with the adapter and, optionally, an engine beside it. */
  function tree({ engines = [] } = {}) {
    const nodeModules = join(root, 'node_modules', '@deepseek-ai')
    mkdirSync(join(nodeModules, 'libreoffice-kit', 'lib'), { recursive: true })
    writeFileSync(join(nodeModules, 'libreoffice-kit', 'package.json'), JSON.stringify({ name: 'libreoffice-kit' }))
    for (const [name, version] of engines) {
      mkdirSync(join(nodeModules, name), { recursive: true })
      writeFileSync(join(nodeModules, name, 'package.json'), JSON.stringify({ name, version }))
    }
    return join(nodeModules, 'libreoffice-kit')
  }

  it('finds an engine that sits beside the adapter', () => {
    // The path is `dirname(adapter)/<bare name>`, because the directory above the adapter is already
    // the scope. Joining the FULL scoped name gives `@deepseek-ai/@deepseek-ai/...`, which never
    // exists — and the consequence was not a crash: a bundled tree reported `missing`, so the
    // interface offered to install an engine that was already there.
    const kit = tree({ engines: [[`libreoffice-kit-wasm`, '0.1.5']] })
    expect(bundledEngineVersion(kit, `${ENGINE_PREFIX}wasm`)).toBe('0.1.5')
    expect(bareName(`${ENGINE_PREFIX}wasm`)).toBe('libreoffice-kit-wasm')
  })

  it('reports nothing when the tree carries no engine', () => {
    // A pruned tree: the adapter is there and no engine is, which is the state the row has to
    // describe as `missing` so the interface offers the install.
    const kit = tree()
    expect(bundledEngineVersion(kit, `${ENGINE_PREFIX}wasm`)).toBeUndefined()
    expect(bundledEngineVersion(kit, `${ENGINE_PREFIX}linux-x64-glibc`)).toBeUndefined()
  })

  it('does not read an engine that is only installed elsewhere', () => {
    // The distinction that makes this a sibling lookup rather than a resolution: an engine under a
    // different root must not be reported as bundled, or the row would wire nothing and report
    // `bundled` while the kit cannot find an engine at all.
    const kit = tree()
    const elsewhere = join(root, 'engines', 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: `${ENGINE_PREFIX}wasm`, version: '0.1.5' }))
    expect(bundledEngineVersion(kit, `${ENGINE_PREFIX}wasm`)).toBeUndefined()
  })

  it('handles an unscoped name, because the helper is about the slash and not the scope', () => {
    expect(bareName('plain')).toBe('plain')
  })
})

describe('the search path the shell hands to the host', () => {
  it('names each target’s node_modules, because that is what an entry means', () => {
    // THE DISTINCTION THAT COST A ROUND OF DEBUGGING. A `NODE_PATH` entry is searched as though it
    // were a `node_modules` directory — Node looks for `<entry>/<package>` — so the entry has to be
    // the `node_modules` inside the install root and not the root itself. Pointing at the root
    // resolves nothing, silently, while the install reports success and the row reports `wired`.
    //
    // Version-keyed too, because the kit refuses an engine whose version differs from its own table:
    // an upgrade then reads as "not installed", which the interface can offer to fix, rather than as
    // an incompatible manifest, which it cannot.
    const paths = engineSearchPath('/home/u/.dsh', '0.1.5', ['linux-x64-glibc', 'wasm'])
    expect(paths).toEqual([
      '/home/u/.dsh/engines/libreoffice-kit/0.1.5/linux-x64-glibc/node_modules',
      '/home/u/.dsh/engines/libreoffice-kit/0.1.5/wasm/node_modules',
    ])
  })

  it('resolves through that entry, which is the only reason the shape matters', async () => {
    // The same claim as a behaviour rather than a string: a package under
    // `<root>/node_modules/<name>` is found when `<root>/node_modules` is the entry, and is NOT
    // found when `<root>` is. Node builds its global path list at bootstrap, so the variable alone
    // is not enough — `_initPaths` is the second half, and the wiring lock in
    // `tests/office-engine-wiring.test.mjs` covers that half.
    const { engineSearchDir, engineInstallRoot, enginePackageDir } = await import(
      '../packages/qialike-desktop-office-engine/lib/install.js'
    )
    const home = join(root, 'home')
    const installRoot = engineInstallRoot(home, '0.1.5', 'wasm')
    const packageDir = enginePackageDir(installRoot, `${ENGINE_PREFIX}wasm`)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: `${ENGINE_PREFIX}wasm`, version: '0.1.5' }))

    expect(engineSearchDir(installRoot)).toBe(join(installRoot, 'node_modules'))
    const { createRequire } = await import('node:module')
    const probeFile = join(root, 'probe.mjs')
    writeFileSync(probeFile, [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      'export const resolve = (name) => {',
      '  try { return require.resolve(`${name}/package.json`) } catch { return null }',
      '}',
    ].join('\n'))
    const probe = await import(pathToFileURL(probeFile).href)

    const original = process.env.NODE_PATH
    try {
      process.env.NODE_PATH = installRoot
      createRequire(import.meta.url)('node:module')._initPaths()
      expect(probe.resolve(`${ENGINE_PREFIX}wasm`), 'the install root must not resolve').toBeNull()

      process.env.NODE_PATH = engineSearchDir(installRoot)
      createRequire(import.meta.url)('node:module')._initPaths()
      expect(probe.resolve(`${ENGINE_PREFIX}wasm`)).toBe(join(packageDir, 'package.json'))
    } finally {
      if (original === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = original
      createRequire(import.meta.url)('node:module')._initPaths()
    }
  })
})
