/**
 * The update subsystem: when it polls, what it does with a failure, and what the
 * renderer is allowed to learn.
 *
 * Nothing here touches the network or Electron. `electron-updater` reaches for
 * `app`, a feed file in `resources/`, and the filesystem; the coordinator takes the
 * updater as a parameter precisely so this file can drive the whole state machine
 * against a fake. What is left unverified by construction is the transport, which
 * only a real run against a real feed can exercise.
 *
 * The properties worth guarding are the ones that fail *quietly*: a schedule that
 * retries at full rate forever, a presentation that leaks a diagnostic, a
 * concurrent check that asks the feed twice, or an update that installs itself
 * without being asked.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateCoordinator } from '../apps/desktop/src/update-coordinator.ts'
import { resolveUpdateFeed, updateFeedWarning, UPDATE_URL_ENV } from '../apps/desktop/src/update-feed.ts'
import { presentUpdate, updateFailureKind } from '../apps/desktop/src/update-presentation.ts'
import { UpdateSchedule, resolveUpdateScheduleConfig } from '../apps/desktop/src/update-schedule.ts'

/** A `setTimeout` that never fires, so a test owns the clock. */
function inertTimers() {
  const armed = []
  return {
    armed,
    setTimeoutFn: ((callback, delay) => {
      armed.push({ callback, delay })
      return { unref() {} }
    }),
    clearTimeoutFn: () => {},
  }
}

/** An updater that does nothing until a test tells it to. */
function fakeUpdater(overrides = {}) {
  const listeners = new Map()
  const calls = { check: 0, download: 0, install: 0, feedUrls: [], headerSets: [] }
  let headers = null
  const updater = {
    currentVersion: { version: '0.1.0' },
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    // Recorded through an accessor because the coordinator assigns this directly, and
    // the sequence matters: a feed with headers sets them, a feed without must clear
    // them rather than inherit the previous host's.
    get requestHeaders() { return headers },
    set requestHeaders(value) { headers = value; calls.headerSets.push(value) },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    },
    async checkForUpdates() { calls.check += 1 },
    async downloadUpdate() { calls.download += 1 },
    quitAndInstall() { calls.install += 1 },
    setFeedURL(options) { calls.feedUrls.push(options.url) },
    ...overrides,
  }
  return {
    updater,
    calls,
    /** Fire one updater event, as `electron-updater` would. */
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
}

/** A coordinator wired to inert timers, for tests that do not care about polling. */
function coordinator(options = {}) {
  const fake = options.fake ?? fakeUpdater()
  const timers = inertTimers()
  const instance = new UpdateCoordinator({
    updater: fake.updater,
    feed: options.feed ?? { kind: 'url', url: 'https://updates.example/qialike' },
    ...(options.route === undefined ? {} : { route: options.route }),
    schedule: options.schedule,
    log: options.log ?? (() => {}),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    random: () => 0.5,
  })
  return { coordinator: instance, fake, timers }
}

describe('resolveUpdateScheduleConfig', () => {
  it('uses the harness’s own defaults when nothing is set', () => {
    // Ten minutes, jitter ±20%, backoff capped at an hour — the parameters the
    // harness's desktop uses, so an operator who tuned one has tuned both.
    expect(resolveUpdateScheduleConfig({})).toEqual({ intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 })
  })

  it('reads the documented environment variables', () => {
    const config = resolveUpdateScheduleConfig({
      DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '30000',
      DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '120000',
      DSH_DESKTOP_UPDATE_CHECK_JITTER: '0',
    })
    expect(config).toEqual({ intervalMs: 30_000, maxBackoffMs: 120_000, jitter: 0 })
  })

  it('raises the backoff ceiling to cover the interval when only the interval is set', () => {
    // Otherwise the ceiling would silently cap the base delay and every check
    // would run at the ceiling.
    const config = resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '7200000' })
    expect(config.maxBackoffMs).toBe(7_200_000)
  })

  it('refuses an out-of-range value rather than falling back', () => {
    // A typo that silently means "ten minutes" looks exactly like a working build.
    expect(() => resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '10' }))
      .toThrow(/must be an integer from 1000/)
    expect(() => resolveUpdateScheduleConfig({ DSH_DESKTOP_UPDATE_CHECK_JITTER: '2' }))
      .toThrow(/jitter must be in \[0, 1\]/)
    expect(() => resolveUpdateScheduleConfig({
      DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '600000',
      DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '60000',
    })).toThrow(/max backoff must cover/)
  })
})

