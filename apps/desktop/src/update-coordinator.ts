/**
 * The update state machine: one check at a time, one state, one feed.
 *
 * WHY THE UPDATER IS INJECTED. `electron-updater` reaches for `app`, a feed file
 * in `resources/`, and the filesystem, none of which exist under plain Node — so a
 * coordinator that constructed it directly could only be tested by launching the
 * application. Taking it as a parameter means the whole machine — the phase
 * transitions, the concurrent-check guard, the failure classification — is
 * exercised against a fake, and only the real transport is left to a real run.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. There is no mandatory-update flow, no
 * policy fetch, no signed instruction to install, and no journal. The harness's
 * own shell has all four; they exist to serve a vendor that must be able to force
 * an upgrade on a fleet, and this application has no such requirement (DESIGN §9
 * decouples it from the CLI's `qialike upgrade` policy too). What is left is the
 * honest core: ask the feed, download what it offers, tell the user, install on
 * their say-so or on quit.
 *
 * The renderer's authority is bounded by {@link UpdatePresentation}: it can ask
 * what is happening and ask for a dialog, and nothing else.
 *
 * @module @qialike/desktop/update-coordinator
 */

import type { UpdateFeed, UpdateOperation, UpdatePresentation, UpdateState } from './update-contract.ts'
import { presentUpdate } from './update-presentation.ts'
import { UpdateSchedule, type UpdateScheduleConfig } from './update-schedule.ts'

/**
 * The slice of `electron-updater`'s `AppUpdater` this module drives.
 *
 * Narrow on purpose: a wider interface would make the fake in the tests drift
 * from the real thing without anything noticing, and every member here is one
 * this coordinator actually uses.
 */
export interface UpdaterLike {
  readonly currentVersion: { readonly version: string } | string
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  /**
   * Headers every request carries, which `electron-updater` also reads to decide
   * whether to append its cache-busting query to the manifest URL.
   *
   * Optional because the fake in the tests need not have it, and because a feed
   * that needs no headers must not be given any: assigning `null` is what restores
   * the default behaviour.
   */
  requestHeaders?: Record<string, string> | null
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  setFeedURL?(options: { provider: 'generic', url: string }): void
}

/** What the coordinator needs from its surroundings. */
export interface UpdateCoordinatorOptions {
  /** The updater to drive. */
  readonly updater: UpdaterLike
  /** Feed to point the updater at, when one is configured. */
  readonly feed?: UpdateFeed | undefined
  /**
   * Chooses the feed, once per run, before the first check.
   *
   * Injected rather than performed here for the same reason the updater is: the
   * choice needs the network, and a coordinator that reached for it could only be
   * tested by going online. It runs inside the first check rather than at startup
   * so a build whose first check is ten minutes away does not spend a comparison's
   * bandwidth during launch.
   *
   * Returning undefined keeps {@link feed}. Throwing is treated the same way: a
   * preference that cannot be worked out is not a reason to stop updating.
   */
  readonly route?: () => Promise<UpdateFeed | undefined>
  /** Validated polling settings. */
  readonly schedule?: UpdateScheduleConfig
  /** Sink for the shell's own diagnostics, which never reach the renderer. */
  readonly log?: (message: string) => void
  /** Injected clock, so tests do not wait. */
  readonly setTimeoutFn?: typeof setTimeout
  readonly clearTimeoutFn?: typeof clearTimeout
  readonly random?: () => number
}

/** The version string of an updater whose `currentVersion` may be either shape. */
function versionOf(updater: UpdaterLike): string {
  const current = updater.currentVersion
  return typeof current === 'string' ? current : current.version
}

/**
 * Own the update lifecycle for one application run.
 *
 * Not started by its constructor: {@link start} is what arms the first check, and
 * a caller that never calls it (a development run, a build with no feed) gets a
 * coordinator that reports `idle` and does nothing.
 */
export class UpdateCoordinator {
  private state: UpdateState = { phase: 'idle' }

