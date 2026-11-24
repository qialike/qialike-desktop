/**
 * Source routing: which release host the desktop updater talks to, and why.
 *
 * Nothing here touches the network. Routing reaches for `fetch`, so the transport
 * is a parameter and every test drives it directly — which is also how the
 * properties worth guarding become observable at all: that a source listing no
 * artifact for this platform is not a candidate, that a sample is *aborted* after
 * its window rather than streaming a 275 MB artifact, that an inconclusive
 * comparison leaves the configured host alone, and that no path through this
 * module ends up somewhere worse than the address the build already carried.
 *
 * The coordinator's half of it — that the choice is made exactly once per run, and
 * inside the first check rather than at startup — is guarded here too, because a
 * measurement that repeats on every poll is a bandwidth bug that looks like
 * nothing at all from the outside.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { UpdateCoordinator } from '../apps/desktop/src/update-coordinator.ts'
import {
  GITCODE_MANIFEST_HEADERS,
  MEASURE_BYTES, MEASURE_ENV,
  assetChoice, channelFileFor, compareVersions, manifestFiles, manifestVersion, measuringEnabled,
  measureThroughput, mirrorFor, newestByVersion, parseVersion, pickAsset, probeSource,
  requestHeadersFor, routeUpdateSource, updateSources,
} from '../apps/desktop/src/update-sources.ts'

const GITHUB = 'https://github.com/qialike/qialike-desktop/releases/latest/download'
const GITCODE = 'https://gitcode.com/qialike/qialike-desktop/releases/download/latest'

/** A manifest shaped like the one electron-builder writes. */
const LINUX_MANIFEST = [
  'version: 0.3.5',
  'files:',
  '  - url: qialike-desktop-linux-amd64.deb',
  '    sha512: AAAA',
  '    size: 209603608',
  '  - url: qialike-desktop-linux-x86_64.AppImage',
  '    sha512: BBBB',
  '    size: 275854494',
  '    blockMapSize: 287922',
  'path: qialike-desktop-linux-x86_64.AppImage',
  'sha512: BBBB',
  'releaseDate: 2026-10-14T03:19:49.266Z',
].join('\n')

/** A `Response` with a body, for a fake transport. */
function response(body, init = {}) {
  return new Response(body, { status: init.status ?? 200, ...(init.statusText === undefined ? {} : { statusText: init.statusText }) })
}

/**
 * A transport that answers each host from a table.
 *
 * Keys are full URLs; a value may be a `Response`, or a function returning one (so
 * a test can throw). Anything unlisted is a connection failure, which is what a
 * real fetch does for a host that cannot be reached.
 */
function fakeFetch(table, calls = []) {
  return async (url) => {
    calls.push(String(url))
    const entry = table[String(url)]
    if (entry === undefined) throw Object.assign(new Error('fetch failed'), { cause: new Error('ENOTFOUND') })
    return typeof entry === 'function' ? entry() : entry
  }
}

/** A body of `chunks` × `size` bytes that reports how much of it was pulled. */
function countedStream(chunks, size, state = {}) {
  state.produced = 0
  state.cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      if (state.produced >= chunks) {
        controller.close()
        return
      }
      state.produced += 1
      controller.enqueue(new Uint8Array(size))
    },
    cancel() { state.cancelled = true },
  })
  return { stream, state }
}

/** A clock that advances on every read, so a measurement has a nonzero duration. */
function steppingClock(stepMs = 100) {
  let value = 0
  return () => {
    value += stepMs
    return value
  }
}

describe('channelFileFor', () => {
  it('names the manifest the way electron-updater does', () => {
    // `Provider.getChannelFilePrefix()`: Linux carries an architecture suffix that
    // is absent for x64, macOS is `-mac`, and Windows has no suffix at all.
    expect(channelFileFor('linux', 'x64')).toBe('latest-linux.yml')
    expect(channelFileFor('linux', 'arm64')).toBe('latest-linux-arm64.yml')
    expect(channelFileFor('darwin', 'arm64')).toBe('latest-mac.yml')
    expect(channelFileFor('win32', 'x64')).toBe('latest.yml')
  })
})