describe('UpdateSchedule', () => {
  const config = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 }

  it('waits the base interval after a success', () => {
    const schedule = new UpdateSchedule(config, () => 0.5)
    // 0.5 maps to the centre of the jitter range, so the delay is exactly the base.
    expect(schedule.next('ok')).toBe(600_000)
  })

  it('backs off by doubling, and stops at the ceiling', () => {
    const schedule = new UpdateSchedule(config, () => 0.5)
    const delays = [1, 2, 3, 4].map(() => schedule.next('failed'))
    expect(delays).toEqual([1_200_000, 2_400_000, 3_600_000, 3_600_000])
    expect(schedule.consecutiveFailures).toBe(4)
  })

  it('forgets the failure history after a success', () => {
    const schedule = new UpdateSchedule(config, () => 0.5)
    schedule.next('failed')
    schedule.next('failed')
    expect(schedule.next('ok')).toBe(600_000)
    expect(schedule.consecutiveFailures).toBe(0)
  })

  it('keeps every delay inside the jitter band', () => {
    // The whole point of the jitter is that no two installs ask together, so the
    // band's edges are what matters rather than a sample.
    const lowest = new UpdateSchedule(config, () => 0).next('ok')
    const highest = new UpdateSchedule(config, () => 1).next('ok')
    expect(lowest).toBe(480_000)
    expect(highest).toBe(720_000)
    // At the ceiling the spread is one-sided rather than absent: correctness (never
    // exceed the cap) beats symmetry.
    const capped = new UpdateSchedule(config, () => 1)
    for (let attempt = 0; attempt < 6; attempt += 1) capped.next('failed')
    expect(capped.next('failed')).toBeLessThanOrEqual(config.maxBackoffMs)
  })

  it('never returns a delay a timer cannot take', () => {
    // `setTimeout` treats a delay above 2^31-1 as 1ms, so an unbounded backoff
    // would turn into a tight loop rather than a long wait.
    const schedule = new UpdateSchedule({ intervalMs: 2_000_000_000, maxBackoffMs: 2_147_483_647, jitter: 1 }, () => 1)
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const delay = schedule.next('failed')
      expect(delay).toBeGreaterThanOrEqual(1_000)
      expect(delay).toBeLessThanOrEqual(2_147_483_647)
      expect(Number.isSafeInteger(delay)).toBe(true)
    }
  })
})

describe('presentUpdate', () => {
  it('withholds the diagnostic and the operation', () => {
    // `message` can name internal paths and is unlocalized; the renderer has no use
    // for it, and the contract has no field to put it in.
    const state = {
      phase: 'error',
      failedOperation: 'download',
      message: 'ENOENT /home/someone/.cache/thing',
    }
    const presented = presentUpdate(state)
    expect(JSON.stringify(presented)).not.toContain('ENOENT')
    expect(presented).toEqual({ phase: 'error', failure: 'download' })
  })

  it('floors the percentage', () => {
    // 99.7% that then sits still reads as a hang; 100% must mean done.
    expect(presentUpdate({ phase: 'downloading', percent: 99.7 })).toEqual({ phase: 'downloading', percent: 99 })
    expect(presentUpdate({ phase: 'downloading', percent: 100 })).toEqual({ phase: 'downloading', percent: 100 })
  })

  it('reports a failure kind only in the error phase', () => {
    // Two sources of truth for "is something wrong" would leave the badge deciding
    // which one wins.
    expect(presentUpdate({ phase: 'idle', failure: 'check' })).toEqual({ phase: 'idle' })
    expect(presentUpdate({ phase: 'checking' })).toEqual({ phase: 'checking' })
  })

  it('classifies a transport failure separately from any other', () => {
    for (const message of ['fetch failed: ENOTFOUND', 'Error: ETIMEDOUT', 'net::ERR_NAME_NOT_RESOLVED']) {
      expect(updateFailureKind({ phase: 'error', failedOperation: 'check', message })).toBe('check-network')
    }
    // A non-network failure keeps the operation alone: "could not install" is not
    // something a user can fix by checking their connection.
    expect(updateFailureKind({ phase: 'error', failedOperation: 'install', message: 'signature invalid' }))
      .toBe('install')
  })

  it('assumes the install operation when none was recorded', () => {
    expect(updateFailureKind({ phase: 'error' })).toBe('install')
  })
})

