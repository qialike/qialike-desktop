/**
 * Which release host the updater talks to, and how that choice is made.
 *
 * WHY THIS EXISTS. Two hosts carry the same artifacts — GitHub, and the GitCode
 * mirror — and which one is faster is a property of the network the user is on,
 * not of the build. An address baked in at packaging time cannot know that, so a
 * throttled GitHub stays in the automatic path for everyone, forever. The CLI
 * already solved this (`packages/qialike-app/src/self-update.ts`), and this module
 * is the desktop shell's counterpart to it.
 *
 * THE ORDER OF THE QUESTIONS IS THE POLICY.
 *
 *   1. one source configured        -> nothing to choose; it stays
 *   2. neither can serve a release  -> the configured one stays
 *   3. exactly one can              -> that one is pinned
 *   4. only one names the newest    -> that one is pinned, unmeasured
 *   5. two or more name the newest  -> sample each, pin the faster
 *
 * FRESHNESS IS ASKED BEFORE SPEED, because a mirror lags. Measured live: for one
 * repository GitCode served 3.11.0 while GitHub served 3.12.0. Choosing the faster
 * host there would end updates silently — `allowDowngrade` is false, so an older
 * manifest answers "nothing available" forever and nobody is told. Speed therefore
 * only decides between sources offering the *same* newest release, and step 4 skips
 * the measurement entirely in the common case where one host is simply ahead.
 *
 * REACHABILITY IS NOT THROUGHPUT, which is why step 5 measures a real body rather
 * than timing a redirect: GitHub answers the small `releases/latest/download`
 * request from `github.com` and serves the asset from
 * `release-assets.githubusercontent.com`, so a GitHub whose asset CDN is throttled
 * passes every reachability check and then crawls through a 275 MB download.
 *
 * IT MEASURES ONCE PER RUN. A comparison costs a real sample from each host, and
 * repeating it on every poll would spend bandwidth to re-answer a question whose
 * answer rarely changes. The chosen source is remembered for the life of the
 * process; a long-lived session therefore keeps the route it started with (the
 * price of not re-measuring, and the reason `MEASURE_ENV` exists).
 *
 * IT CANNOT MAKE THINGS WORSE. Every path that reaches no conclusion returns the
 * configured source, so the worst case is exactly the behaviour this shell had
 * before routing existed — including "both hosts are unreachable", where keeping
 * the configured one means the ordinary check runs and reports an ordinary network
 * failure, rather than updates silently becoming inert.
 *
 * GITCODE IS NOT GITHUB SHAPED. GitHub's `.../releases/latest/download` and
 * GitCode's `.../releases/download/latest` are different paths with the same
 * meaning, and GitCode answers GitHub's spelling with **200 and an HTML shell** —
 * a status code is not a judgement there, so only the form measured to serve a real
 * file is used. `scripts/desktop/publish.sh` carries the same measurements.
 *
 * @module @qialike/desktop/update-sources
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A release host the updater may point at. */
export interface UpdateSource {
  /** Stable id, for logs and tests. */
  readonly id: string
  /** Human-readable name, for the log line. */
  readonly label: string
  /** The directory URL the channel manifest is read from. No trailing slash. */
  readonly base: string
  /**
   * Headers this host's manifest cannot be fetched without, if any.
   *
   * A PROPERTY OF THE SOURCE rather than something the chooser applies, because
   * that is what it is: a quirk of one host. Keeping it here means the chooser
   * cannot forget it — whoever wins the comparison brings what it needs.
   *
   * @see GITCODE_MANIFEST_HEADERS for what GitCode needs and why.
   */
  readonly requestHeaders?: Readonly<Record<string, string>>
}

/** The primary host, whose address a build bakes in. */
export const GITHUB_SOURCE_ID = 'github'

/** The mirror, derived from the primary's address rather than configured. */
export const GITCODE_SOURCE_ID = 'gitcode'