describe('mirrorFor', () => {
  it('derives the GitCode mirror of a GitHub release directory', () => {
    expect(mirrorFor(GITHUB)?.base).toBe(GITCODE)
  })

  it('tolerates a trailing slash', () => {
    expect(mirrorFor(`${GITHUB}/`)?.base).toBe(GITCODE)
  })

  it('derives nothing from a base that is not a GitHub release directory', () => {
    // The anchor is the point: a fork's own server, a test feed and an internal
    // mirror must not be pointed at ours, and a version-pinned GitHub path is not
    // the "latest" alias that the mirror's shape corresponds to.
    expect(mirrorFor('https://updates.example/qialike')).toBeUndefined()
    expect(mirrorFor('https://github.com/qialike/qialike-desktop/releases/download/v0.3.5')).toBeUndefined()
    expect(mirrorFor('https://github.com/qialike/qialike-desktop/releases')).toBeUndefined()
    expect(mirrorFor('https://gitcode.com/qialike/qialike-desktop/releases/download/latest')).toBeUndefined()
  })

  it('never invents a mirror for a lookalike host', () => {
    // A host that merely *contains* the pattern must not match, or a hostile
    // lookalike URL would be treated as ours.
    expect(mirrorFor('https://evil.example/github.com/a/b/releases/latest/download')).toBeUndefined()
    expect(mirrorFor('https://github.com.evil.example/a/b/releases/latest/download')).toBeUndefined()
  })

  it('carries the header GitCode needs, and GitHub none', () => {
    // A HOST'S QUIRK BELONGS TO THE HOST. GitCode answers a manifest request that
    // carries a query string with 404, and `electron-updater` appends one unless
    // `requestHeaders` has a key named `private-token` or `authorization`. Attaching
    // that to the source means whoever wins the comparison brings it.
    expect(mirrorFor(GITHUB)?.requestHeaders).toEqual({ 'private-token': '' })
    expect(updateSources(GITHUB)[0]?.requestHeaders).toBeUndefined()
  })

  it('keeps the suppression header to a single key, with no value', () => {
    // The key is what counts — `electron-updater` never reads the value — and the
    // value is empty on purpose: nothing is being authenticated, and a real token
    // here would be a credential in a source file.
    const headers = GITCODE_MANIFEST_HEADERS
    expect(Object.keys(headers)).toEqual(['private-token'])
    expect(headers['private-token']).toBe('')
  })
})

describe('requestHeadersFor', () => {
  it('recognises the mirror wherever its URL came from', () => {
    // The requirement belongs to the host, not to how the URL was chosen: an override,
    // a packaged file and a routing decision all end up asking this one question.
    expect(requestHeadersFor(GITCODE)).toEqual({ 'private-token': '' })
    expect(requestHeadersFor('https://gitcode.com/a/b/releases/download/latest/')).toEqual({ 'private-token': '' })
    expect(requestHeadersFor('https://file-cdn.gitcode.com/a/b/x')).toEqual({ 'private-token': '' })
  })

  it('asks nothing extra of a host that does not need it', () => {
    expect(requestHeadersFor(GITHUB)).toBeUndefined()
    expect(requestHeadersFor('https://updates.example/qialike')).toBeUndefined()
    // Not a lookalike: the check is on the registrable name, not a substring.
    expect(requestHeadersFor('https://gitcode.com.evil.example/x')).toBeUndefined()
    expect(requestHeadersFor('https://notgitcode.com/x')).toBeUndefined()
  })

  it('says "no headers" for a value that is not a URL', () => {
    // The callers validate first; answering undefined here keeps a malformed value
    // from turning into a different failure than the one being diagnosed.
    expect(requestHeadersFor('not a url')).toBeUndefined()
  })

  it('labels a mirror configured directly as the mirror it is', () => {
    // A build pointed straight at GitCode is one source, so no routing happens — and
    // it still needs the header, which is why the source itself carries it.
    const sources = updateSources(GITCODE)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.id).toBe('gitcode')
    expect(sources[0]?.requestHeaders).toEqual({ 'private-token': '' })
  })
})