describe('UpdateCoordinator', () => {
  it('disarms itself when there is no feed', () => {
    const logs = []
    const fake = fakeUpdater()
    new UpdateCoordinator({ updater: fake.updater, feed: undefined, log: (m) => logs.push(m) }).start()
    expect(logs.join('\n')).toContain('no feed configured')
    expect(fake.calls.check).toBe(0)
  })

  it('points the updater at a URL feed, and leaves a packaged one alone', () => {
    const urlFeed = coordinator()
    urlFeed.coordinator.start()
    expect(urlFeed.fake.calls.feedUrls).toEqual(['https://updates.example/qialike'])

    // A packaged `app-update.yml` is already where the updater looks; overriding it
    // with a URL it did not come from would discard a working configuration.
    const bundled = coordinator({ feed: { kind: 'bundled' } })
    bundled.coordinator.start()
    expect(bundled.fake.calls.feedUrls).toEqual([])
  })

  it('never walks a user backwards, and never downloads unasked', () => {
    const { coordinator: instance, fake } = coordinator()
    instance.start()
    // A stale `latest.yml` behind a CDN must not downgrade an install.
    expect(fake.updater.allowDowngrade).toBe(false)
    // Asking is automatic; the download follows a check that found something.
    expect(fake.updater.autoDownload).toBe(false)
    // Installing on quit is the one defensible silent install: the user has
    // already stopped working.
    expect(fake.updater.autoInstallOnAppQuit).toBe(true)
  })

  it('walks the phases from a check through to ready', async () => {
    const { coordinator: instance, fake } = coordinator()
    instance.start()

    const checking = instance.check()
    expect(instance.current.phase).toBe('checking')
    await checking
    expect(fake.calls.check).toBe(1)

    fake.emit('update-available', { version: '0.2.0' })
    expect(instance.status()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(fake.calls.download).toBe(1)

    fake.emit('download-progress', { percent: 42.9 })
    expect(instance.status()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 42 })

    fake.emit('update-downloaded', { version: '0.2.0' })
    expect(instance.status()).toEqual({ phase: 'ready', version: '0.2.0' })
  })

  it('treats “you are current” as healthy, not as an error', async () => {
    const { coordinator: instance, fake } = coordinator()
    instance.start()
    const checking = instance.check()
    fake.emit('update-not-available', {})
    await checking
    expect(instance.status()).toEqual({ phase: 'idle' })
  })

  it('reports a failed check without leaking the diagnostic', async () => {
    const fake = fakeUpdater({ async checkForUpdates() { throw new Error('connect ECONNREFUSED 127.0.0.1:9') } })
    const { coordinator: instance } = coordinator({ fake })
    instance.start()
    await instance.check()
    expect(instance.current.failedOperation).toBe('check')
    expect(instance.status()).toEqual({ phase: 'error', failure: 'check-network' })
    expect(JSON.stringify(instance.status())).not.toContain('127.0.0.1')
  })

  it('shares one in-flight check', async () => {
    // Two concurrent checks would race to set the phase and ask the feed twice for
    // the same answer.
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let checks = 0
    // The override replaces the counting implementation, so it counts too.
    const fake = fakeUpdater({ async checkForUpdates() { checks += 1; await gate } })
    const { coordinator: instance } = coordinator({ fake })
    instance.start()
    const first = instance.check()
    const second = instance.check()
    release()
    await Promise.all([first, second])
    expect(checks).toBe(1)
  })

  it('arms the first check immediately when asked, and polls otherwise', () => {
    const immediate = coordinator()
    immediate.coordinator.start({ immediate: true })
    expect(immediate.timers.armed[0].delay).toBe(0)

    const polling = coordinator()
    polling.coordinator.start()
    // The base interval: startup is the busiest moment, and an update check is
    // never urgent.
    expect(polling.timers.armed[0].delay).toBe(600_000)
  })

  it('notifies subscribers and stops when they detach', () => {
    const { coordinator: instance, fake } = coordinator()
    const seen = []
    const off = instance.subscribe((state) => seen.push(state))
    instance.start()
    fake.emit('update-available', { version: '0.2.0' })
    expect(seen).toHaveLength(1)
    off()
    fake.emit('download-progress', { percent: 1 })
    expect(seen).toHaveLength(1)
  })

  it('survives a subscriber that throws', () => {
    // One bad listener must not stop the others, and must not take the updater down.
    const { coordinator: instance, fake } = coordinator()
    const seen = []
    instance.subscribe(() => { throw new Error('listener blew up') })
    instance.subscribe((state) => seen.push(state))
    instance.start()
    fake.emit('update-available', { version: '0.2.0' })
    expect(seen.length).toBeGreaterThan(0)
  })

  it('installs only when the user says so, and only from ready', async () => {
    const { coordinator: instance, fake } = coordinator()
    instance.start()
    // Not ready: nothing to install, and the dialog is not even offered.
    expect(await instance.open(async () => true)).toBe(false)
    expect(fake.calls.install).toBe(0)

    const checking = instance.check()
    fake.emit('update-available', { version: '0.2.0' })
    fake.emit('update-downloaded', { version: '0.2.0' })
    await checking

    // Ready but declined.
    expect(await instance.open(async () => false)).toBe(false)
    expect(fake.calls.install).toBe(0)

    // Ready and accepted.
    expect(await instance.open(async () => true)).toBe(true)
    expect(fake.calls.install).toBe(1)
    expect(instance.current.phase).toBe('installing')
  })

  it('does not hold the process open for a pending check', () => {
    // Electron quits when the last window closes; an armed timer would turn "quit"
    // into "wait for a timer".
    const unref = vi.fn()
    const instance = new UpdateCoordinator({
      updater: fakeUpdater().updater,
      feed: { kind: 'url', url: 'https://updates.example/qialike' },
      setTimeoutFn: (() => ({ unref })),
      clearTimeoutFn: () => {},
    })
    instance.start()
    expect(unref).toHaveBeenCalled()
  })
})