/**
 * The header GitCode's manifest cannot be fetched without — and the reason is not
 * authentication.
 *
 * GITCODE ANSWERS ANY REQUEST WITH A QUERY STRING AS 404. Measured on a published
 * release, with the body as the judge rather than the status code alone:
 *
 *     /releases/download/latest/latest-linux.yml                -> 200, "version: 0.3.7"
 *     /releases/download/latest/latest-linux.yml?noCache=1      -> 404, {"error_code_name":"NOT_PATH"}
 *
 * (GitHub serves both. And GitCode's *other* two spellings — `/releases/latest/download/…`
 * and `/raw/…` — answer 200 with an HTML shell, which is why the URL form cannot be
 * changed to dodge this: every alternative is either 404 or not a manifest.)
 *
 * `electron-updater` attaches `?noCache=<timestamp>` to the channel manifest by
 * default. Its `AppUpdater.isAddNoCacheQuery` returns false only when
 * `requestHeaders` carries a key named `authorization` or `private-token` — the
 * values are never read, only the key names. So a header is the only lever, and
 * `private-token` is the one to pull: it is GitCode's own authentication header,
 * so the other source does not interpret it at all, whereas an empty
 * `authorization` is a real authentication header to GitHub.
 *
 * WHY THE VALUE IS EMPTY. Nothing is being authenticated; the key exists to change
 * a URL-building decision inside `electron-updater`. GitCode accepts it (measured:
 * manifest 200, artifact range request 206).
 *
 * WHAT MAKES THIS FRAGILE, AND WHAT GUARDS IT. It relies on behaviour that
 * `electron-updater` marks `@internal`: the key-name test, and the fact that the
 * header reaches the provider before `getLatestVersion()` runs. If upstream changes
 * either, this silently stops working and GitCode's manifest goes back to 404 —
 * silence is the dangerous part, because the routing would keep choosing GitCode on
 * speed while every check failed. Two things watch it: a test that reads the
 * installed `AppUpdater.isAddNoCacheQuery` and fails if its key names change, and
 * `scripts/desktop/update-source-check.mjs`, which drives a real packaged
 * application against the real hosts and would report the 404.
 */
export const GITCODE_MANIFEST_HEADERS: Readonly<Record<string, string>> = { 'private-token': '' }

/**
 * The documented switch that records no comparison at all.
 *
 * Set it to `0` and routing only asks the reachability question; the configured
 * source is kept whenever it can serve the release. It exists for the same reason
 * the CLI's `QIALIKE_INSTALL_MEASURE=0` does: a metered connection should be able to
 * refuse the sample, and the sample is the only part of this module that moves real
 * bytes.
 */
export const MEASURE_ENV = 'QIALIKE_DESKTOP_UPDATE_MEASURE'

/** How many bytes one throughput sample reads. The CLI measures the same window. */
export const MEASURE_BYTES = 262_144

/** How long one sample may take. Long enough for 256 KiB on a slow line. */
export const MEASURE_TIMEOUT_MS = 8_000

/** How long a channel manifest may take. It is a few hundred bytes. */
export const MANIFEST_TIMEOUT_MS = 6_000

/**
 * GitHub's "latest release" alias, with the owner and repository captured.
 *
 * Anchored deliberately: this is what decides whether a mirror can be derived, and
 * a loose pattern would invent a GitCode URL for a base that is not a GitHub
 * release directory at all — a fork's own server, an internal mirror, a test feed.
 */
const GITHUB_LATEST_DOWNLOAD = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download$/

/** One artifact named by a channel manifest. */
export interface ManifestFile {
  readonly url: string
  /** Declared size, when the manifest carries one. */
  readonly size?: number
}

/**
 * Which extensions to look for, and which to refuse.
 *
 * MIRRORS `findFile` IN `electron-updater` (`providers/Provider.ts`), because the
 * sample should be taken from the artifact this installation would actually
 * download: an AppImage install fetches the AppImage, a deb install fetches the
 * deb, and measuring the other one measures a file the user will never receive.
 */
export interface AssetChoice {
  /** Tried in order; the first artifact matching one wins. */
  readonly extensions: readonly string[]
  /** Refused when nothing matched — electron-updater's own fallback rule. */
  readonly not: readonly string[]
}

/**
 * The channel manifest for this platform and architecture.
 *
 * `electron-updater` builds this name in `Provider.getChannelFilePrefix()`: Linux
 * carries an architecture suffix that is *absent* for x64, macOS is `-mac`, and
 * Windows has no suffix at all "due to historical reasons". Getting it wrong means
 * asking for a file no release contains, so it is derived the same way rather than
 * guessed per platform.
 *
 * @param platform - the platform to name the manifest for.
 * @param arch - the architecture; `x64` is the unsuffixed Linux case.
 * @returns the manifest's file name.
 */
