/**
 * The update row — the browser half of `@qialike/qialike-desktop-update`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the theme, providers, edit-follow and office-engine halves spell
 * out: the harness's client-bundle preset is unpublished, and the artifact contract is small enough to write
 * directly —
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * — so this is plain JavaScript with `React.createElement` and no JSX, and it requires nothing but `react`.
 *
 * WHAT IT IS FOR, AND WHY A SECOND UPDATE SURFACE. Upstream already ships one: a badge on the sidebar toggle
 * that appears when an update exists. It is passive by construction — it can only speak when there is
 * something to say — so a user who wants to ask "am I up to date?", which is the question people actually
 * have, has nowhere to ask it. This row is that place, next to the version it is about.
 *
 * WHY IT ASKS BEFORE DOWNLOADING. `open()` on the shell's carrier checks and downloads in one motion, which is
 * right for the background badge: the bytes are wanted either way, and the user is told when they have
 * arrived. Here the user asked a question, not for a transaction, and silently starting a ~200 MB download on
 * a metered connection is the kind of thing people are right to be angry about. So this row calls `check()`
 * — the shell's check-without-download — and offers the download as its own button.
 *
 * WHY IT CANNOT SIMPLY RENDER `status()`. The carrier reports what the updater is doing, not what this row
 * asked. `idle` means both "nothing has been checked yet" and "you are up to date", and those need different
 * sentences: the first is a row waiting to be used, the second is an answer. The difference is not in the
 * carrier — it is that a check was requested and came back — so this row remembers that it asked, and only
 * then is `idle` allowed to mean "you are current".
 *
 * @module @qialike/qialike-desktop-update/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-update',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-update'

    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      row: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0' },
      title: { fontWeight: 600 },
      description: { fontSize: '12px', ...muted },
      note: { fontSize: '12px', ...muted },
      alert: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #d33)' },
      field: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      control: { padding: '4px 10px', cursor: 'pointer' },
      meter: { height: '4px', width: '160px', background: 'var(--dsw-alias-bg-layer-2, #e5e5e5)', borderRadius: '2px' },
      meterFill: { height: '4px', background: 'var(--dsw-alias-label-primary, #333)', borderRadius: '2px' },
      section: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0', fontSize: '13px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600 },
    }

    const en = {
      title: 'Application update',
      description: 'Check whether a newer version of this application is available.',
      check: 'Check for updates',
      checking: 'Checking for updates…',
      upToDate: 'You have the latest version.',
      available: 'Version {version} is available.',
      download: 'Download',
      downloading: 'Downloading: {percent}%',
      downloadingUnknown: 'Downloading…',
      verifying: 'Verifying the download…',
      ready: 'Version {version} has been downloaded.',
      install: 'Install and restart',
      installing: 'Preparing to restart…',
      failed: 'The update could not be completed. Try again.',
      failedDetail: 'The update could not be completed: {message}',
      unsupported: 'This build has no update channel, so updates cannot be checked.',
      sectionTitle: 'Application update',
      version: 'Current version: {version}',
      versionUnknown: 'Current version: unknown',
    }
    const zh = {
      title: '应用更新',
      description: '检查本应用是否有新版本。',
      check: '检查更新',
      checking: '正在检查更新…',
      upToDate: '已是最新版本。',
      available: '发现新版本 {version}。',
      download: '下载',
      downloading: '正在下载：{percent}%',
      downloadingUnknown: '正在下载…',
      verifying: '正在校验下载内容…',
      ready: '版本 {version} 已下载完成。',
      install: '安装并重启',
      installing: '正在准备重启…',
      failed: '更新未能完成，请重试。',
      failedDetail: '更新未能完成：{message}',
      unsupported: '本构建没有更新通道，无法检查更新。',
      sectionTitle: '应用更新',
      version: '当前版本：{version}',
      versionUnknown: '当前版本：未知',
    }

    /** The update carrier the preload installs; absent in a browser build, which this row says out loud. */
    function carrier() {
      const updates = globalThis.dshDesktop?.updates
      return typeof updates?.status === 'function' ? updates : undefined
    }

    /**
     * This product's version, asked of the shell that owns it.
     *
     * WHY NOT THE CONSTANT THE UPSTREAM ROW READS. `CurrentVersionRow` prints
     * `process.env.DSH_CLIENT_VERSION`, which this build patches at assembly time. That is a
     * value baked into the bundle, so it can only ever be as right as the last build — while
     * the shell knows the version it is actually running, from `app.getVersion()`. The
     * section is the one place a person checks "what am I on", so it asks the live source and
     * falls back to saying it does not know rather than to a stale number.
     *
     * Absent outside Electron: a plain browser has no `dshDesktopBoot`, and there the honest
     * answer is `versionUnknown`.
     *
     * @returns the version, or `undefined` until the shell answers.
     */
    function useProductVersion() {
      const [version, setVersion] = React.useState(undefined)
      React.useEffect(() => {
        const boot = globalThis.dshDesktopBoot
        if (typeof boot?.ready !== 'function') return undefined
        let live = true
        Promise.resolve(boot.ready()).then(
          (payload) => { if (live) setVersion(typeof payload?.version === 'string' ? payload.version : undefined) },
          () => { if (live) setVersion(undefined) },
        )
        return () => { live = false }
      }, [])
      return version
    }

    /**
     * The section body: the version this build is on, then what can be done about it.
     *
     * The controls are the same `UpdateRow` that used to sit in General, unchanged — only its
     * place in the tree moved. Its own note about not repeating the version is now satisfied
     * by rendering the version one line above, from a live source.
     */
    function SectionBody({ t }) {
      const version = useProductVersion()
      return h('div', { style: styles.section },
        h('h2', { style: styles.heading }, t('sectionTitle')),
        h('p', { style: styles.description }, version === undefined ? t('versionUnknown') : t('version', { version })),
        h(UpdateRow, { t }))
    }

    function UpdateRow({ t }) {
      // `null` until the first `status()` answers: "unknown" and "idle" are different, and rendering the row
      // as if it knew would flash "you are up to date" at every mount.
      const [state, setState] = React.useState(null)
      const [asked, setAsked] = React.useState(false)
      const [missing, setMissing] = React.useState(false)

      React.useEffect(() => {
        const updates = carrier()
        if (updates === undefined) { setMissing(true); return undefined }
        let live = true
        if (typeof updates.status === 'function') {
          Promise.resolve(updates.status()).then(
            (presentation) => { if (live) setState(presentation ?? { phase: 'idle' }) },
            () => { if (live) setState({ phase: 'idle' }) },
          )
        }
        // Every transition arrives here, so the row never polls and the progress meter is the updater's own.
        const detach = typeof updates.subscribe === 'function'
          ? updates.subscribe((presentation) => { if (live) setState(presentation ?? { phase: 'idle' }) })
          : undefined
        return () => {
          live = false
          if (typeof detach === 'function') detach()
        }
      }, [])

      const phase = state?.phase ?? 'idle'
      const version = state?.version
      const busy = phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'installing'

      const check = () => {
        setAsked(true)
        const updates = carrier()
        if (updates === undefined) return
        // Fire and forget: the answer arrives through `subscribe`, and a rejection is reported by the shell as
        // a phase transition rather than as a promise this row would have to render twice.
        void Promise.resolve(updates.check()).catch(() => {})
      }
      const download = () => {
        const updates = carrier()
        if (updates === undefined) return
        void Promise.resolve(updates.download()).catch(() => {})
      }
      const install = () => {
        const updates = carrier()
        if (updates === undefined) return
        // `open()` is the shell's own confirm-then-install path, and it is the right one here: installing
        // restarts the application, so the shell asks in a native dialog rather than in the page it destroys.
        void Promise.resolve(updates.open()).catch(() => {})
      }

      // The version itself is NOT repeated here. The settings shell already renders a version row in this
      // same list (order 100), and the build points it at this product's version — so printing it again would
      // be a second copy of one fact, in the one place where a disagreement would be visible to the user.
      const lines = []
      let control = null
      if (phase === 'checking') {
        lines.push(h('div', { key: 'checking', style: styles.note, role: 'status' }, t('checking')))
      } else if (phase === 'available') {
        lines.push(h('div', { key: 'available', style: styles.note, role: 'status' },
          t('available', { version: version ?? '' })))
        control = h('button', { type: 'button', onClick: download, style: styles.control }, t('download'))
      } else if (phase === 'downloading') {
        const percent = state?.percent
        lines.push(h('div', { key: 'downloading', style: styles.note, role: 'status' },
          percent === undefined ? t('downloadingUnknown') : t('downloading', { percent: Math.round(percent) })))
        if (percent !== undefined) {
          lines.push(h('div', { key: 'meter', style: styles.meter },
            h('div', { style: { ...styles.meterFill, width: `${String(Math.round(percent))}%` } })))
        }
      } else if (phase === 'verifying' || phase === 'installing') {
        lines.push(h('div', { key: 'verifying', style: styles.note, role: 'status' },
          phase === 'installing' ? t('installing') : t('verifying')))
      } else if (phase === 'ready') {
        lines.push(h('div', { key: 'ready', style: styles.note, role: 'status' },
          t('ready', { version: version ?? '' })))
        control = h('button', { type: 'button', onClick: install, style: styles.control }, t('install'))
      } else if (phase === 'error') {
        const message = state?.message
        lines.push(h('div', { key: 'failed', style: styles.alert, role: 'alert' },
          message === undefined ? t('failed') : t('failedDetail', { message })))
      } else if (asked) {
        // ONLY after a check came back may `idle` be read as an answer. Before that it is the state of a row
        // nobody has used, and saying "you are up to date" would be a claim nothing has checked.
        lines.push(h('div', { key: 'current-answer', style: styles.note, role: 'status' }, t('upToDate')))
      }

      if (missing) {
        lines.push(h('div', { key: 'unsupported', style: styles.note }, t('unsupported')))
      } else if (!busy && control === null) {
        control = h('button', { type: 'button', onClick: check, style: styles.control }, t('check'))
      }

      return h('div', { style: styles.row },
        h('div', { style: styles.title }, t('title')),
        h('div', { style: styles.description }, t('description')),
        lines,
        control === null ? null : h('div', { style: styles.field }, control))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }))
      /** Bound once: the nav label thunk resolves it per projection, so it must not re-bind. */
      const t = ctx.locale.bind(NS)
      // `inject` rather than a bare register: a slot exists only while the entry that declares it is mounted,
      // and registering into an undeclared slot throws. The settings shell declares this one and may mount
      // after us.
      // ── the update section ─────────────────────────────────────────────────
      //
      // A column of its own rather than a row inside General, because the subject is the
      // application itself: the version it is on and whether a newer one exists. That is a
      // question people open Settings to ask, and it is not a preference.
      //
      // ORDER 30 puts it after `agent-presets` (20). The nav reads General (0), Appearance
      // (10), the plugins list, Models (20) and presets (20); this is the last of them
      // because it is about the thing containing the others.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qialike-updates',
        order: 30,
        // A thunk, resolved per projection, so the nav row follows the language without the
        // entry being re-registered.
        label: () => t('sectionTitle'),
        locale: NS,
      }, SectionBody))

      // ── retire the version row that used to sit in General ────────────────
      //
      // `current-version` belongs to `ui-settings-general`, which owns the General section and
      // therefore cannot be disabled. A list slot resolves a cell by `id` and renders the entry
      // with the LOWEST priority — the guard that refuses two equal priorities says so in its
      // own message: "register at a different priority to shadow it (lowest renders)". So a
      // `-1` placeholder takes the cell and renders nothing, and the version is printed by the
      // section above instead of twice, in the one place where a disagreement would show.
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'current-version',
        priority: -1,
        locale: NS,
      }, () => null))
    }

    // `slots` and `locale` are SERVICE names, and that is not the same vocabulary as the package names in
    // `package.json`'s `dsh.client.inject` — that one orders the bundles, this one waits on services. The
    // first version of this file used the package names here, copied from the manifest. The entry then never
    // activated — it sat `pending (waiting for services: @deepseek-ai/dsh-client-ui-settings, …)` — and the
    // harness's web boot treats one pending entry as a FAILED boot, so the whole client stayed on
    // "Loading plugins…" and every downstream check in the end-to-end suite went red. A row that cannot find
    // its services does not degrade to a missing row; it takes the application with it.
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