describe('resolveUpdateFeed', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-feed-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('prefers the environment override over the packaged configuration', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app-update.yml'), 'provider: generic\nurl: https://bundled.example\n')
    expect(resolveUpdateFeed({ env: { [UPDATE_URL_ENV]: 'https://test.example/updates/' }, packaged: true, resourcesPath: root }))
      .toEqual({ kind: 'url', url: 'https://test.example/updates', packagedConfig: true })
  })

  it('finds a packaged feed electron-builder wrote', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app-update.yml'), 'provider: generic\nurl: https://bundled.example\n')
    expect(resolveUpdateFeed({ env: {}, packaged: true, resourcesPath: root })).toEqual({ kind: 'bundled' })
  })

  it('reports no feed for a build that has none', () => {
    // A normal state, not a degraded one: anyone can build this application, and
    // most such builds have no update server behind them.
    expect(resolveUpdateFeed({ env: {}, packaged: false, resourcesPath: root })).toBeUndefined()
    expect(resolveUpdateFeed({ env: {}, packaged: true, resourcesPath: root })).toBeUndefined()
  })

  it('ignores a packaged feed in a development run', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app-update.yml'), 'provider: generic\n')
    expect(resolveUpdateFeed({ env: {}, packaged: false, resourcesPath: root })).toBeUndefined()
  })

  it('reports the override-without-packaged-config combination', () => {
    // The confusing one: the check works perfectly and the download then fails,
    // because `electron-updater` reads the packaged `app-update.yml` unconditionally
    // while preparing a download. Nothing in that sequence points at the file.
    const feed = resolveUpdateFeed({
      env: { [UPDATE_URL_ENV]: 'http://127.0.0.1:8080' },
      packaged: true,
      resourcesPath: root,
    })
    expect(feed.packagedConfig).toBe(false)
    expect(updateFeedWarning(feed)).toContain('app-update.yml')
    // The remedy has to say which side of the build the variable belongs on.
    expect(updateFeedWarning(feed)).toContain('*building*')
  })

  it('stays quiet when the feed is complete', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app-update.yml'), 'provider: generic\n')
    const feed = resolveUpdateFeed({
      env: { [UPDATE_URL_ENV]: 'http://127.0.0.1:8080' },
      packaged: true,
      resourcesPath: root,
    })
    expect(feed.packagedConfig).toBe(true)
    expect(updateFeedWarning(feed)).toBeUndefined()
    // A packaged feed needs no warning either: it is the file itself.
    expect(updateFeedWarning({ kind: 'bundled' })).toBeUndefined()
    expect(updateFeedWarning(undefined)).toBeUndefined()
  })

  it('refuses a malformed override rather than retrying an unreachable URL forever', () => {
    expect(() => resolveUpdateFeed({ env: { [UPDATE_URL_ENV]: 'not a url' }, packaged: true, resourcesPath: root }))
      .toThrow(/must be an absolute URL/)
    expect(() => resolveUpdateFeed({ env: { [UPDATE_URL_ENV]: 'ftp://files.example' }, packaged: true, resourcesPath: root }))
      .toThrow(/must be an http\(s\) URL/)
  })
})