export function channelFileFor(platform: NodeJS.Platform, arch: string = process.arch): string {
  if (platform === 'linux') return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`
  if (platform === 'darwin') return 'latest-mac.yml'
  return 'latest.yml'
}

/**
 * The artifact an update on this installation would fetch.
 *
 * @param platform - the running platform.
 * @param packageType - the contents of `resources/package-type`, when the package
 *   has one; `deb` on a Debian install, absent on an AppImage.
 * @returns the extensions to prefer and the ones to refuse.
 */
export function assetChoice(platform: NodeJS.Platform, packageType?: string): AssetChoice {
  if (platform === 'win32') return { extensions: ['exe'], not: [] }
  if (platform === 'darwin') return { extensions: ['zip'], not: ['pkg', 'dmg'] }
  return packageType === 'deb'
    ? { extensions: ['deb'], not: ['AppImage', 'rpm', 'pacman'] }
    : { extensions: ['AppImage'], not: ['rpm', 'deb', 'pacman'] }
}

/**
 * The mirror of a GitHub release directory, when there is one to derive.
 *
 * DERIVED RATHER THAN CONFIGURED, which is what keeps "a build with no update
 * server stays inert" true: a base that is not a GitHub release directory — a
 * fork's own host, a test feed, an internal mirror — has no derivable mirror and
 * therefore no routing, instead of being pointed at ours.
 *
 * @param base - the configured feed base.
 * @returns the mirror source, or undefined when none can be derived.
 */
export function mirrorFor(base: string): UpdateSource | undefined {
  const match = GITHUB_LATEST_DOWNLOAD.exec(base.replace(/\/+$/u, ''))
  const owner = match?.[1]
  const repo = match?.[2]
  if (owner === undefined || repo === undefined) return undefined
  return {
    id: GITCODE_SOURCE_ID,
    label: `gitcode (${owner}/${repo})`,
    // The version segment is the literal `latest`, and it is in a different
    // position than GitHub's. Both were measured; see the module note.
    base: `https://gitcode.com/${owner}/${repo}/releases/download/latest`,
    // Without this the manifest request gains `?noCache=` and GitCode answers 404.
    // See GITCODE_MANIFEST_HEADERS.
    requestHeaders: GITCODE_MANIFEST_HEADERS,
  }
}

/**
 * The sources to choose between, primary first.
 *
 * @param base - the base URL the build carries, if it carries one.
 * @returns one source when no mirror can be derived, two when it can.
 */
export function updateSources(base: string | undefined): UpdateSource[] {
  if (base === undefined || base.trim() === '') return []
  const normalized = base.trim().replace(/\/+$/u, '')
  // A build pointed straight at the mirror is a source too, and it needs the same
  // header. Without this the header would only ever be attached by the mirror
  // derivation below, so `QIALIKE_DESKTOP_UPDATE_URL=<gitcode>` — which the docs
  // allow — would 404 exactly like the unpatched routing did.
  const ownHeaders = requestHeadersFor(normalized)
  const primary: UpdateSource = {
    id: ownHeaders === undefined ? GITHUB_SOURCE_ID : GITCODE_SOURCE_ID,
    label: ownHeaders === undefined ? 'github' : 'gitcode',
    base: normalized,
    ...(ownHeaders === undefined ? {} : { requestHeaders: ownHeaders }),
  }
  const mirror = mirrorFor(normalized)
  return mirror === undefined ? [primary] : [primary, mirror]
}

/**
 * The headers a base URL's host cannot be read without.
 *
 * A SEPARATE QUESTION FROM WHERE THE URL CAME FROM. The feed can arrive three ways
 * — an environment override, `app-update.yml`, or the routing decision — and the
 * header requirement is a property of the host in all three. Keeping the test here,
 * next to {@link GITCODE_MANIFEST_HEADERS}, means each of those paths asks the same
 * question instead of one of them remembering and the others not.
 *
 * @param base - the feed base URL.
 * @returns the headers it needs, or undefined when it needs none.
 */
