/**
 * The office-engine row — the browser half of `@qialike/qialike-desktop-office-engine`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the theme, providers and edit-follow halves spell out: the
 * harness's client-bundle preset is unpublished, and the artifact contract is small enough to write
 * directly —
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * — so this is plain JavaScript with `React.createElement` and no JSX, and it requires nothing but
 * `react`. In particular it imports no harness module: the file-address grammar and the slot names
 * are the only upstream facts it uses, and both are strings.
 *
 * WHAT IT IS FOR. A build can leave the LibreOffice engine out, and then the document preview's
 * Office renderer cannot start — the kit answers `ConversionError('unavailable')` and the preview
 * says so. That message is upstream's and is not a control, so this row is the control: it says
 * which state the engine is in, and installs one when the user asks. It deliberately offers nothing
 * when the engine is already there, so the same row is correct for a tree that bundles it.
 *
 * WHY IT SHOWS A SIZE BEFORE INSTALLING. 46 MiB is a decision, not a detail, and a button that
 * starts one without saying so is the kind of thing a user is right to be annoyed by. The number
 * comes from the registry's own metadata (`plan`), never from a constant here — an engine update
 * would make a constant wrong, and wrong in the direction of understating a download.
 *
 * @module @qialike/qialike-desktop-office-engine/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-office-engine',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * The Host route serving the engine's state and its install.
     *
     * DOCUMENT-RELATIVE, with no leading slash: the served document carries `<base href="./">`, so a
     * root-absolute literal would resolve against the origin instead of the document and break the
     * moment the surface is mounted under a prefix.
     */
    const API = 'api/qialike/office-engine'

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-office-engine'

    /**
     * How often the row asks the Host how an install is going.
     *
     * Not a progress channel: the phases are coarse (`downloading`, `verifying`, `unpacking`) and
     * the byte count within `downloading` moves on this interval rather than per chunk. Polling a
     * local route twice a second costs nothing next to the download it is reporting.
     */
    const POLL_MS = 500

    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      row: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 0' },
      title: { fontWeight: 600 },
      description: { fontSize: '12px', ...muted },
      note: { fontSize: '12px', ...muted },
      alert: { fontSize: '12px', color: 'var(--dsw-alias-label-error, #d33)' },
      field: { display: 'flex', alignItems: 'center', gap: '8px' },
      control: { padding: '4px 10px', cursor: 'pointer' },
      meter: { height: '4px', background: 'var(--dsw-alias-bg-layer-2, #e5e5e5)', borderRadius: '2px' },
      meterFill: { height: '4px', background: 'var(--dsw-alias-label-primary, #333)', borderRadius: '2px' },
    }

    const en = {
      'title': 'Office previews',
      'description': 'Word, Excel and PowerPoint files need a document engine. It is a large download, so it is not part of the installation.',
      'bundled': 'Included in this installation.',
      'installed': 'Installed and ready.',
      'missing': 'Not installed. Office documents cannot be previewed until it is.',
      'install': 'Install the document engine',
      'installWithSize': 'Install the document engine ({size})',
      'checking': 'Checking\u2026',
      'loadFailed': 'Could not read the engine\u2019s state from the host.',
      'retry': 'Retry',
      'planning': 'Asking the registry\u2026',
      'planFailed': 'Could not reach the registry: {message}',
      'phase.resolving': 'Contacting the registry\u2026',
      'phase.downloading': 'Downloading\u2026 {received}',
      'phase.downloadingOf': 'Downloading\u2026 {received} of {total}',
      'phase.verifying': 'Checking the download\u2026',
      'phase.unpacking': 'Unpacking\u2026',
      'phase.done': 'Installed and ready. Open the document again to preview it.',
      'phase.failed': 'Installation failed: {message}',
      'restartHint': 'The engine is installed but this run could not pick it up; it will be used after restarting.',
      'probing': 'Checking that the engine can start\u2026',
      'runtimeMissing': 'This engine cannot start. It needs the Microsoft Visual C++ 2015-2022 Redistributable (x64), which is not installed.',
      'runtimeOutdated': 'This engine cannot start. It needs a newer Microsoft Visual C++ 2015-2022 Redistributable (x64) than the one on this computer \u2014 a runtime that is present but older than the toolset behind the engine fails the same way as a missing one.',
      'runtimeMissingList': 'Missing: {names}',
      'runtimeOutcome': 'The engine reported: {outcome}',
      'runtimeNothingElse': 'Nothing else is affected: the engine is a separate process, so the rest of the application works as usual.',
      'getRuntime': 'Download the Visual C++ runtime',
      'unverified': 'The engine is installed, but it did not report whether it can start.',
    }

    const zh = {
      'title': 'Office 预览',
      'description': 'Word、Excel 与 PowerPoint 文件需要一个文档引擎。它体积很大，因此不随安装包一起提供。',
      'bundled': '本次安装已内置。',
      'installed': '已安装，可使用。',
      'missing': '尚未安装。安装之前无法预览 Office 文档。',
      'install': '安装文档引擎',
      'installWithSize': '安装文档引擎（{size}）',
      'checking': '读取中\u2026',
      'loadFailed': '无法从宿主读取引擎状态。',
      'retry': '重试',
      'planning': '正在询问软件源\u2026',
      'planFailed': '无法访问软件源：{message}',
      'phase.resolving': '正在连接软件源\u2026',
      'phase.downloading': '正在下载\u2026 {received}',
      'phase.downloadingOf': '正在下载\u2026 {received} / {total}',
      'phase.verifying': '正在校验下载内容\u2026',
      'phase.unpacking': '正在解包\u2026',
      'phase.done': '已安装，可使用。重新打开文档即可预览。',
      'phase.failed': '安装失败：{message}',
      'restartHint': '引擎已安装，但本次运行未能加载它；重启后生效。',
      'probing': '正在检查引擎能否启动\u2026',
      'runtimeMissing': '这个引擎无法启动。它需要 Microsoft Visual C++ 2015-2022 运行库（x64），而本机没有安装。',
      'runtimeOutdated': '这个引擎无法启动。它需要比本机更新的 Microsoft Visual C++ 2015-2022 运行库（x64）——装着的运行库若比构建引擎的工具链旧，失败方式与没装完全一样。',
      'runtimeMissingList': '缺少：{names}',
      'runtimeOutcome': '引擎报告：{outcome}',
      'runtimeNothingElse': '其余功能不受影响：引擎是独立进程，应用照常使用。',
      'getRuntime': '下载 Visual C++ 运行库',
      'unverified': '引擎已安装，但它没有报告自己能否启动。',
    }

    /** Bytes as something a person reads, rather than a count of bytes. */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
      const mib = bytes / 1048576
      if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`
      if (mib >= 10) return `${mib.toFixed(0)} MB`
      return `${mib.toFixed(1)} MB`
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'qialike-office-engine: dictionaries')
      const t = ctx.locale.bind(NS)

      /** What the row renders. Replaced, never mutated in place, so React re-renders. */
      let view = {
        loading: true,
        failed: false,
        status: undefined,
        plan: undefined,
        planning: false,
        planFailure: undefined,
        probe: undefined,
        probing: false,
        probed: false,
      }
      const listeners = new Set()
      const setView = (patch) => {
        view = { ...view, ...patch }
        for (const listener of [...listeners]) listener()
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      /** Ask the Host what the engine's state is. */
      async function load() {
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => undefined)
          if (!response.ok || body?.ok !== true) {
            setView({ loading: false, failed: true })
            return
          }
          setView({ loading: false, failed: false, status: body })
        } catch {
          setView({ loading: false, failed: true })
        }
      }

      /**
       * Ask what installing would cost, and how big it is.
       *
       * Called when the row first renders in the `missing` state, so the button can name the size
       * before anyone commits to it, and again by the button if that first attempt failed — the
       * network is the only thing that can fail here, and retrying it is a click, not a reload.
       */
      async function plan() {
        if (view.planning) return
        setView({ planning: true, planFailure: undefined })
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'plan' }),
          })
          const body = await response.json().catch(() => undefined)
          if (!response.ok || body?.ok !== true) {
            setView({ planning: false, planFailure: body?.message ?? `HTTP ${String(response.status)}` })
            return
          }
          setView({ planning: false, plan: body })
        } catch (error) {
          setView({ planning: false, planFailure: error instanceof Error ? error.message : String(error) })
        }
      }

      let poll
      /** Follow an install to its end, then stop and re-read the state. */
      function watch() {
        if (poll !== undefined) return
        poll = setInterval(() => {
          void (async () => {
            const response = await fetch(API, { headers: { accept: 'application/json' } }).catch(() => undefined)
            const body = await response?.json?.().catch(() => undefined)
            if (body?.ok !== true) return
            setView({ status: body })
            const phase = body.install?.phase
            if (phase !== 'done' && phase !== 'failed') return
            clearInterval(poll)
            poll = undefined
            // The engine on disk is a different file now, so the answer that belonged to the old one
            // is discarded rather than shown against the new one.
            if (phase === 'done') void probe()
          })()
        }, POLL_MS)
      }

      /**
       * Ask the Host whether the engine it just reported can actually start.
       *
       * WHY THE PRESENCE OF A PACKAGE IS NOT THE ANSWER. An installed engine still fails to start on
       * a machine whose Microsoft Visual C++ runtime is missing or older than the toolset that built
       * the engine — measured on 2026-10-22 against 14.36.32532, where every required DLL resolved
       * and the loader faulted inside MSVCP140.dll. Without this question the row would say
       * "Installed and ready" over an engine that cannot open a single document.
       *
       * Asked only for an engine that exists, because there is nothing to run in the `missing` state,
       * and once per state rather than on every poll: the Host caches it, but the panel should not
       * depend on that.
       */
      async function probe() {
        if (view.probing) return
        setView({ probing: true, probe: undefined, probed: true })
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'probe' }),
          })
          const body = await response.json().catch(() => undefined)
          if (!response.ok || body?.ok !== true) {
            setView({ probing: false })
            return
          }
          setView({ probing: false, probe: body })
        } catch {
          setView({ probing: false })
        }
      }

      /** Ask the Host to install, and start following it. */
      async function install() {
        try {
          await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'install' }),
          })
          watch()
        } catch {
          // The poll will not see a job that never started, so the failure is reported here rather
          // than left as a button that appears to do nothing.
          setView({ planFailure: 'request failed' })
        }
      }

      void load()

      function EngineRow() {
        const [state, setState] = React.useState(view)
        React.useEffect(() => {
          setState(view)
          return subscribe(() => { setState(view) })
        }, [])

        // Asked once, when the row learns there is something to install. `plan` is idempotent on the
        // Host side and cheap, but the guard keeps a re-render from being a second request.
        const [asked, setAsked] = React.useState(false)
        React.useEffect(() => {
          if (asked || state.loading || state.failed) return
          if (state.status?.mode !== 'missing') return
          setAsked(true)
          void plan()
        }, [state.loading, state.failed, state.status?.mode, asked])

        // The other half of the same question: an engine that is present still has to be asked
        // whether it runs. Once, and only for a mode that names an engine on disk.
        const [askedProbe, setAskedProbe] = React.useState(false)
        React.useEffect(() => {
          if (askedProbe || state.loading || state.failed) return
          const mode = state.status?.mode
          if (mode !== 'bundled' && mode !== 'installed') return
          setAskedProbe(true)
          void probe()
        }, [state.loading, state.failed, state.status?.mode, askedProbe])

        if (state.loading) {
          return h('div', { style: styles.row }, h('div', { style: styles.description }, t('checking')))
        }
        if (state.failed) {
          return h('div', { style: styles.row },
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.alert, role: 'alert' }, t('loadFailed')),
            h('button', { type: 'button', onClick: () => { void load() }, style: styles.control }, t('retry')))
        }

        const status = state.status ?? {}
        const job = status.install ?? { phase: 'idle' }
        const installing = job.phase !== 'idle' && job.phase !== 'done' && job.phase !== 'failed'
        const notes = []

        // The verdict on whether the engine actually runs, which the mode alone cannot give.
        //
        // IT DECIDES WHAT THE LINE ABOVE MAY SAY. "Installed and ready" over an engine that cannot
        // start is the sentence this whole check exists to stop: measured on 2026-10-22 with
        // 14.36.32532 installed, every required DLL resolved and the loader faulting inside
        // MSVCP140.dll. So a broken engine gets no positive line at all.
        const engine = state.probe
        const broken = engine?.kind === 'broken'

        if (status.mode === 'bundled') {
          if (!broken) notes.push(h('div', { key: 'state', style: styles.note, role: 'status' }, t('bundled')))
        } else if (status.mode === 'installed') {
          if (!broken) notes.push(h('div', { key: 'state', style: styles.note, role: 'status' }, t('installed')))
        } else {
          notes.push(h('div', { key: 'state', style: styles.note, role: 'status' }, t('missing')))
        }

        if (state.probing && status.mode !== 'missing') {
          notes.push(h('div', { key: 'probing', style: styles.note, role: 'status' }, t('probing')))
        }
        if (broken) {
          // TWO FAILURES, ONE SILENCE. An absent redistributable and one older than the toolset that
          // built the engine both leave an engine that prints nothing, so the verdict comes from
          // `missing` — the loader's own answer — and the exit code is quoted for whoever has to act
          // on it.
          const outdated = (engine.missing ?? []).length === 0
          notes.push(h('div', { key: 'runtime', style: styles.alert, role: 'alert' },
            outdated ? t('runtimeOutdated') : t('runtimeMissing')))
          if (!outdated) {
            notes.push(h('div', { key: 'runtimeMissing', style: styles.note },
              t('runtimeMissingList', { names: (engine.missing ?? []).join(', ') })))
          }
          if (typeof engine.outcome === 'string' && engine.outcome !== '') {
            notes.push(h('div', { key: 'runtimeOutcome', style: styles.note },
              t('runtimeOutcome', { outcome: engine.outcome })))
          }
          notes.push(h('div', { key: 'runtimeScope', style: styles.note }, t('runtimeNothingElse')))
          // An ordinary external link: the shell hands http(s) to the user's browser, which downloads
          // the installer and leaves running it to the user. Nothing here executes it, and nothing
          // here elevates.
          if (typeof engine.redistUrl === 'string' && engine.redistUrl !== '') {
            notes.push(h('div', { key: 'runtimeFix', style: styles.field },
              h('a', {
                href: engine.redistUrl,
                target: '_blank',
                rel: 'noreferrer',
                style: { fontSize: '12px' },
              }, t('getRuntime'))))
          }
        } else if (state.probed === true && engine === undefined && !state.probing && status.mode !== 'missing') {
          // The question was asked and no answer came back — a Host that could not resolve the
          // adapter, or a request that failed. Said plainly rather than folded into "ready".
          notes.push(h('div', { key: 'unverified', style: styles.note }, t('unverified')))
        }

        if (installing) {
          const received = humanBytes(job.received)
          const total = humanBytes(job.total)
          notes.push(h('div', { key: 'phase', style: styles.note, role: 'status' },
            received === undefined
              ? t(`phase.${job.phase}`)
              : total === undefined
                ? t('phase.downloading', { received })
                : t('phase.downloadingOf', { received, total })))
          // A meter only when both ends are known: a bar without a total is a decoration.
          if (job.phase === 'downloading' && typeof job.total === 'number' && job.total > 0) {
            const ratio = Math.max(0, Math.min(1, job.received / job.total))
            notes.push(h('div', { key: 'meter', style: styles.meter },
              h('div', { style: { ...styles.meterFill, width: `${String(Math.round(ratio * 100))}%` } })))
          }
        }
        if (job.phase === 'done') {
          notes.push(h('div', { key: 'done', style: styles.note, role: 'status' }, t('phase.done')))
          // `wired: false` is the one outcome the user has to act on, so it is stated rather than
          // left as "installed" and a preview that still refuses.
          if (job.wired === false) {
            notes.push(h('div', { key: 'restart', style: styles.alert, role: 'alert' }, t('restartHint')))
          }
        }
        if (job.phase === 'failed') {
          notes.push(h('div', { key: 'failed', style: styles.alert, role: 'alert' },
            t('phase.failed', { message: job.failure ?? '' })))
        }
        if (state.planning) {
          notes.push(h('div', { key: 'planning', style: styles.note }, t('planning')))
        }
        if (state.planFailure !== undefined) {
          notes.push(h('div', { key: 'planFailed', style: styles.alert, role: 'alert' },
            t('planFailed', { message: state.planFailure })))
        }

        // The control exists only when there is something to do. A button that installs an engine
        // the tree already carries would download 46 MiB to shadow it.
        const size = humanBytes(state.plan?.downloadBytes)
        const control = status.mode === 'missing'
          ? h('div', { style: styles.field },
            h('button', {
              type: 'button',
              disabled: installing || state.planning,
              onClick: () => { void install() },
              style: { ...styles.control, opacity: installing || state.planning ? 0.6 : 1 },
            }, size === undefined ? t('install') : t('installWithSize', { size })))
          : null

        // A tab body, so it carries its own heading: in General the row was read as part of a
        // list, and a page needs to say what it is about.
        return h('div', { style: styles.section },
          h('h2', { style: styles.heading }, t('title')),
          h('div', { style: styles.description }, t('description')),
          control,
          notes)
      }

      // A TAB IN THE PLUGINS SECTION, not a row in General.
      //
      // The engine is a plugin-shaped dependency: it is not installed with the application, it
      // is fetched on demand, and what a user needs to know is whether the plugin is present.
      // That is the question the plugins page answers, and General is a list of preferences.
      //
      // `settings.plugins.tab` is what that page projects from — the list it renders tab
      // buttons for when there is more than one. The settings shell declares the slot; the
      // plugins section owns the tab bar.
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'qialike-office-engine',
        // After the shipped tabs (`plugins` at 1, `all` at 10) so the catalogue stays first.
        order: 20,
        // A thunk, resolved per projection, so the tab follows the language without the entry
        // being re-registered.
        label: () => t('title'),
        locale: NS,
      }, EngineRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
