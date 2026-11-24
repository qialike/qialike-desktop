/**
 * The update wire shapes: what the renderer may learn about an update.
 *
 * These mirror the harness's client-side contract exactly
 * (`@deepseek-ai/dsh-client-ui-settings-general`'s `types.ts`), because the client
 * plugin that renders the status badge is upstream's and reads this shape through
 * `globalThis.dshDesktop.updates`. Nothing here is ours to redesign — a field
 * renamed on one side is a badge that silently stops updating.
 *
 * THE RENDERER LEARNS NOTHING IT COULD ACT ON. There is no artifact URL, no feed
 * address, no version to install *by choice*, and no authority to start an
 * install. A compromised renderer can ask what the shell knows and ask it to show
 * a dialog; it cannot point the updater somewhere or make it run. That is the
 * whole reason the shape is this small, and it is why `DesktopUpdateState` — the
 * richer main-process view — never crosses the boundary.
 *
 * @module @qialike/desktop/update-contract
 */

/**
 * The lifecycle the indicator renders.
 *
 * `verifying` exists because a downloaded artifact is not an installed one: the
 * updater checks a signature and a hash before the phase may advance, and a
 * status that jumped from `downloading` to `ready` would show the user a
 * completed download that then failed to install.
 */
export type UpdatePhase =
  | 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'

/**
 * What went wrong, in terms a localized message can be selected from.
 *
 * Split by operation *and* by network-vs-other because the two read completely
 * differently to a user: "could not reach the update server" is a network
 * problem they may be able to fix, "could not install" is not.
 */
export type UpdateFailureKind =
  | 'check' | 'check-network'
  | 'download' | 'download-network'
  | 'install' | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/** What crosses to the renderer. No diagnostics, no controls. */
export interface UpdatePresentation {
  readonly phase: UpdatePhase
  readonly version?: string
  readonly percent?: number
  readonly failure?: UpdateFailureKind
}

/** The operation a failure belongs to. */
export type UpdateOperation = 'check' | 'download' | 'install'

/**
 * The main process's own view, which does not cross the boundary.
 *
 * `message` is the updater's raw diagnostic. It is kept here so the shell's own
 * dialog and the log can show something actionable, and deliberately **not** in
 * {@link UpdatePresentation}: it is unlocalized, it can name internal paths, and
 * the renderer has no use for it.
 */
export interface UpdateState {
  readonly phase: UpdatePhase
  readonly version?: string
  readonly percent?: number
  readonly failure?: UpdateFailureKind
  readonly message?: string
  readonly failedOperation?: UpdateOperation
}

/**
 * Where the updater reads its feed from, when one is configured.
 *
 * Two shapes because there are two legitimate sources and they are configured
 * differently. `url` is an override (`QIALIKE_DESKTOP_UPDATE_URL`) and has to be
 * handed to the updater; `bundled` means electron-builder wrote `app-update.yml`
 * into the package from the build's `publish` config, which the updater finds on
 * its own — calling `setFeedURL` there would override a correct answer with a
 * guess.
 */
export type UpdateFeed =
  | {
    readonly kind: 'url'
    readonly url: string
    /**
     * Whether the package also carries an `app-update.yml`.
     *
     * It is not the feed source in this case, but `electron-updater` reads it
     * unconditionally while preparing a download — for `updaterCacheDirName`, the
     * staging directory — so a runtime URL with no packaged config produces a check
     * that succeeds and a download that dies with ENOENT. The shell warns about
     * that combination at startup rather than letting it surface as a failed
     * download later.
     */
    readonly packagedConfig: boolean
    /**
     * Headers the feed's manifest cannot be fetched without, if any.
     *
     * Carried with the feed rather than applied by the caller, because the caller
     * is what does not know: the requirement belongs to the host the chooser
     * picked, and it travels with it. `electron-updater` reads them from
     * `updater.requestHeaders`, which also changes how it builds the manifest URL
     * — see `GITCODE_MANIFEST_HEADERS` in `update-sources.ts` for the case that
     * made this necessary.
     */
    readonly requestHeaders?: Readonly<Record<string, string>>
  }
  | {
    readonly kind: 'bundled'
    /**
     * Headers the packaged feed's host cannot be read without, if any.
     *
     * A `bundled` feed names no URL — the updater finds `app-update.yml` itself —
     * so this is the only thing the shell can contribute to it. It is not
     * decoration: a build whose `app-update.yml` points at a host that answers
     * queries with 404 would otherwise be unable to check, with nothing about the
     * configuration looking wrong.
     */
    readonly requestHeaders?: Readonly<Record<string, string>>
  }