export function requestHeadersFor(base: string): Readonly<Record<string, string>> | undefined {
  let host: string
  try {
    host = new URL(base).hostname.toLowerCase()
  } catch {
    // Not a URL at all. The callers validate before this point; saying "no headers"
    // here keeps a malformed value from turning into a different failure.
    return undefined
  }
  return host === 'gitcode.com' || host.endsWith('.gitcode.com') ? GITCODE_MANIFEST_HEADERS : undefined
}

/**
 * The feed address an electron-builder package carries.
 *
 * Read from `app-update.yml`, which is what the updater itself reads. Needed
 * because {@link UpdateFeed}'s `bundled` shape records only *that* a package has a
 * feed, not where it points — and routing has to know where it points in order to
 * derive the mirror of that same repository.
 *
 * @param resourcesPath - `process.resourcesPath`.
 * @returns the configured URL, or undefined when the package has no feed.
 */
export function packagedFeedUrl(resourcesPath: string): string | undefined {
  try {
    const text = readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8')
    return /^url:[ \t]*(\S+)[ \t]*$/mu.exec(text)?.[1]
  } catch {
    // Absent on a build with no feed, which is a normal state rather than an error.
    return undefined
  }
}

/**
 * The package type electron-builder recorded for this installation.
 *
 * @param resourcesPath - `process.resourcesPath`.
 * @returns the recorded type (`deb`, …), or undefined when there is none.
 */
export function packageTypeOf(resourcesPath: string): string | undefined {
  try {
    const text = readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    // An AppImage carries no `package-type`; that absence is what selects
    // `AppImageUpdater` at run time, so it selects the AppImage here too.
    return undefined
  }
}

/**
 * The artifacts a manifest names.
 *
 * A NARROW READER, NOT A YAML PARSER. The channel format is generated and flat, and
 * only `files[].url` (with the optional `size`) is wanted. `electron-updater`
 * itself resolves a manifest with no `files` through the deprecated top-level
 * `path`, and so does this, because a release written by an older electron-builder
 * is still a release.
 *
 * @param text - the manifest body.
 * @returns the artifacts, in manifest order.
 */
export function manifestFiles(text: string): ManifestFile[] {
  const files: ManifestFile[] = []
  let current: { url: string, size?: number } | undefined
  for (const line of text.split(/\r?\n/u)) {
    const url = /^[ \t]*-[ \t]*url:[ \t]*(\S+)[ \t]*$/u.exec(line)
    if (url?.[1] !== undefined) {
      if (current !== undefined) files.push(current)
      current = { url: url[1] }
      continue
    }
    const size = /^[ \t]+size:[ \t]*(\d+)[ \t]*$/u.exec(line)
    if (size?.[1] !== undefined && current !== undefined && current.size === undefined) {
      current.size = Number(size[1])
    }
  }
  if (current !== undefined) files.push(current)
  if (files.length > 0) return files
  const path = /^path:[ \t]*(\S+)[ \t]*$/mu.exec(text)?.[1]
  return path === undefined ? [] : [{ url: path }]
}

/**
 * The version a manifest announces.
 *
 * @param text - the manifest body.
 * @returns the version, or undefined when the manifest does not name one.
 */
export function manifestVersion(text: string): string | undefined {
  return /^version:[ \t]*(\S+)[ \t]*$/mu.exec(text)?.[1]
}

/**
 * A dotted version as comparable numbers, or undefined when it is not one.
 *
 * Deliberately strict and therefore honest: anything that is not a run of numeric
 * segments (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`) is *not a version this can rank*, and
 * returning undefined leaves the caller to decide what an unrankable answer means
 * rather than inventing an order from a string comparison. A lexical comparison
 * would rank `0.9.0` above `0.10.0`, which is the kind of bug that ships a downgrade.
 *
 * @param value - the version string.
 * @returns its numeric segments, or undefined.
 */
export function parseVersion(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined
  const core = value.trim().replace(/^v/u, '').split(/[+-]/u)[0]
  if (core === undefined || core === '') return undefined
  const segments: number[] = []
  for (const segment of core.split('.')) {
    if (!/^\d+$/u.test(segment)) return undefined
    segments.push(Number(segment))
  }
  return segments.length === 0 ? undefined : segments
}

/**
 * Compare two parsed versions.
 *
 * @param left - the first version.
 * @param right - the second version.
 * @returns a negative number, zero, or a positive number, as usual.
 */
export function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * The candidates that announce the newest release, or none when nothing is rankable.
 *
 * @param probes - the usable probes.
 * @returns the newest ones, or an empty array when no version could be read.
 */