describe('the upstream contract this depends on', () => {
  /**
   * `electron-updater`'s own source, read rather than imported.
   *
   * Importing it needs Electron; reading it needs nothing, and what is being
   * asserted is only that two identifiers still appear where they must.
   */
  function appUpdaterSource() {
    const require = createRequire(import.meta.url)
    const resolved = require.resolve('electron-updater/out/AppUpdater.js', { paths: [join(ROOT, 'apps', 'desktop')] })
    return readFileSync(resolved, 'utf8')
  }

  it('still suppresses its cache-busting query for the header names we send', () => {
    // WHY THIS TEST EXISTS, AND WHY IT IS THIS SHAPE.
    //
    // The fix for GitCode rests on behaviour `electron-updater` marks `@internal`:
    // it appends `?noCache=<timestamp>` to the manifest URL unless `requestHeaders`
    // carries a key named `authorization` or `private-token`. If that changes, our
    // header stops doing anything, GitCode's manifest goes back to 404, and the
    // routing keeps choosing GitCode on speed while every check fails — silence,
    // which is the dangerous part.
    //
    // It reads the installed file instead of importing the module, because the
    // module needs Electron. That makes this an assertion about a specific
    // implementation rather than an interface, which is the honest description of
    // the dependency: there is no interface for "please do not add that query".
    const source = appUpdaterSource()
    // Sliced to the next member rather than matched with a brace-counting regex: the
    // getter contains nested blocks, so a pattern ending at the first `\n }` stops
    // inside the `if (headers == null)` guard and truncates away the very lines this
    // test is about. The first version of this test did exactly that — it extracted a
    // fragment, found neither header name, and failed for the wrong reason.
    const start = source.indexOf('get isAddNoCacheQuery')
    expect(start, 'isAddNoCacheQuery is gone from electron-updater, so nothing suppresses the query now')
      .toBeGreaterThan(-1)
    const rest = source.slice(start)
    const next = rest.search(/\n {4}(?:get |set |async |[\w$]+\s*\()/u)
    const getter = next < 0 ? rest : rest.slice(0, next)
    for (const name of Object.keys(GITCODE_MANIFEST_HEADERS)) {
      expect(getter, `isAddNoCacheQuery no longer tests for "${name}", so GitCode's manifest will 404`)
        .toContain(`"${name}"`)
    }
  })

  it('reads those headers from the updater before asking for the manifest', () => {
    // The other half of the dependency: the header has to reach the provider before
    // `getLatestVersion()` asks for the channel file, or it arrives too late to
    // change the URL. `setRequestHeaders(computeFinalHeaders(...))` is that handover.
    const source = appUpdaterSource()
    expect(source).toMatch(/setRequestHeaders\(\s*this\.computeFinalHeaders\(/u)
    expect(source).toContain('client.getLatestVersion()')
  })
})

describe('updateSources', () => {
  it('offers one source when no mirror can be derived', () => {
    expect(updateSources('https://updates.example/qialike')).toHaveLength(1)
  })

  it('offers the primary first and the mirror second', () => {
    const sources = updateSources(GITHUB)
    expect(sources.map((source) => source.base)).toEqual([GITHUB, GITCODE])
  })

  it('offers nothing when the build carries no address', () => {
    // Which is what keeps "a build with no update server stays inert" true.
    expect(updateSources(undefined)).toEqual([])
    expect(updateSources('   ')).toEqual([])
  })
})

describe('version ranking', () => {
  it('parses dotted versions, with a leading v and a pre-release suffix', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v0.3.5')).toEqual([0, 3, 5])
    expect(parseVersion('1.2.3-beta.1')).toEqual([1, 2, 3])
    expect(parseVersion(undefined)).toBeUndefined()
    expect(parseVersion('nightly')).toBeUndefined()
    expect(parseVersion('1.2.x')).toBeUndefined()
  })

  it('ranks numerically, not lexically', () => {
    // The bug this exists to prevent: a string comparison puts 0.9.0 above 0.10.0,
    // and acting on that ships a downgrade.
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0)
    expect(compareVersions([1, 0], [1, 0, 0])).toBe(0)
    expect(compareVersions([1, 0, 1], [1, 0, 0])).toBeGreaterThan(0)
  })
})

describe('manifest parsing', () => {
  it('reads the artifacts, with their declared sizes', () => {
    expect(manifestFiles(LINUX_MANIFEST)).toEqual([
      { url: 'qialike-desktop-linux-amd64.deb', size: 209603608 },
      { url: 'qialike-desktop-linux-x86_64.AppImage', size: 275854494 },
    ])
  })

  it('reads the version', () => {
    expect(manifestVersion(LINUX_MANIFEST)).toBe('0.3.5')
  })

  it('falls back to the deprecated top-level path when there are no files', () => {
    // electron-updater's own `getFileList` does this, so a manifest written by an
    // older electron-builder is still a usable answer.
    expect(manifestFiles('version: 0.1.0\npath: qialike-desktop-linux-x86_64.AppImage\n')).toEqual([
      { url: 'qialike-desktop-linux-x86_64.AppImage' },
    ])
  })

  it('does not mistake a nested key for an artifact', () => {
    // `size:` and `blockMapSize:` sit under a `- url:`; only the list entries are
    // artifacts, and the top-level `path:`/`sha512:` lines are not entries.
    const files = manifestFiles(LINUX_MANIFEST)
    expect(files).toHaveLength(2)
    expect(files.every((file) => !file.url.includes(':'))).toBe(true)
  })
})

describe('pickAsset', () => {
  const files = manifestFiles(LINUX_MANIFEST)

  it('picks the artifact this installation would actually download', () => {
    // An AppImage install fetches the AppImage; measuring the deb would measure a
    // file the user never receives.
    expect(pickAsset(files, assetChoice('linux', undefined), 'x64')?.url)
      .toBe('qialike-desktop-linux-x86_64.AppImage')
    expect(pickAsset(files, assetChoice('linux', 'deb'), 'x64')?.url)
      .toBe('qialike-desktop-linux-amd64.deb')
  })

  it('prefers the artifact naming this architecture, as far as that test can work', () => {
    // `findFile` in electron-updater prefers `url.includes(process.arch)`, and this
    // mirrors it — including the part that does not work: the x64 token in a real
    // artifact name is `x86_64`, which does **not** contain the substring `x64`
    // (`x` is followed by `8`). So the x64 preference never matches and the first
    // listed artifact wins, exactly as it does inside electron-updater. It is
    // recorded rather than "fixed" because the sample should be the artifact the
    // updater would actually download, and deviating here would measure a
    // different file than the one the user receives.
    const both = manifestFiles([
      'files:',
      '  - url: qialike-desktop-linux-arm64.AppImage',
      '  - url: qialike-desktop-linux-x86_64.AppImage',
    ].join('\n'))
    expect('qialike-desktop-linux-x86_64.AppImage'.includes('x64')).toBe(false)
    expect(pickAsset(both, assetChoice('linux'), 'x64')?.url).toBe('qialike-desktop-linux-arm64.AppImage')
    expect(pickAsset(both, assetChoice('linux'), 'arm64')?.url).toBe('qialike-desktop-linux-arm64.AppImage')
  })

  it('falls through to something it can use rather than calling the source dead', () => {
    // `findFile`'s last rule: when no preferred extension matched, take the first
    // artifact this platform was not told to refuse. A manifest naming an
    // unexpected format is still a manifest that can be served — and the sample it
    // yields measures the *host*, which is what the comparison is about.
    const odd = manifestFiles('files:\n  - url: qialike-desktop-linux-x86_64.tar.gz\n')
    expect(pickAsset(odd, assetChoice('linux', 'deb'))?.url).toBe('qialike-desktop-linux-x86_64.tar.gz')
  })

  it('reports nothing when every artifact is one this platform must refuse', () => {
    const foreign = manifestFiles([
      'files:',
      '  - url: qialike-desktop-linux-amd64.deb',
      '  - url: qialike-desktop-linux-x86_64.rpm',
    ].join('\n'))
    expect(pickAsset(foreign, assetChoice('linux'))).toBeUndefined()
  })

  it('reports nothing for a manifest that names no artifacts at all', () => {
    expect(pickAsset(manifestFiles('version: 0.3.5\n'), assetChoice('linux'))).toBeUndefined()
  })
})

describe('probeSource', () => {
  const options = (fetchFn) => ({ source: { id: 'github', label: 'github', base: GITHUB }, channel: 'latest-linux.yml', choice: assetChoice('linux'), arch: 'x64', fetchFn })

  it('reports the version and the artifact when the source can serve the release', async () => {
    const probe = await probeSource(options(fakeFetch({ [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST) })))
    expect(probe.usable).toBe(true)
    expect(probe.version).toBe('0.3.5')
    expect(probe.asset).toBe('qialike-desktop-linux-x86_64.AppImage')
  })

  it('is unusable when the manifest is absent', async () => {
    // A mirror that has not caught up answers 404; that is not a transport failure,
    // but it is equally not a source that can serve this release.
    const probe = await probeSource(options(fakeFetch({ [`${GITHUB}/latest-linux.yml`]: response('Not Found', { status: 404 }) })))
    expect(probe.usable).toBe(false)
    expect(probe.failure).toBe('http 404')
  })

  it('is unusable when the manifest names no artifact this platform can install', async () => {
    const body = 'files:\n  - url: qialike-desktop-linux-amd64.deb\n  - url: qialike-desktop-linux-x86_64.rpm\n'
    const probe = await probeSource(options(fakeFetch({ [`${GITHUB}/latest-linux.yml`]: response(body) })))
    expect(probe.usable).toBe(false)
    expect(probe.failure).toMatch(/no artifact/)
  })

  it('reports a transport failure without throwing, and keeps the cause', async () => {
    // `fetch` says only "fetch failed"; the useful part is in `cause`, and a log
    // line without it says nothing about DNS or TLS.
    const probe = await probeSource(options(fakeFetch({})))
    expect(probe.usable).toBe(false)
    expect(probe.failure).toContain('ENOTFOUND')
  })
})

describe('measureThroughput', () => {
  it('measures bytes per second over the sample window', async () => {
    const { stream } = countedStream(100, 65_536)
    const speed = await measureThroughput({
      url: `${GITHUB}/qialike-desktop-linux-x86_64.AppImage`,
      fetchFn: async () => new Response(stream, { status: 206 }),
      now: steppingClock(100),
    })
    // Four chunks fill the 256 KiB window over 100 ms.
    expect(speed).toBeCloseTo(MEASURE_BYTES / 0.1, -3)
  })

  it('stops reading once it has the window, rather than streaming the artifact', async () => {
    // The property that keeps a route decision from becoming a 275 MB download —
    // and it matters most for a host that ignores `Range` and sends the whole body.
    const { stream, state } = countedStream(200, 65_536)
    await measureThroughput({
      url: 'https://example.test/big.AppImage',
      fetchFn: async () => new Response(stream, { status: 206 }),
      now: steppingClock(10),
    })
    expect(state.produced).toBeLessThan(10)
    expect(state.cancelled).toBe(true)
  })

  it('treats a zero-byte answer as no measurement, not as a slow one', async () => {
    // Returning 0 would make a dead host merely slow, and it would then be pinned
    // whenever the other candidate also failed.
    const speed = await measureThroughput({
      url: 'https://example.test/empty.AppImage',
      fetchFn: async () => new Response(new ReadableStream({ start(controller) { controller.close() } }), { status: 206 }),
      now: steppingClock(),
    })
    expect(speed).toBeUndefined()
  })

  it('reports no measurement when the request fails', async () => {
    const speed = await measureThroughput({ url: 'https://example.test/x', fetchFn: async () => { throw new Error('boom') } })
    expect(speed).toBeUndefined()
  })

  it('reports no measurement for an error status', async () => {
    const speed = await measureThroughput({ url: 'https://example.test/x', fetchFn: async () => response('nope', { status: 404 }) })
    expect(speed).toBeUndefined()
  })
})

describe('routeUpdateSource', () => {
  /** Two usable manifests, with the artifacts the samples are taken from. */
  function bothServable(ghStatus = 200, gcStatus = 200) {
    return fakeFetch({
      [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST, { status: ghStatus }),
      [`${GITCODE}/latest-linux.yml`]: response(LINUX_MANIFEST, { status: gcStatus }),
    })
  }

  /** A transport where both hosts serve the same artifact body. */
  function servingFetch() {
    return fakeFetch({
      [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST),
      [`${GITCODE}/latest-linux.yml`]: response(LINUX_MANIFEST),
      [`${GITHUB}/qialike-desktop-linux-x86_64.AppImage`]: () => new Response(countedStream(4, 65_536).stream, { status: 206 }),
      [`${GITCODE}/qialike-desktop-linux-x86_64.AppImage`]: () => new Response(countedStream(4, 65_536).stream, { status: 206 }),
    })
  }

  /** A clock that returns scripted readings in order, so timing is exact. */
  function scriptedClock(readings) {
    let index = 0
    return () => readings[Math.min(index++, readings.length - 1)]
  }

  const base = { channel: 'latest-linux.yml', choice: assetChoice('linux'), arch: 'x64' }

  it('asks nothing at all when there is only one source', async () => {
    // The no-feed and non-GitHub cases: no request is made, so a fork or a
    // development run pays nothing for a feature it cannot use.
    const calls = []
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources('https://updates.example/qialike'),
      fetchFn: fakeFetch({}, calls),
    })
    expect(calls).toEqual([])
    expect(route.base).toBe('https://updates.example/qialike')
  })

  it('keeps the configured source when neither can serve the release', async () => {
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: fakeFetch({}, []),
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
    expect(route.speeds).toEqual([])
  })

  it('pins the only source that can serve it, without measuring', async () => {
    const calls = []
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: bothServable(404),
      log: () => {},
    })
    expect(route.base).toBe(GITCODE)
    expect(route.source?.id).toBe('gitcode')
    // Two manifest requests and nothing else: there is no comparison to make.
    expect(calls.filter((url) => url.endsWith('.AppImage'))).toEqual([])
  })

  it('pins the faster host when both can serve it', async () => {
    // The reader always takes the full sample window, so bytes are equal by
    // construction and only the *duration* can differ — which is exactly what a
    // real measurement sees. Scripting the clock makes the two durations exact:
    // GitHub takes 1000 ms for the window, GitCode 100 ms.
    const clock = scriptedClock([0, 1000, 1000, 1100])
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: servingFetch(),
      now: clock,
      log: () => {},
    })
    expect(route.base).toBe(GITCODE)
    expect(route.reason).toBe('the faster of two')
    expect(route.speeds.find((speed) => speed.id === 'gitcode')?.bytesPerSecond)
      .toBeGreaterThan(route.speeds.find((speed) => speed.id === 'github')?.bytesPerSecond ?? 0)
  })

  it('measures sequentially, so the two samples do not compete for one pipe', async () => {
    // Sampling both at once would let them share the bandwidth and flatten the very
    // difference the comparison exists to find.
    let inFlight = 0
    let maxInFlight = 0
    const inner = servingFetch()
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      now: steppingClock(50),
      log: () => {},
      fetchFn: async (url) => {
        if (String(url).endsWith('.AppImage')) {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            return await inner(url)
          } finally {
            inFlight -= 1
          }
        }
        return await inner(url)
      },
    })
    expect(route.base).toBe(GITHUB)
    expect(maxInFlight).toBe(1)
  })

  it('keeps the configured order when the comparison is inconclusive', async () => {
    // A tie must not swap hosts on noise, and the clock makes this an exact tie
    // rather than a hopeful one.
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: servingFetch(),
      now: scriptedClock([0, 500, 500, 1000]),
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
  })

  it('keeps GitHub when the mirror is the slower one', async () => {
    // The opposite direction, which matters just as much: the mirror must win on
    // measurement, not by being second in the list. Here GitCode takes 4000 ms for
    // the same window GitHub delivers in 200 ms.
    const clock = scriptedClock([0, 200, 200, 4200])
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: servingFetch(),
      now: clock,
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
    expect(route.source?.id).toBe('github')
  })

  it('pins the host that names the newest release, without measuring', async () => {
    // THE CASE A LIVE RUN FOUND: GitCode served 3.11.0 while GitHub served 3.12.0 for
    // the same repository. Choosing the faster host there would end updates silently,
    // because `allowDowngrade` is false — an older manifest reports "nothing
    // available" forever and nobody is told. So a lagging mirror drops out before any
    // measurement, which also means the comparison costs nothing in this case.
    const calls = []
    const behind = LINUX_MANIFEST.replace('version: 0.3.5', 'version: 0.3.4')
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: fakeFetch({
        [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST),
        [`${GITCODE}/latest-linux.yml`]: response(behind),
      }, calls),
      now: scriptedClock([0, 20, 20, 9000]),
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
    expect(route.source?.id).toBe('github')
    expect(route.reason).toContain('newest release')
    // Not one byte of either artifact was fetched, even though the clock would have
    // made the mirror look far slower.
    expect(calls.filter((url) => url.endsWith('.AppImage'))).toEqual([])
  })

  it('pins the mirror when the mirror is the one that is ahead', async () => {
    // The same rule in the other direction: freshness wins wherever it points, so a
    // GitHub whose CDN is serving a stale manifest does not keep the route.
    const ahead = LINUX_MANIFEST.replace('version: 0.3.5', 'version: 0.3.6')
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: fakeFetch({
        [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST),
        [`${GITCODE}/latest-linux.yml`]: response(ahead),
      }),
      now: scriptedClock([0, 9000, 9000, 9100]),
      log: () => {},
    })
    expect(route.base).toBe(GITCODE)
  })

  it('measures when neither manifest carries a rankable version', async () => {
    // No freshness information is not the same as being behind: with nothing to rank,
    // speed is the only question left, and answering it beats refusing to choose.
    const unversioned = LINUX_MANIFEST.replace('version: 0.3.5\n', '')
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: fakeFetch({
        [`${GITHUB}/latest-linux.yml`]: response(unversioned),
        [`${GITCODE}/latest-linux.yml`]: response(unversioned),
        [`${GITHUB}/qialike-desktop-linux-x86_64.AppImage`]: () => new Response(countedStream(4, 65_536).stream, { status: 206 }),
        [`${GITCODE}/qialike-desktop-linux-x86_64.AppImage`]: () => new Response(countedStream(4, 65_536).stream, { status: 206 }),
      }),
      now: scriptedClock([0, 1000, 1000, 1100]),
      log: () => {},
    })
    expect(route.base).toBe(GITCODE)
    expect(route.reason).toBe('the faster of two')
  })

  it('measures when both name the same version', async () => {
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: servingFetch(),
      now: scriptedClock([0, 1000, 1000, 1100]),
      log: () => {},
    })
    expect(route.base).toBe(GITCODE)
    expect(route.reason).toBe('the faster of two')
  })

  it('keeps the configured source when nothing could be measured', async () => {
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      fetchFn: bothServable(),
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
    expect(route.speeds.map((speed) => speed.bytesPerSecond)).toEqual([undefined, undefined])
  })

  it('makes no measurement at all when the comparison is refused', async () => {
    const calls = []
    const route = await routeUpdateSource({
      ...base,
      sources: updateSources(GITHUB),
      measure: false,
      fetchFn: fakeFetch({
        [`${GITHUB}/latest-linux.yml`]: response(LINUX_MANIFEST),
        [`${GITCODE}/latest-linux.yml`]: response(LINUX_MANIFEST),
      }, calls),
      log: () => {},
    })
    expect(route.base).toBe(GITHUB)
    expect(calls.filter((url) => url.endsWith('.AppImage'))).toEqual([])
  })

  it('refuses to route with no sources at all', async () => {
    // The caller is expected to have established that there is a feed; reaching
    // here with none is a programming error, not a state to paper over.
    await expect(routeUpdateSource({ ...base, sources: [], fetchFn: fakeFetch({}) })).rejects.toThrow(/at least one source/)
  })
})