describe('the feed a routed host needs', () => {
  /**
   * The header GitCode cannot be read without, as the routing module supplies it.
   *
   * Restated here rather than imported so this file keeps testing the coordinator's
   * handling of whatever headers a feed carries, not one host's particular value.
   */
  const HEADERS = { 'private-token': '' }

  it('sets them when the feed carries them', async () => {
    // The whole point of the mechanism: a host that 404s on a query string gets a
    // header that stops `electron-updater` adding one, and it arrives with the feed
    // rather than being remembered by the caller.
    const { coordinator: instance, fake } = coordinator({
      feed: { kind: 'url', url: 'https://mirror.example/x', packagedConfig: true, requestHeaders: HEADERS },
    })
    instance.start({ immediate: true })
    expect(fake.calls.headerSets).toEqual([HEADERS])
  })

  it('sets them for a routed feed too', async () => {
    const { coordinator: instance, fake } = coordinator({
      feed: { kind: 'bundled' },
      route: async () => ({ kind: 'url', url: 'https://mirror.example/x', packagedConfig: true, requestHeaders: HEADERS }),
    })
    instance.start({ immediate: true })
    await instance.check()
    // Two assignments, and the order is the point: start() clears whatever the
    // packaged feed implied — it carries none here — and the routing result then sets
    // the chosen host's. Only the last one describes the host being asked, which is
    // what the updater ends up using.
    expect(fake.calls.headerSets).toEqual([null, HEADERS])
    expect(fake.updater.requestHeaders).toEqual(HEADERS)
    expect(fake.calls.feedUrls).toEqual(['https://mirror.example/x'])
  })

  it('clears them when a later feed needs none', async () => {
    // A host's headers must not outlive the host. `null` is what restores the
    // default behaviour, and assigning nothing would leave the previous host's
    // header on the next host's requests.
    const { coordinator: instance, fake } = coordinator({
      feed: { kind: 'bundled' },
      route: async () => ({ kind: 'url', url: 'https://plain.example/x', packagedConfig: true }),
    })
    fake.updater.requestHeaders = HEADERS
    fake.calls.headerSets.length = 0
    instance.start({ immediate: true })
    await instance.check()
    // Twice, because both places that can contribute headers agree there are none:
    // start() clears the packaged feed's, and the routing result clears again. The
    // redundancy is deliberate — each is the sole authority on its own path — and the
    // observable outcome is what matters: nothing is left over for the next request.
    expect(fake.calls.headerSets).toEqual([null, null])
    expect(fake.updater.requestHeaders).toBeNull()
  })

  it('sets them for a packaged feed, which names no URL at all', async () => {
    // `bundled` means the updater finds `app-update.yml` itself, so there is no URL for
    // the shell to set — but the file's *host* may still need headers, and this is the
    // only chance to give them. Without it, a build whose packaged configuration points
    // at such a host can never check, and nothing about it looks misconfigured.
    const { coordinator: instance, fake } = coordinator({
      feed: { kind: 'bundled', requestHeaders: HEADERS },
    })
    instance.start({ immediate: true })
    expect(fake.calls.headerSets).toEqual([HEADERS])
    // No URL is handed over: that would replace a correct packaged answer with a guess.
    expect(fake.calls.feedUrls).toEqual([])
  })

  it('clears them for a packaged feed that needs none', async () => {
    const { coordinator: instance, fake } = coordinator({ feed: { kind: 'bundled' } })
    fake.updater.requestHeaders = HEADERS
    fake.calls.headerSets.length = 0
    instance.start({ immediate: true })
    expect(fake.calls.headerSets).toEqual([null])
  })

  it('leaves an updater that has no such field alone', async () => {
    // The field is optional on `UpdaterLike`, so a fake without it must not throw —
    // and neither must a future `electron-updater` that renames it.
    const fake = fakeUpdater()
    delete fake.updater.requestHeaders
    const timers = inertTimers()
    const instance = new UpdateCoordinator({
      updater: fake.updater,
      feed: { kind: 'url', url: 'https://mirror.example/x', packagedConfig: true, requestHeaders: HEADERS },
      log: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      random: () => 0.5,
    })
    instance.start({ immediate: true })
    expect(() => instance.status()).not.toThrow()
    expect(fake.calls.feedUrls).toEqual(['https://mirror.example/x'])
  })

  it('does not copy the caller\'s object into the updater', async () => {
    // Handing the same object over would let anything that mutates the updater's
    // headers mutate the source definition the router keeps reusing.
    const source = { 'private-token': '' }
    const { coordinator: instance, fake } = coordinator({
      feed: { kind: 'url', url: 'https://mirror.example/x', packagedConfig: true, requestHeaders: source },
    })
    instance.start({ immediate: true })
    expect(fake.updater.requestHeaders).toEqual(source)
    expect(fake.updater.requestHeaders).not.toBe(source)
  })
})