export function newestByVersion(probes: readonly SourceProbe[]): SourceProbe[] {
  const ranked: { probe: SourceProbe, version: number[] }[] = []
  for (const probe of probes) {
    const version = parseVersion(probe.version)
    if (version !== undefined) ranked.push({ probe, version })
  }
  const first = ranked[0]
  if (first === undefined) return []
  let best = first.version
  for (const entry of ranked) {
    if (compareVersions(entry.version, best) > 0) best = entry.version
  }
  return ranked.filter((entry) => compareVersions(entry.version, best) === 0).map((entry) => entry.probe)
}

/**
 * The artifact to sample, following electron-updater's own preference.
 *
 * @param files - the artifacts the manifest names.
 * @param choice - the extensions to prefer and refuse.
 * @param arch - the architecture to prefer within a match.
 * @returns the chosen artifact, or undefined when the manifest names none usable.
 */
export function pickAsset(
  files: readonly ManifestFile[],
  choice: AssetChoice,
  arch: string = process.arch,
): ManifestFile | undefined {
  for (const extension of choice.extensions) {
    const matching = files.filter((file) => file.url.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
    if (matching.length === 0) continue
    return matching.find((file) => file.url.includes(arch)) ?? matching[0]
  }
  // `findFile` falls through to "the first file this platform cannot install",
  // which keeps a manifest that names only unexpected formats usable rather than
  // making the source look dead.
  return files.find(
    (file) => !choice.not.some((extension) => file.url.toLowerCase().endsWith(`.${extension.toLowerCase()}`)),
  )
}

/** What asking one source produced. */
export interface SourceProbe {
  readonly source: UpdateSource
  /** Whether this source answered with a manifest naming an artifact for this build. */
  readonly usable: boolean
  /** The version it announced, when it answered. */
  readonly version?: string
  /** The artifact a sample would be taken from. */
  readonly asset?: string
  /** Why it is unusable, when it is. */
  readonly failure?: string
}

/** A measurement of one source, in bytes per second. */
export interface SourceSpeed {
  readonly id: string
  /** Undefined when nothing could be measured; a zero-byte answer is not a speed. */
  readonly bytesPerSecond?: number
}

/** Where the updater should point, and the evidence for it. */
export interface UpdateRoute {
  /** The base URL to use. Always present: this is what the caller applies. */
  readonly base: string
  /** The source that base belongs to, when it is one of the candidates. */
  readonly source?: UpdateSource
  /** One line for the log, naming what decided it. */
  readonly reason: string
  /** What each candidate answered. */
  readonly probes: readonly SourceProbe[]
  /** What each candidate managed, when anything was measured. */
  readonly speeds: readonly SourceSpeed[]
}

/** Whether the comparison is allowed; `MEASURE_ENV=0` refuses it. */
export function measuringEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[MEASURE_ENV] !== '0'
}

/**
 * Ask one source what it is offering.
 *
 * Reachability and usefulness are one question here, not two: a source that cannot
 * name an artifact for this build cannot serve this release, whatever else it
 * answers. That is stricter than a ping, and deliberately so — the CLI separates
 * the two because its mirror may legitimately lag a tag, and a lagging mirror is
 * still *reachable*; but a lagging mirror is of no use for a comparison either, so
 * it drops out as a candidate rather than being pinned.
 *
 * @param options.source - the source to ask.
 * @param options.channel - the manifest file name.
 * @param options.choice - which extensions are usable.
 * @param options.arch - the architecture to prefer.
 * @param options.fetchFn - the transport; injected so tests need no network.
 * @param options.timeoutMs - how long the request may take.
 * @returns what the source answered.
 */