  /**
   * Whether the check now in flight should start the download when it finds something.
   *
   * WHY THIS IS STATE RATHER THAN A PARAMETER. The decision has to be read when `update-available` arrives,
   * which is a separate turn of the event loop from the `check()` call that caused it. A parameter would be
   * gone by then, and the only way to recover it would be to guess from the phase.
   *
   * Defaults to true, which is the background behaviour: a scheduled check that finds an update downloads it
   * quietly so the badge can offer a one-click install. A MANUAL check passes false, because a click that
   * silently starts a 200 MB download is a surprise on a metered connection — the user asked "is there
   * anything?", not "fetch it".
   */
  private downloadWhenFound = true
  private readonly listeners = new Set<(state: UpdatePresentation) => void>()
  private readonly schedule: UpdateSchedule
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<UpdateState> | undefined
  private disposed = false
  /**
   * The once-per-run source choice, memoized as a promise.
   *
   * A promise rather than a boolean so two callers cannot both start a comparison:
   * the second awaits the first one's answer.
   */
  private routed: Promise<void> | undefined
  /** Whether a `checkForUpdates` call has resolved, so `error` can tell a failure from a first run. */
  private checked = false

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.schedule = new UpdateSchedule(
      options.schedule ?? { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 },
      options.random ?? Math.random,
    )
    this.attach()
  }

  /** The current state, as the shell knows it. */
  get current(): UpdateState {
    return this.state
  }

  /** Whether a feed is configured; without one, updates are inert rather than failing. */
  get hasFeed(): boolean {
    return this.options.feed !== undefined
  }

  /**
   * Subscribe to presentation changes.
   * @param listener - called with each new presentation.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (state: UpdatePresentation) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current presentation. */
  status(): UpdatePresentation {
    return presentUpdate(this.state)
  }

  /**
   * Point the updater at the feed and run the first check soon after startup.
   *
   * The first check is delayed by the full interval rather than run immediately:
   * startup is the moment the application is doing the most work, and an update
   * check is never urgent. {@link check} with `manual` is how a user asks now.
   *
   * @param options.immediate - check as soon as the event loop allows, for a run
   *   whose caller wants the answer now (tests, and a diagnostics command).
   */
  start(options: { immediate?: boolean } = {}): void {
    if (this.disposed) return
    if (this.options.feed === undefined) {
      this.options.log?.('update: no feed configured, so update checks are disabled')
      return
    }
    // Only when the feed is a URL we were given. A packaged `app-update.yml` is
    // already in the right place, and pointing the updater at a URL it did not
    // come from would discard a working configuration.
    //
    // With a router, this is where the choice is *deferred* rather than made:
    // `applyRoute` runs it inside the first check, and until then the packaged
    // configuration is already the correct answer.
    if (this.options.route === undefined && this.options.feed.kind === 'url') {
      // Through `applyFeed`, not `setFeedURL` directly: a feed that names a host
      // needing headers must get them here too, and the one place that knows how to
      // hand a feed over should be the only place that does it.
      this.applyFeed(this.options.feed)
    } else if (this.options.feed.kind === 'bundled') {
      // A packaged feed names no URL for the shell to set — the updater finds
      // `app-update.yml` itself — but its *host* may still need headers, and this is
      // the only chance to give them. Without this branch a build whose packaged
      // configuration points at such a host can never check, and nothing about it
      // looks misconfigured.
      this.applyHeaders(this.options.feed.requestHeaders)
    }
    // A downgrade is never wanted: the feed is a release channel, and a stale
    // `latest.yml` behind a CDN must not walk a user backwards.
    this.options.updater.allowDowngrade = false
    // Asking is automatic; installing is not. `autoInstallOnAppQuit` means a
    // downloaded update applies when the user next quits, which is the one place a
    // silent install is defensible — they have already stopped working.
    this.options.updater.autoInstallOnAppQuit = true
    const where = this.options.feed.kind === 'url' ? this.options.feed.url : 'from app-update.yml'
    this.options.log?.(
      `update: feed ${where}${this.options.route === undefined ? '' : ' (source chosen at the first check)'}, `
      + `current ${versionOf(this.options.updater)}`,
    )
    this.arm(options.immediate === true ? 0 : this.schedule.next('ok'))
  }

  /**
   * Check the feed now.
   *
   * Concurrent calls share one request: two in-flight checks would race to set the
   * phase, and the feed would be asked twice for the same answer.
   *
   * @param options.download - whether to start downloading if the check finds an update. Defaults to true,
   *   the background behaviour; a manual check passes false and asks the user first.
   * @returns the state after the check.
   */
  async check(options: { download?: boolean } = {}): Promise<UpdateState> {
    if (this.disposed) return this.state
    if (this.inFlight !== undefined) return await this.inFlight
    if (!this.hasFeed) return this.state
    this.downloadWhenFound = options.download ?? true
    this.clearTimer()
    this.inFlight = this.runCheck().finally(() => { this.inFlight = undefined })
    return await this.inFlight
  }

  /**
   * Fetch the update a previous check found.
   *
   * Separate from {@link check} so a manual check can stop at "there is one" and let the user decide. Called
   * through the renderer's carrier; a download with nothing to fetch is the updater's own error to report,
   * not something to guard against here by second-guessing the phase.
   */
  async downloadNow(): Promise<void> {
    if (this.disposed) return
    await this.download()
  }

  /**
   * Bring the update to the user's attention: a native dialog describing where
   * things stand, and — only when an update is ready — the offer to install.
   *
   * The prompt is native rather than in-page because installing restarts the
   * application: a page that asked would be destroyed by the answer.
   *
   * @param confirm - asks the user whether to restart and install; the caller
   *   supplies it so this module stays free of Electron dialogs.
   * @returns whether an install was requested.
   */
  async open(confirm: (state: UpdateState) => Promise<boolean>): Promise<boolean> {
    if (this.state.phase !== 'ready') {
      await this.check()
    }
    if (this.state.phase !== 'ready') return false
    if (!await confirm(this.state)) return false
    this.setState({ ...this.state, phase: 'installing' })
    // `isSilent` false so the installer UI shows, `isForceRunAfter` true so the
    // application comes back — a user who accepted an update expects to end up
    // where they were.
    this.options.updater.quitAndInstall(false, true)
    return true
  }

  /** Stop polling and drop listeners. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.listeners.clear()
    for (const event of EVENTS) {
      this.options.updater.on(event, (() => {}) as never)
    }
  }

  /** One check, with its outcome folded back into the schedule. */
  private async runCheck(): Promise<UpdateState> {
    this.setState({ phase: 'checking', ...(this.state.version === undefined ? {} : { version: this.state.version }) })
    // Before the first question to any feed, decide which feed to ask. The phase
    // is already `checking` so a comparison that takes a few seconds reads as a
    // slow check rather than as nothing happening.
    await this.applyRoute()
    try {
      await this.options.updater.checkForUpdates()
      this.checked = true
      this.arm(this.schedule.next('ok'))
    } catch (error) {
      this.checked = true
      this.fail('check', error)
      this.arm(this.schedule.next('failed'))
    }
    return this.state
  }

  /** Record a failure and report it. */
  private fail(operation: UpdateOperation, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.options.log?.(`update: ${operation} failed: ${message}`)
    this.setState({ phase: 'error', failedOperation: operation, message })
  }

  /**
   * Ask the router where to point the updater, and do it once.
   *
   * A failure here is logged and swallowed. Source selection is a preference: the
   * packaged feed is already a working configuration, so a router that cannot
   * answer — offline, a manifest that moved, a bug — must leave the check to run
   * against what the build carries rather than turning a preference into an outage.
   */
  private async applyRoute(): Promise<void> {
    const route = this.options.route
    if (route === undefined || this.disposed) return
    this.routed ??= (async () => {
      try {
        const chosen = await route()
        if (chosen !== undefined) this.applyFeed(chosen)
      } catch (error) {
        this.options.log?.(
          'update: source selection failed, keeping the configured feed: '
          + (error instanceof Error ? error.message : String(error)),
        )
      }
    })()
    await this.routed
  }

  /**
   * Hand a feed to the updater, when the updater can be told.
   *
   * The URL and the headers go together: `electron-updater` reads `requestHeaders`
   * to decide whether to append its cache-busting query to the manifest request, and
   * one of our hosts answers any request carrying a query with 404. Setting the URL
   * without them would point the updater at a host whose manifest it then cannot
   * fetch — a check that fails while looking correctly configured.
   *
   * @see applyHeaders, and `GITCODE_MANIFEST_HEADERS` for the case behind it.
   */
  private applyFeed(feed: UpdateFeed): void {
    if (feed.kind !== 'url') return
    this.options.updater.setFeedURL?.({ provider: 'generic', url: feed.url })
    this.applyHeaders(feed.requestHeaders)
  }

  /**
   * Give the updater the headers a host needs, or take them away.
   *
   * Absent headers assign `null` rather than being left alone, so a host that needs
   * none gets the default behaviour back even if an earlier host set some. Only one
   * routing decision is applied per run today, but a header surviving into a
   * different host's requests is exactly the kind of state that outlives its reason.
   *
   * Guarded by `!== undefined` because the field is optional on {@link UpdaterLike}:
   * a fake in a test need not have it, and neither might a future `electron-updater`.
   */
  private applyHeaders(headers: Readonly<Record<string, string>> | undefined): void {
    if (this.options.updater.requestHeaders === undefined) return
    this.options.updater.requestHeaders = headers === undefined ? null : { ...headers }
  }

  /** Replace the state and tell every listener. */
  private setState(next: UpdateState): void {
    this.state = next
    const presentation = presentUpdate(next)
    for (const listener of [...this.listeners]) {
      try {
        listener(presentation)
      } catch (error) {
        this.options.log?.(`update: a status listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Schedule the next automatic check. */
  private arm(delayMs: number): void {
    this.clearTimer()
    if (this.disposed || !this.hasFeed) return
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
    this.timer = setTimeoutFn(() => {
      this.timer = undefined
      void this.check()
    }, delayMs)
    // A pending update check must never hold the process open: Electron quits when
    // the last window closes, and a timer would turn "quit" into a wait.
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    ;(this.options.clearTimeoutFn ?? clearTimeout)(this.timer)
    this.timer = undefined
  }

  /** Wire the updater's events into state transitions. */
  private attach(): void {
    const updater = this.options.updater
    // `autoDownload` false: the download is started only when a check found
    // something, so a failed check cannot leave bytes arriving with no state to
    // show them in.
    updater.autoDownload = false
    updater.on('checking-for-update', () => {
      this.setState({ phase: 'checking' })
    })
    updater.on('update-available', ((info: { version?: string }) => {
      this.setState({ phase: 'available', ...(info?.version === undefined ? {} : { version: info.version }) })
      // `available` is a state the renderer can act on by itself, which is the point: a manual check lands
      // here and stays here until the user says to download.
      if (this.downloadWhenFound) void this.download()
    }) as never)
    updater.on('update-not-available', () => {
      // Back to `idle`, not to `error`: "you are current" is the healthy outcome.
      this.setState({ phase: 'idle' })
    })
    updater.on('download-progress', ((progress: { percent?: number }) => {
      this.setState({
        phase: 'downloading',
        ...(this.state.version === undefined ? {} : { version: this.state.version }),
        ...(progress?.percent === undefined ? {} : { percent: progress.percent }),
      })
    }) as never)
    updater.on('update-downloaded', ((info: { version?: string }) => {
      this.setState({
        // `verifying` is where the updater checks the artifact's signature and
        // hash; it is reported so a slow check does not look like a hang.
        phase: 'verifying',
        ...(info?.version === undefined ? {} : { version: info.version }),
      })
      // The check itself has already succeeded by the time this lands, so the
      // promised artifact exists and the state may say so.
      this.setState({
        phase: 'ready',
        ...(info?.version === undefined ? {} : { version: info.version }),
      })
    }) as never)
    updater.on('error', ((error: Error) => {
      // Which operation failed depends on where the phase got to; the updater's
      // error event carries no operation of its own.
      this.fail(this.state.phase === 'checking' || !this.checked ? 'check' : 'download', error)
    }) as never)
  }

  /** Fetch the available update, once. */
  private async download(): Promise<void> {
    try {
      await this.options.updater.downloadUpdate()
    } catch (error) {
      this.fail('download', error)
    }
  }
}

/** The updater events this coordinator listens to. */
const EVENTS = [
  'checking-for-update', 'update-available', 'update-not-available',
  'download-progress', 'update-downloaded', 'error',
] as const