describe('measuringEnabled', () => {
  it('is on unless the documented switch turns it off', () => {
    expect(measuringEnabled({})).toBe(true)
    expect(measuringEnabled({ [MEASURE_ENV]: '1' })).toBe(true)
    expect(measuringEnabled({ [MEASURE_ENV]: '0' })).toBe(false)
  })
})

describe('the coordinator’s use of the router', () => {
  /** A coordinator with inert timers and a counting router. */
  function harness(options = {}) {
    const calls = { check: 0, feedUrls: [], routes: 0 }
    const listeners = new Map()
    const updater = {
      currentVersion: { version: '0.3.5' },
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowDowngrade: true,
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return updater
      },
      async checkForUpdates() { calls.check += 1 },
      async downloadUpdate() {},
      quitAndInstall() {},
      setFeedURL(settings) { calls.feedUrls.push(settings.url) },
    }
    const coordinator = new UpdateCoordinator({
      updater,
      feed: options.feed ?? { kind: 'url', url: GITHUB, packagedConfig: true },
      ...(options.route === undefined
        ? {}
        : {
            route: async () => {
              calls.routes += 1
              return await options.route()
            },
          }),
      log: options.log ?? (() => {}),
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: () => {},
      random: () => 0.5,
    })
    return { coordinator, calls }
  }

  it('consults the router once, however many checks run', async () => {
    // The documented cost model: one comparison per run. Repeating it per poll
    // would re-answer a question whose answer rarely changes, at the price of a
    // real sample from each host.
    const { coordinator, calls } = harness({ route: async () => undefined })
    coordinator.start({ immediate: true })
    await coordinator.check()
    await coordinator.check()
    await coordinator.check()
    expect(calls.routes).toBe(1)
    expect(calls.check).toBe(3)
  })

  it('does not consult the router at startup', async () => {
    // A build whose first check is ten minutes away must not spend a comparison's
    // bandwidth during launch.
    const { coordinator, calls } = harness({ route: async () => undefined })
    coordinator.start()
    expect(calls.routes).toBe(0)
    await coordinator.check()
    expect(calls.routes).toBe(1)
  })

  it('hands the routed feed to the updater', async () => {
    const { coordinator, calls } = harness({ route: async () => ({ kind: 'url', url: GITCODE, packagedConfig: true }) })
    coordinator.start({ immediate: true })
    await coordinator.check()
    expect(calls.feedUrls).toEqual([GITCODE])
  })

  it('leaves the packaged feed alone when the router keeps it', async () => {
    // Nothing to hand over: `app-update.yml` already names this host, and setting
    // it again would only override a correct answer with a copy of itself.
    const { coordinator, calls } = harness({ feed: { kind: 'bundled' }, route: async () => undefined })
    coordinator.start({ immediate: true })
    await coordinator.check()
    expect(calls.feedUrls).toEqual([])
  })

  it('still checks when the router throws', async () => {
    // Source selection is a preference. A router that cannot answer must not turn
    // into an outage, so the check runs against what the build carries.
    const logged = []
    const { coordinator, calls } = harness({
      route: async () => { throw new Error('no network') },
      log: (message) => { logged.push(message) },
    })
    coordinator.start({ immediate: true })
    await coordinator.check()
    expect(calls.check).toBe(1)
    expect(logged.some((line) => line.includes('source selection failed'))).toBe(true)
    expect(coordinator.current.phase).not.toBe('error')
  })

  it('checks exactly as before when there is no router', async () => {
    // The shape every existing build keeps: one source, handed over at startup.
    const { coordinator, calls } = harness()
    coordinator.start({ immediate: true })
    await coordinator.check()
    expect(calls.feedUrls).toEqual([GITHUB])
    expect(calls.routes).toBe(0)
  })
})