export async function probeSource(options: {
  source: UpdateSource
  channel: string
  choice: AssetChoice
  arch?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}): Promise<SourceProbe> {
  const { source } = options
  const doFetch = options.fetchFn ?? fetch
  const arch = options.arch ?? process.arch
  const timeoutMs = options.timeoutMs ?? MANIFEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await doFetch(`${source.base}/${options.channel}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/yaml, text/plain, */*' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { source, usable: false, failure: `http ${String(response.status)}` }
    }
    const text = await response.text()
    const files = manifestFiles(text)
    const asset = pickAsset(files, options.choice, arch)
    if (asset === undefined) {
      return { source, usable: false, failure: 'no artifact for this platform in the manifest' }
    }
    const version = manifestVersion(text)
    return {
      source,
      usable: true,
      asset: asset.url,
      ...(version === undefined ? {} : { version }),
    }
  } catch (error) {
    return { source, usable: false, failure: describeError(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How fast one source delivers a real artifact.
 *
 * A RANGE REQUEST, THEN AN ABORT. The sample is the first {@link MEASURE_BYTES} of
 * the artifact and nothing more: the reader stops as soon as it has them, so a host
 * that honours `Range` and one that ignores it and starts streaming the whole
 * 275 MB both cost the same. Measuring without aborting would turn a route decision
 * into a full download.
 *
 * A ZERO-BYTE ANSWER IS NOT A SPEED. Nothing received means the host is dead or the
 * artifact is not there; returning 0 would make that source merely slow instead of
 * absent, and it would then be pinned whenever the other one also failed.
 *
 * @param options.url - the artifact's absolute URL.
 * @param options.fetchFn - the transport; injected so tests need no network.
 * @param options.bytes - how many bytes to read.
 * @param options.timeoutMs - how long the sample may take.
 * @param options.now - the clock; injected so tests do not wait.
 * @returns bytes per second, or undefined when nothing arrived.
 */
export async function measureThroughput(options: {
  url: string
  fetchFn?: typeof fetch
  bytes?: number
  timeoutMs?: number
  now?: () => number
}): Promise<number | undefined> {
  const doFetch = options.fetchFn ?? fetch
  const wanted = options.bytes ?? MEASURE_BYTES
  const timeoutMs = options.timeoutMs ?? MEASURE_TIMEOUT_MS
  const now = options.now ?? Date.now
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const started = now()
    const response = await doFetch(options.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { range: `bytes=0-${String(wanted - 1)}` },
    })
    if (response.status !== 206 && !response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const body = response.body
    if (body === null) return undefined
    const reader = body.getReader()
    let received = 0
    try {
      while (received < wanted) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
      }
    } finally {
      // Stops a host that ignored `Range` from streaming the rest of the artifact,
      // and releases the connection either way.
      await reader.cancel().catch(() => {})
    }
    const elapsedMs = now() - started
    if (received === 0 || elapsedMs <= 0) return undefined
    return received / (elapsedMs / 1000)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Choose the source to update from.
 *
 * @param options.sources - the candidates, primary first.
 * @param options.channel - the manifest file name for this platform.
 * @param options.choice - which extensions are usable.
 * @param options.arch - the architecture to prefer.
 * @param options.measure - whether a comparison is allowed.
 * @param options.fetchFn - the transport; injected so tests need no network.
 * @param options.now - the clock; injected so tests do not wait.
 * @param options.log - sink for the decision, which never reaches the renderer.
 * @returns the route, always naming a base to use.
 * @throws Error when handed no sources at all — the caller is expected to have
 *   established that the build has a feed before asking where to point it.
 */
export async function routeUpdateSource(options: {
  sources: readonly UpdateSource[]
  channel: string
  choice: AssetChoice
  arch?: string
  measure?: boolean
  fetchFn?: typeof fetch
  now?: () => number
  log?: (message: string) => void
}): Promise<UpdateRoute> {
  const first = options.sources[0]
  if (first === undefined) throw new Error('update routing needs at least one source')
  const measure = options.measure ?? true

  if (options.sources.length === 1) {
    return { base: first.base, source: first, reason: 'the only configured source', probes: [], speeds: [] }
  }

  const probeOptions = {
    channel: options.channel,
    choice: options.choice,
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  }
  // In parallel because these are a few hundred bytes each and asking in sequence
  // would only add the slower host's latency to the decision. The *measurements*
  // below are deliberately sequential for the opposite reason: two samples sharing
  // one connection would compete for the same bandwidth and flatten the difference
  // the comparison exists to find.
  const probes = await Promise.all(options.sources.map(async (source) => await probeSource({ source, ...probeOptions })))
  const usable = probes.filter((probe) => probe.usable)

  const summarize = (reason: string, chosen: SourceProbe | undefined): UpdateRoute => {
    const route: UpdateRoute = {
      base: chosen?.source.base ?? first.base,
      reason,
      probes,
      speeds: [],
      ...(chosen === undefined ? {} : { source: chosen.source }),
    }
    options.log?.(describeRoute(route))
    return route
  }

  if (usable.length === 0) {
    return summarize('no source can serve this release; keeping the configured one', undefined)
  }
  const only = usable[0]
  if (usable.length === 1 && only !== undefined) {
    return summarize(`${only.source.label} is the only source that can serve it`, only)
  }

  // FRESHNESS BEFORE SPEED, and this is not theoretical. Measured live against a real
  // mirror: GitCode served 3.11.0 while GitHub served 3.12.0 for the same repository.
  // Pinning the faster host there would silently end updates — `allowDowngrade` is
  // false, so an older manifest reports "nothing available" forever and the user is
  // never told. So a host that is merely *behind* drops out before any measurement,
  // and speed only decides between sources offering the same newest release.
  const newest = newestByVersion(usable)
  if (newest.length === 1) {
    const named = newest[0]
    if (named !== undefined) {
      return summarize(
        `${named.source.label} names the newest release (${named.version ?? 'unversioned'})`,
        named,
      )
    }
  }
  const candidates = newest.length === 0 ? usable : newest

  if (!measure) {
    return summarize(`${MEASURE_ENV}=0, so no comparison was made`, undefined)
  }

  const speeds: SourceSpeed[] = []
  for (const probe of candidates) {
    const asset = probe.asset
    if (asset === undefined) continue
    const bytesPerSecond = await measureThroughput({
      url: absoluteAssetUrl(probe.source.base, asset),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    speeds.push(bytesPerSecond === undefined ? { id: probe.source.id } : { id: probe.source.id, bytesPerSecond })
  }

  let best: SourceProbe | undefined
  let bestSpeed = 0
  for (const probe of candidates) {
    const speed = speeds.find((entry) => entry.id === probe.source.id)?.bytesPerSecond
    // A tie keeps the earlier source, so an inconclusive comparison leaves the
    // configured order alone rather than swapping hosts on noise.
    if (speed === undefined || speed <= bestSpeed) continue
    best = probe
    bestSpeed = speed
  }
  if (best === undefined) {
    const route: UpdateRoute = {
      base: first.base,
      source: first,
      reason: 'nothing could be measured, so the configured order stands',
      probes,
      speeds,
    }
    options.log?.(describeRoute(route))
    return route
  }
  const route: UpdateRoute = { base: best.source.base, source: best.source, reason: 'the faster of two', probes, speeds }
  options.log?.(describeRoute(route))
  return route
}

/**
 * The absolute URL of a manifest-named artifact.
 *
 * Manifests name artifacts by file name, which is what a release directory needs;
 * an absolute URL is passed through so a manifest that names a CDN directly keeps
 * working.
 *
 * @param base - the source's directory URL.
 * @param asset - the name (or absolute URL) from the manifest.
 * @returns the URL to fetch.
 */
export function absoluteAssetUrl(base: string, asset: string): string {
  return /^https?:\/\//u.test(asset) ? asset : `${base}/${asset}`
}

/** One line describing a decision, for the shell's log. */
function describeRoute(route: UpdateRoute): string {
  const speeds = route.speeds
    .map((speed) => `${speed.id}=${speed.bytesPerSecond === undefined ? 'unmeasurable' : formatSpeed(speed.bytesPerSecond)}`)
    .join(' ')
  const asked = route.probes
    .map((probe) => `${probe.source.id}=${probe.usable ? (probe.version ?? 'ok') : (probe.failure ?? 'unusable')}`)
    .join(' ')
  return `update: sources ${asked}${speeds === '' ? '' : ` | ${speeds}`} -> ${route.base} (${route.reason})`
}

/** A throughput in the units a person reads. */
function formatSpeed(bytesPerSecond: number): string {
  const mib = bytesPerSecond / (1024 * 1024)
  return mib >= 1 ? `${mib.toFixed(1)} MiB/s` : `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`
}

/** A failure in one short phrase, without a stack. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const detail = cause instanceof Error ? cause.message : undefined
    // `fetch` reports every transport failure as "fetch failed" and puts the useful
    // part in `cause`; without this the log says nothing about DNS or TLS.
    return detail === undefined ? error.message : `${error.message}: ${detail}`
  }
  return String(error)
}
