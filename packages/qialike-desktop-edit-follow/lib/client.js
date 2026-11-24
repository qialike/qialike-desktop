/**
 * The edit-follow row — the browser half of `@qialike/qialike-desktop-edit-follow`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the theme and providers halves spell out: the
 * harness's client-bundle preset is unpublished, and the artifact contract is small
 * enough to write directly —
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * — so this is plain JavaScript with `React.createElement` and no JSX, and it requires
 * nothing but `react`. In particular it imports **no** harness module, even where one
 * would do the job: `@deepseek-ai/dsh-util-workspace-path` owns the file-address grammar
 * and `ui-deliverables` owns the mutation-path rule. Both are re-expressed below, in a
 * few lines each. That is the deliberate cost of a surface that an upstream refactor
 * cannot break — the alternative reaches into internal modules that no client bundle is
 * meant to import.
 *
 * WHAT IT DOES. When the agent edits a file, move the right Sidebar's document preview
 * to that file. The feature has two halves and only one of them is code: a preview that
 * is *already open* reloads itself when its file changes, because the document-preview
 * tab subscribes to the file resource — MEASURED, for external writes as well as tool
 * writes (analysis document §10). What is missing upstream is *navigation*: nothing
 * moves the preview to a file the agent starts editing. That is this plugin.
 *
 * WHY IT READS THE CHAT SNAPSHOT INSTEAD OF REGISTERING A SLOT. `tool.call.toolview` is
 * a keyed slot: claiming `write`/`edit` there would REPLACE the harness's own
 * `file-mutation-row`, so this row would have to reimplement the diff card and would
 * break whenever that card changed. Instead it reads `ChatSnapshot.nodes.values()`, the
 * published observable snapshot the chat nodes are rendered from, and takes the tool
 * calls out of it. Nothing is registered, nothing enters the transcript, and the only
 * upstream fact relied on is a documented read accessor.
 *
 * THE THREE QUIETING RULES, WHICH ARE REQUIREMENTS AND NOT OPTIONS. Following is ON by
 * default, and that is only defensible because of them:
 *
 *   1. NEVER WHILE THE COLUMN IS COLLAPSED. `openResource` expands the column in the
 *      same step, so following a collapsed column would rearrange the window. A
 *      collapsed column means the user is not looking; we stay out.
 *   2. STOP WHEN THE USER TAKES OVER. If the active tab is not the one this plugin last
 *      opened, the user has chosen something to look at and we stop. Following resumes
 *      at the next turn, or when the switch is turned off and on again.
 *   3. NEVER FOR SUBAGENTS. A subagent runs in its own Session, so its calls are not in
 *      this Session's chat snapshot at all — the data source makes that structural
 *      rather than a check. Following subagents needs a second directory channel and a
 *      non-preemptive prompt, and is not built yet.
 *
 * WHY THE DEBOUNCE IS NOT ABOUT STREAMING. The conversation assembly already coalesces
 * high-frequency stream updates across three paint opportunities, so this bundle is not
 * called per token. The debounce exists to pick the FINAL target of a run of edits: a
 * turn that rewrites thirty files should land on the last one, not flicker through all
 * thirty. A window holding more distinct targets than {@link MAX_TARGETS} therefore does
 * not navigate at all.
 *
 * @module @qialike/qialike-desktop-edit-follow/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-edit-follow',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * The Host route serving the stored switch.
     *
     * DOCUMENT-RELATIVE, with no leading slash: the served document carries
     * `<base href="./">`, so a root-absolute literal would resolve against the origin
     * instead of the document and break the moment the surface is mounted under a prefix.
     */
    const API = 'api/qialike/edit-follow'

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-edit-follow'

    /**
     * How long a run of edits may keep arriving before one target is chosen.
     *
     * Not a latency budget — nothing waits on it. See the module note.
     */
    const DEBOUNCE_MS = 400

    /**
     * Distinct targets in one window above which nothing is followed.
     *
     * A run touching more files than this has no single "file being edited", and picking
     * one would be a guess dressed as a feature. Three is where a small related set (a
     * component and its test, say) still reads as one intent.
     */
    const MAX_TARGETS = 3

    /** How many handled call ids to remember. Bounded, because a Session never ends. */
    const SEEN_LIMIT = 500

    /**
     * How many subagent edits the notice names before it stops listing them.
     *
     * A subagent run can touch many files, and a notice that grows without bound is the
     * preemption it exists to avoid, moved from the preview to the header.
     */
    const NOTICE_LIMIT = 3

    /**
     * What following is when the Host could not be asked.
     *
     * NOT the Host's default: the default is what the Host answers when the document does
     * not say, which is a real answer. A failed request is no answer at all, and following
     * an agent while a user who turned the feature off waits for a retry is the worse of
     * the two ways to be wrong.
     */
    const ENABLED_WHEN_UNKNOWN = false

    // ── path extraction ───────────────────────────────────────────────────────
    //
    // Upstream's rule (`ui-deliverables`'s `mutationPath`), re-expressed, and STRICTER
    // than "the call mentions a path": a call whose required arguments are missing or
    // malformed cannot have changed the file, so it must not move the preview. `edit`
    // additionally requires `old_string` to be non-empty and different from `new_string`
    // — exactly what the tool validates before writing.

    /**
     * Parse a tool call's model-produced arguments.
     *
     * @param argsRaw - the raw JSON text, or anything else.
     * @returns the parsed object, or undefined when it is not one.
     */
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return undefined
      let parsed
      try {
        parsed = JSON.parse(argsRaw)
      } catch {
        // A truncated or non-JSON argument string names no file we can trust.
        return undefined
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return parsed
    }

    /** A non-empty string as a path, or null. */
    function pathValue(value) {
      return typeof value === 'string' && value.trim() !== '' ? value : null
    }

    /** Whether an `edit` call carries the arguments its execution requires. */
    function validEditArgs(args) {
      return typeof args.old_string === 'string' && args.old_string.length > 0
        && typeof args.new_string === 'string' && args.old_string !== args.new_string
        && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
    }

    /**
     * The path a tool call changes, or null when it changes none.
     *
     * `delete` and `move` are deliberately absent: they are this repository's own tools,
     * and the file they name may no longer exist by the time we act, so opening a preview
     * on it would show a read failure rather than the agent's work. Reporting them belongs
     * with the subagent prompt, which is not built yet.
     *
     * @param name - wire tool name.
     * @param argsRaw - model-produced JSON arguments.
     * @returns the path to follow, or null.
     */
    function mutationPath(name, argsRaw) {
      const args = parseArgs(argsRaw)
      if (args === undefined) return null
      switch (name) {
        // `write` without a content string is a rejected call, not an empty file.
        case 'write':
          return typeof args.content === 'string' ? pathValue(args.file_path) : null
        case 'edit':
          return validEditArgs(args) ? pathValue(args.file_path) : null
        // The Claude-Code-shaped editor tool the harness also ships. Only a complete
        // mutating command names a file: `view` and a bare command change nothing.
        case 'str_replace_editor':
          if (args.command !== 'create' && args.command !== 'str_replace' && args.command !== 'insert') return null
          return pathValue(args.path)
        default:
          return null
      }
    }

    /**
     * The files a `present` call declares as the turn's deliverables.
     *
     * WHY THIS IS SEPARATE FROM {@link mutationPath}, AND WHY IT WAS MISSING. The follow
     * loop watched the three tools that *perform* a write, so it followed the scripts and
     * intermediate files an agent creates — and then stopped, because the file the user
     * actually wanted was produced by RUNNING one of those scripts. Nothing names it: a
     * renderer writes its output from inside a shell call, so there is no `write`, no
     * `edit`, and no path in any argument list. Reported exactly that way: the process
     * files opened, the final one did not.
     *
     * `present` is the harness's own answer to this — its description is "Declare existing
     * files as final deliverables for the user", and its README names files created through
     * shell commands as the motivating case. It is mounted by the `standard` agent preset,
     * which this profile runs, so no composition change is needed; what was missing is that
     * nothing on our side listened to it.
     *
     * Ordered as declared: the tool documents `files` as "the 1-2 most important
     * deliverables", so the client opens them in that order and the last one ends up on
     * top, matching the debounce rule that the last target of a run wins.
     *
     * @param name - wire tool name.
     * @param argsRaw - model-produced JSON arguments.
     * @returns the declared paths, empty when the call declares none.
     */
    function presentedPaths(name, argsRaw) {
      if (name !== 'present') return []
      const args = parseArgs(argsRaw)
      if (args === undefined || !Array.isArray(args.files)) return []
      const paths = []
      for (const file of args.files) {
        // `path` is the only required field; a `description` is presentation only.
        const path = pathValue(file?.path)
        if (path !== null) paths.push(path)
      }
      return paths
    }

    // ── address construction ──────────────────────────────────────────────────
    //
    // Upstream's grammar (`dsh-resource://file/session/<id>/<path>`), re-expressed for the
    // same reason. The session scope matters twice: the document preview's `canOpen`
    // accepts only `scope === 'session'`, and a session-scoped path is what lets the Host
    // resolve a RELATIVE path against that Session's workspace.

    /** Component-encode one path segment, keeping `:` literal for Windows drive letters. */
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/giu, ':')

    /** Encode a `/`-separated path segment by segment. */
    const encodePath = (path) => path.split('/').map(encodeSegment).join('/')

    /**
     * The preview address for a file the agent edited.
     *
     * An absolute path inside the Session's workspace becomes workspace-relative, which is
     * what the file resource is keyed by; anything else is passed through and the Host
     * decides whether it is readable. `cwd` absent is not an error: the path stays as given.
     *
     * @param sessionId - the Session whose workspace resolves the path.
     * @param cwd - that Session's workspace root, when known.
     * @param rawPath - the path the tool call named.
     * @returns a `dsh-resource://file/session/...` address.
     */
    function toAddress(sessionId, cwd, rawPath) {
      const path = String(rawPath).replace(/\\/gu, '/')
      const root = typeof cwd === 'string' ? cwd.replace(/\\/gu, '/').replace(/\/+$/u, '') : ''
      const relative = root !== '' && path === root
        ? ''
        : root !== '' && path.startsWith(root + '/')
          ? path.slice(root.length + 1)
          : path.replace(/^(?:\.\/)+/u, '')
      return 'dsh-resource://file/session/' + encodeSegment(sessionId) + '/' + encodePath(relative)
    }

    // ── copy ──────────────────────────────────────────────────────────────────

    const en = {
      'title': 'Open delivered files',
      'description': 'Open the files the agent declares as a turn\u2019s deliverables. Files it edits along the way are not opened.',
      'label': 'Open declared deliverables',
      'on': 'On',
      'off': 'Off',
      'loading': 'Reading the setting\u2026',
      'failed': 'Could not read the setting from the host.',
      'retry': 'Retry',
      'saving': 'Saving\u2026',
      'saveFailed': 'The change was not saved and will not survive a restart.',
      'loadFailedMeansOff': 'Until the setting can be read, following stays off.',
      'status.idle': 'Waiting for the agent to declare a deliverable.',
      'status.following': 'Opened.',
      'status.takeover': 'Paused: you opened something else. It resumes on the next turn.',
      'status.collapsed': 'Paused: the right Sidebar is collapsed.',
      'status.multi': 'Paused: too many files declared at once.',
      'status.noSession': 'Waiting for a session to be on screen.',
      'status.blocked': 'Paused: the preview could not be opened.',
      'notice.one': '{label} edited {name}',
      'notice.many': '{label} edited {name} and {count} more',
      'notice.jump': 'Show it',
      'notice.dismiss': 'Dismiss',
    }

    const zh = {
      'title': '打开 agent 的交付文件',
      'description': '打开 agent 声明为本轮交付物的文件。它中途编辑的过程文件不会打开。',
      'label': '打开声明的交付文件',
      'on': '开',
      'off': '关',
      'loading': '正在读取设置…',
      'failed': '无法从宿主读取该设置。',
      'retry': '重试',
      'saving': '正在保存…',
      'saveFailed': '改动未保存，重启后不会生效。',
      'loadFailedMeansOff': '在读到设置之前，跟随保持关闭。',
      'status.idle': '等待 agent 声明交付文件。',
      'status.following': '已打开。',
      'status.takeover': '已暂停：你打开了别的文件。下一轮会恢复。',
      'status.collapsed': '已暂停：右侧栏是收起的。',
      'status.multi': '已暂停：一次声明的文件过多。',
      'status.noSession': '等待会话出现在屏上。',
      'status.blocked': '已暂停：预览打不开。',
      'notice.one': '{label} 改动了 {name}',
      'notice.many': '{label} 改动了 {name} 等 {count} 个文件',
      'notice.jump': '查看',
      'notice.dismiss': '忽略',
    }

    // ── styles ────────────────────────────────────────────────────────────────
    //
    // Tokens only, and no native widget for the control. The theme row learned this the
    // expensive way: an unstyled native control is drawn by the user agent, so it was
    // byte-identical across every colour scheme and read as a piece of another
    // application. A `<button role="switch">` with the design system's own field colours
    // avoids repeating that.
    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      row: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' },
      title: { fontWeight: 600 },
      description: { ...muted, lineHeight: '1.5' },
      field: { display: 'flex', alignItems: 'center', gap: '8px' },
      control: {
        font: 'inherit', cursor: 'pointer', boxSizing: 'border-box',
        height: '32px', minWidth: '64px', padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      note: { ...muted, fontSize: '12px' },
      alert: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      // The header row carries the design system's own chip, so it reads as part of the
      // header rather than as a stray control inside it.
      notice: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
      noticeText: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      noticeButton: {
        font: 'inherit', cursor: 'pointer', padding: '2px 8px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
    }

    /** Services this plugin needs before it can register anything. */
    const inject = ['slots', 'locale', 'sessions', 'uiConversation', 'sidebarRight']

    /**
     * Register the row and start following.
     *
     * Everything the row renders is built in this closure and captured by the component,
     * because the harness's slot contract passes no arbitrary props into a registered
     * component, and hanging state off the context would put our names on an object the
     * whole client shares. That is also why the component is declared here rather than at
     * module scope.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'qialike-edit-follow: dictionaries')
      const t = ctx.locale.bind(NS)

      /** What the row renders. Replaced, never mutated in place, so React re-renders. */
      let view = {
        loading: true,
        failed: false,
        enabled: ENABLED_WHEN_UNKNOWN,
        saving: false,
        saveFailed: false,
        status: 'idle',
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

      // ── the follow engine ───────────────────────────────────────────────────

      /**
       * Pending subagent edits for the Session on screen, by child Session id.
       *
       * A subagent's edit is REPORTED, never followed. Its work runs in another Session,
       * behind whatever the user is looking at, and moving the preview for it would take the
       * window from someone who did not ask and cannot see why. One click acts on it.
       */
      const childPending = new Map()
      /** Live chat subscriptions to child Sessions, by child id. */
      const childStops = new Map()
      /** Per-child handled call ids, for the same reason the parent keeps one. */
      const childSeen = new Map()
      /** The published notice, replaced only when the fact changes. */
      let notice = []

      /** Call ids already acted on, so a re-published snapshot cannot repeat one. */
      const seen = new Set()
      const seenOrder = []
      /**
       * Files a `present` call declared, in declaration order.
       *
       * THE ONLY SET LEFT. Following used to keep a second one for `write` / `edit` targets and
       * open whichever ended a debounce window first; that is what put a build script on screen
       * before the document it produced. Mutations are no longer recorded for OPENING at all —
       * `mutationPath` still runs, but only for the subagent notice, which reports and never
       * navigates.
       */
      const presented = new Map()
      let timer
      /** The address we last opened, which is how "the user took over" is detected. */
      let lastOpened
      let userTookOver = false
      let lastTurn = -1
      let mountedSession
      let stopChat
      let stopCatalog

      const note = (status) => { if (view.status !== status) setView({ status }) }

      /** Remember a handled call id, forgetting the oldest past the limit. */
      function remember(callId) {
        seen.add(callId)
        seenOrder.push(callId)
        if (seenOrder.length > SEEN_LIMIT) {
          seen.delete(seenOrder.shift())
        }
      }

      /** The workspace root of one Session, when the client knows it. */
      function cwdOf(sessionId) {
        const sessions = ctx.get('sessions')
        const byId = sessions?.list?.getSnapshot?.()?.byId
        return byId?.[sessionId]?.cwd
      }

      /**
       * Start following again, from whatever is on screen now.
       *
       * Clearing the takeover flag alone is NOT enough, and this is the bug the first
       * version of this rule had: the takeover test is stateless — it compares the active
       * tab against the address we last opened — so if the user's own tab is still the
       * active one, the very next edit re-detects the same takeover and following never
       * resumes. Adopting the current tab as the baseline is what makes "resume" mean
       * anything. With nothing open there is no baseline, and the comparison is skipped
       * until this plugin opens something.
       */
      function resumeFollowing() {
        userTookOver = false
        lastOpened = ctx.get('sidebarRight')?.active?.()?.contentId
      }

      /**
       * Open the files a `present` call declared, or explain why not.
       *
       * ONLY A DECLARATION MOVES THE PREVIEW. Earlier versions also followed `write`, `edit` and
       * `str_replace_editor`, and the complaint that produced this rule was exact: a "make me a
       * Word document" turn writes a build script, runs it for tens of seconds, and declares the
       * .docx at the end — so the script's own window expired and opened a PROCESS file before
       * the deliverable even existed. Deferring the edits to the end of the turn does not fix it
       * either: the script still opens, just later. What was asked for is that process files
       * never open at all, and only the declared result does.
       *
       * THE COST, STATED PLAINLY: a turn that declares nothing opens nothing. That is the
       * intended reading — an undeclared file is not a result as far as this row can tell, and
       * guessing which intermediate file the user wanted is what produced the complaint.
       */
      function flush() {
        timer = undefined
        const declared = [...presented.keys()]
        presented.clear()
        if (declared.length === 0) return
        if (view.enabled !== true) { note('off'); return }
        const sidebar = ctx.get('sidebarRight')
        if (sidebar === undefined) return
        // A CAP, NOT A VETO. The multi rule that used to live here existed because a burst of
        // edits has no single "file being edited"; a declaration is not a guess, so the only
        // thing left to decide is which ones fit. Past the cap the last wins, which is the one
        // the tool documents as most important and the one the agent named last.
        const paths = declared.length > MAX_TARGETS ? [declared[declared.length - 1]] : declared
        if (userTookOver) { note('takeover'); return }
        // Rule 1: a collapsed column is not where the user is looking.
        if (sidebar.isExpanded() !== true) { note('collapsed'); return }
        const sessionId = mountedSession
        if (sessionId === undefined) { note('noSession'); return }
        // Rule 2: whichever tab is active now, if it is not ours then the user chose it.
        const active = sidebar.active()
        if (lastOpened !== undefined && active !== undefined && active.contentId !== lastOpened) {
          userTookOver = true
          note('takeover')
          return
        }
        let blocked = false
        for (const path of paths) {
          const address = toAddress(sessionId, cwdOf(sessionId), path)
          try {
            sidebar.openResource(address)
          } catch {
            // A DECLARED FILE THE PREVIEW CANNOT RENDER MUST NOT BE OPENED, which is the "only
            // if it can be previewed" half of the rule: `present` may name an archive or an
            // executable, and the throw is how the sidebar reports that no tab type takes it.
            blocked = true
            break
          }
          // ASSIGNED ONLY AFTER THE CALL SUCCEEDS. Pointing `lastOpened` at an address that was
          // never opened makes the takeover rule below compare the user's next click against a
          // tab that does not exist, which stops following for the rest of the Session.
          lastOpened = address
        }
        note(blocked ? 'blocked' : 'following')
      }


      /**
       * Record one call's declared deliverables and open them.
       *
       * Order is declaration order, which is the order the model named them in.
       *
       * @param paths - the paths a single `present` call named.
       */
      function declare(paths) {
        // ALL of one call's paths before any flush, so the cap in `flush` sees the list the
        // model actually declared. Flushing per path would open a four-file `present` as four
        // separate declarations and make the cap unreachable.
        for (const path of paths) presented.set(path, true)
        // FLUSH AT ONCE, not after the debounce. A declaration is the END of a run by
        // definition — the model has finished producing its deliverables — while the debounce
        // exists to pick the last target out of a burst of edits still arriving. Waiting here
        // only delays the file the user asked for.
        //
        // Measured against the shape of a real "make me a Word document" turn: `write` the
        // script, `bash` run it for tens of seconds, `present` the .docx. The script no longer
        // opens at all, and flushing here collapses what is left of the delay to the time the
        // call takes to be transcribed.
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        flush()
      }

      /**
       * Read the tool calls out of one chat snapshot.
       *
       * @param snapshot - the snapshot, undefined before the view target activates.
       * @param seed - mark everything currently visible as handled without acting.
       */
      function scan(snapshot, seed) {
        const nodes = snapshot?.nodes
        if (nodes === undefined || typeof nodes.values !== 'function') return
        for (const node of nodes.values()) {
          if (node === null || typeof node !== 'object' || node.kind !== 'tool-call') continue
          const root = node.data?.root
          if (root === null || typeof root !== 'object') continue
          // Only a dispatched call has complete arguments; `preparing` carries a streaming
          // prefix that is not JSON yet, and acting on one would navigate by guesswork.
          if (root.phase !== 'start') continue
          // A PTC dispatch child belongs to its parent call; the root is what was asked for.
          if (root.parentCallId !== undefined) continue
          const callId = root.callId
          if (typeof callId !== 'string' || seen.has(callId)) continue
          remember(callId)
          if (seed === true) continue
          // A new turn is a fresh start, so a takeover from the previous turn no longer
          // applies. Without this, one click on another tab would disable following for
          // the rest of the Session.
          if (typeof root.turn === 'number' && root.turn > lastTurn) {
            lastTurn = root.turn
            resumeFollowing()
          }
          // MUTATIONS ARE NOT READ HERE, AND THAT IS THE RULE RATHER THAN AN OMISSION.
          // `write`, `edit` and `str_replace_editor` describe how the agent got there; opening
          // them is what showed a build script beside the document it produced. The only
          // signal that names a RESULT is `present` — see {@link presentedPaths}.
          //
          // `mutationPath` still exists and still runs in `scanChild`, where the call moves a
          // notice rather than the preview.
          // ONE CALL, ONE DECLARATION: the paths go in together so the cap applies to the
          // list the model actually wrote rather than to each path separately.
          declare(presentedPaths(root.name, root.argsRaw))
        }
      }

      // ── the subagent channel ────────────────────────────────────────────────
      //
      // A subagent runs in its OWN Session, so its tool calls are not in the parent's chat
      // snapshot at all — the harness gives each spawned child a fresh agent and a fresh
      // conversation, and `subCalls` is a different thing entirely (PTC dispatch children
      // of one call). Reaching them therefore needs a second source: the parent's catalog
      // of its children, and then one chat subscription per child.
      //
      // REPORTED, NOT FOLLOWED. Everything here publishes a notice the user acts on; nothing
      // navigates. See `childPending`.

      /** Listeners of the notice source; the header row subscribes through its hook seat. */
      const noticeListeners = new Set()

      /** The child entries of one Session, as the projection reports them. */
      function childrenOf(sessionId) {
        const sessions = ctx.get('sessions')
        const byId = sessions?.list?.getSnapshot?.()
        const catalog = byId?.projectionsBySession?.[sessionId]?.values?.subagentCatalog
        return Array.isArray(catalog) ? catalog : []
      }

      /** A child's display name, falling back to its id the way the harness's own catalog does. */
      function labelOf(child) {
        if (typeof child.label === 'string' && child.label !== '') return child.label
        const sessions = ctx.get('sessions')
        const summary = sessions?.list?.getSnapshot?.()?.byId?.[child.id]
        return typeof summary?.displayTitle === 'string' && summary.displayTitle !== ''
          ? summary.displayTitle
          : String(child.id)
      }

      /**
       * Rebuild the published notice.
       *
       * A NEW ARRAY EVERY TIME, and only when the fact actually moved: an observable source
       * must keep its snapshot identity stable between changes, so this is called from the
       * mutators rather than from the reader.
       */
      function publishNotice() {
        const entries = [...childPending.values()]
        notice = entries.slice(0, NOTICE_LIMIT).map((entry) => ({ ...entry, count: entries.length }))
        for (const listener of [...noticeListeners]) listener()
      }

      /**
       * Record one file a subagent edited.
       *
       * Keyed by child, so a subagent that rewrites thirty files leaves one entry naming its
       * latest rather than thirty: the notice answers "which subagent has something to look
       * at", and the jump goes to that child's newest file.
       *
       * @param childId - the child Session that made the edit.
       * @param label - the child's display name.
       * @param path - the path relative to the child's own workspace, or absolute.
       */
      function recordChildEdit(childId, label, path) {
        const previous = childPending.get(childId)
        if (previous !== undefined && previous.path === path) return
        childPending.set(childId, {
          childId,
          label,
          path,
          // The address is built against the CHILD's Session: a session-scoped path is what
          // lets the Host resolve a relative one, and the child's workspace root is the one
          // its `file_path` was relative to.
          address: toAddress(childId, cwdOf(childId), path),
        })
        publishNotice()
      }

      /** Forget one child's pending edit, after the user looked at it or dismissed it. */
      function clearChild(childId) {
        if (childPending.delete(childId)) publishNotice()
      }

      /**
       * Read the tool calls out of one child Session's snapshot.
       *
       * The same rule as the parent's scan, with two differences: a hit is recorded rather
       * than followed, and the handled-call set is per child so two children cannot shadow
       * each other's ids.
       *
       * @param childId - the child Session.
       * @param label - the child's display name.
       * @param snapshot - the child's chat snapshot, possibly not materialized yet.
       */
      function scanChild(childId, label, snapshot) {
        const nodes = snapshot?.nodes
        if (nodes === undefined || typeof nodes.values !== 'function') return
        let handled = childSeen.get(childId)
        if (handled === undefined) {
          handled = new Set()
          childSeen.set(childId, handled)
        }
        for (const node of nodes.values()) {
          if (node === null || typeof node !== 'object' || node.kind !== 'tool-call') continue
          const root = node.data?.root
          if (root === null || typeof root !== 'object') continue
          if (root.phase !== 'start') continue
          if (root.parentCallId !== undefined) continue
          const callId = root.callId
          if (typeof callId !== 'string' || handled.has(callId)) continue
          if (handled.size > SEEN_LIMIT) handled.clear()
          handled.add(callId)
          const path = mutationPath(root.name, root.argsRaw)
          if (path !== null) recordChildEdit(childId, label, path)
        }
      }

      /** Subscribe to one child's conversation. */
      function watchChild(child) {
        const sessions = ctx.get('sessions')
        const uiConversation = ctx.get('uiConversation')
        if (sessions === undefined || uiConversation === undefined) return
        const binding = sessions.binding(child.id)
        if (binding === undefined) return
        const label = labelOf(child)
        // The same activation side effect as the parent's subscription, and stated for the
        // same reason: subscribing materializes this child's chat snapshot for the life of
        // the Session. It changes nothing the user sees, and it is the only way to read a
        // child's tool calls through the client's own read accessor.
        const source = uiConversation.binding(binding).target('chat')
        const stop = source.subscribe(() => { scanChild(child.id, label, source.getSnapshot()) })
        childStops.set(child.id, stop)
        // Seeded, not followed: a child whose work happened before this row bound has
        // nothing to report, exactly as the parent's own first read behaves.
        const first = source.getSnapshot()
        if (first !== undefined) {
          const handled = new Set()
          childSeen.set(child.id, handled)
          const nodes = first.nodes
          if (nodes !== undefined && typeof nodes.values === 'function') {
            for (const node of nodes.values()) {
              const root = node?.kind === 'tool-call' ? node.data?.root : undefined
              if (root !== null && typeof root === 'object' && typeof root.callId === 'string') {
                handled.add(root.callId)
              }
            }
          }
        }
      }

      /** Release every child subscription, as a Session change or teardown requires. */
      function releaseChildren() {
        for (const stop of childStops.values()) stop()
        childStops.clear()
        childSeen.clear()
        if (childPending.size > 0) {
          childPending.clear()
          publishNotice()
        }
      }

      /**
       * Bring the child subscriptions in line with the parent's catalog.
       *
       * Both directions matter: a child that appeared needs a subscription, and one that
       * finished must lose its own so a long Session does not accumulate targets — each of
       * which holds a materialized snapshot.
       *
       * @param parentId - the Session on screen.
       */
      function syncChildren(parentId) {
        const children = childrenOf(parentId)
        const present = new Set()
        for (const child of children) {
          if (child === null || typeof child !== 'object' || typeof child.id !== 'string') continue
          present.add(child.id)
          if (!childStops.has(child.id)) watchChild(child)
        }
        for (const childId of [...childStops.keys()]) {
          if (present.has(childId)) continue
          childStops.get(childId)()
          childStops.delete(childId)
          childSeen.delete(childId)
          clearChild(childId)
        }
      }

      /**
       * Point the engine at one Session's conversation, or at none.
       *
       * Idempotent: re-binding the Session already bound is a no-op, so a re-notification
       * from `mounted` cannot drop the live subscription.
       *
       * @param sessionId - the Session on screen, or undefined.
       */
      function bindSession(sessionId) {
        if (mountedSession === sessionId && (sessionId === undefined || stopChat !== undefined)) return
        if (stopChat !== undefined) { stopChat(); stopChat = undefined }
        if (stopCatalog !== undefined) { stopCatalog(); stopCatalog = undefined }
        // Children belong to the Session being left, so their subscriptions and their
        // pending notices both go with it.
        releaseChildren()
        mountedSession = sessionId
        seen.clear()
        seenOrder.length = 0
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        // A different Session is a different conversation: its call ids and its takeover
        // state say nothing about this one.
        userTookOver = false
        lastTurn = -1
        lastOpened = undefined
        if (sessionId === undefined) { note('noSession'); return }
        const sessions = ctx.get('sessions')
        const uiConversation = ctx.get('uiConversation')
        if (sessions === undefined || uiConversation === undefined) return
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return
        // SUBSCRIBING ACTIVATES THIS VIEW TARGET and materializes the Session's chat
        // snapshot; activation lasts for the Session's lifetime. That is a real side
        // effect, recorded here rather than hidden: it does not change what the user sees
        // — no view is switched — and it is confined to the Session on screen, because
        // that is the only one this plugin ever subscribes to.
        const source = uiConversation.binding(binding).target('chat')
        stopChat = source.subscribe(() => { scan(source.getSnapshot(), false) })
        // The first read SEEDS rather than follows. Jumping to whatever file the agent
        // touched last, the moment a Session appears, would be a navigation the user did
        // not ask for and cannot predict.
        scan(source.getSnapshot(), true)

        // The child catalog is a projection the Host serves on request, so the first read
        // asks for it; a Session whose children were spawned before this row bound would
        // otherwise look childless. Re-syncing on every list change is what notices a child
        // appearing or finishing.
        const catalogSource = ctx.get('sessions')?.list
        if (catalogSource !== undefined && typeof catalogSource.subscribe === 'function') {
          stopCatalog = catalogSource.subscribe(() => { syncChildren(sessionId) })
        }
        void ctx.get('sessions')?.refreshProjections?.(sessionId)
        syncChildren(sessionId)
      }

      ctx.effect(() => {
        const sidebar = ctx.get('sidebarRight')
        const mounted = sidebar?.mounted
        if (mounted === undefined) return () => {}
        const stopMounted = mounted.subscribe(() => { bindSession(mounted.getSnapshot()) })
        bindSession(mounted.getSnapshot())
        return () => {
          stopMounted()
          if (stopChat !== undefined) { stopChat(); stopChat = undefined }
          if (stopCatalog !== undefined) { stopCatalog(); stopCatalog = undefined }
          releaseChildren()
          if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        }
      }, 'qialike-edit-follow: follow engine')

      // ── the switch ──────────────────────────────────────────────────────────

      /** Read the stored switch; a failed read leaves following off. See ENABLED_WHEN_UNKNOWN. */
      async function load() {
        setView({ loading: true, failed: false })
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || payload === undefined || payload.ok !== true) {
            throw new Error(payload?.message ?? String(response.status))
          }
          setView({ loading: false, failed: false, enabled: payload.enabled === true })
        } catch {
          setView({ loading: false, failed: true, enabled: ENABLED_WHEN_UNKNOWN })
        }
      }

      /**
       * Persist the switch, rolling the control back when the write fails.
       *
       * A control that stays where it was put while the write failed is the one outcome a
       * user cannot detect, so a failure moves it back and says so.
       *
       * @param enabled - the requested value.
       */
      async function save(enabled) {
        setView({ saving: true, saveFailed: false, enabled })
        let landed = false
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'setEnabled', enabled }),
          })
          const payload = await response.json().catch(() => undefined)
          landed = response.ok && payload !== undefined && payload.ok === true && payload.enabled === enabled
        } catch {
          landed = false
        }
        if (landed) {
          setView({ saving: false, saveFailed: false })
          // Turning the switch on is the explicit "start following" action, so it resumes
          // from what is on screen rather than being re-stopped by the same takeover.
          if (enabled) { resumeFollowing(); note('idle') }
          return
        }
        setView({ saving: false, saveFailed: true, enabled: !enabled })
      }

      /** The row: what following does, the switch, and why it is paused. */
      function EditFollowRow() {
        const [state, setState] = React.useState(view)
        React.useEffect(() => {
          setState(view)
          return subscribe(() => { setState(view) })
        }, [])

        if (state.failed) {
          return h('div', { style: styles.row },
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.alert, role: 'alert' }, t('failed')),
            h('div', { style: styles.note }, t('loadFailedMeansOff')),
            h('button', { type: 'button', onClick: () => { void load() }, style: styles.control }, t('retry')))
        }
        if (state.loading) {
          return h('div', { style: styles.row }, h('div', { style: styles.description }, t('loading')))
        }

        const notes = []
        if (state.saveFailed) {
          notes.push(h('div', { key: 'save', style: styles.alert, role: 'alert' }, t('saveFailed')))
        }
        if (state.enabled) {
          // Why following is doing nothing is otherwise invisible, and "the switch is on
          // but nothing happens" is the one state a user cannot diagnose from the window.
          notes.push(h('div', { key: 'status', style: styles.note, role: 'status' }, t('status.' + state.status)))
        }

        return h('div', { style: styles.row },
          h('div', { style: styles.title }, t('title')),
          h('div', { style: styles.description }, t('description')),
          h('div', { style: styles.field },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': state.enabled,
              'aria-label': t('label'),
              disabled: state.saving,
              onClick: () => { void save(!state.enabled) },
              style: { ...styles.control, opacity: state.saving ? 0.6 : 1 },
            }, state.enabled ? t('on') : t('off')),
            h('span', { style: muted }, t('label'))),
          state.saving ? h('div', { style: styles.note }, t('saving')) : null,
          notes)
      }

      void load()

      // ── the notice, and the one click that acts on it ───────────────────────
      //
      // WHY THE SESSION HEADER. Subagent work is reported where the Session is, not where
      // the file is: the whole point is that the preview does NOT move, so the notice cannot
      // live in it. `conversation.session.header.utilities` is a list slot, so this is a
      // contribution beside whatever else is there rather than a claim on it.

      /**
       * The notice source, published into the row's `hooks` seat.
       *
       * Identity is stable between changes, as an observable source must be: `notice` is
       * replaced only by `publishNotice`, which runs when an entry is added or removed.
       */
      const noticeSource = {
        getSnapshot: () => notice,
        subscribe: (listener) => {
          noticeListeners.add(listener)
          return () => { noticeListeners.delete(listener) }
        },
      }

      /** Act on one notice: move the preview there, then forget it. */
      function jumpTo(entry) {
        const sidebar = ctx.get('sidebarRight')
        if (sidebar === undefined) return
        try {
          sidebar.openResource(entry.address)
        } catch {
          // An address no registered tab type will open is a wiring failure rather than a
          // user error, and it must not take the row down with it.
        }
        clearChild(entry.childId)
      }

      /** The notice row. Rendered only while a subagent has something to look at. */
      function SubagentNoticeRow(props) {
        // The seat binds a `hooks` entry as `use<Name>`; a source with no entry yields an
        // empty array, so the row renders nothing rather than throwing.
        const entries = props.useSubagentEdits(value => value)
        if (!Array.isArray(entries) || entries.length === 0) return null
        const first = entries[0]
        const name = String(first.path).split('/').pop()
        // The child is named as well as the file: with more than one subagent running, "a
        // subagent edited a.txt" does not say which one to go and look at.
        const who = String(first.label)
        // The remainder comes from the published TOTAL, not from this array's length: the
        // array is capped at NOTICE_LIMIT, so counting it would understate how many
        // subagents have something to look at — the first version of this row said "and 2
        // more" for five.
        const label = entries.length === 1 && first.count === 1
          ? t('notice.one', { label: who, name })
          : t('notice.many', { label: who, name, count: String(Math.max(1, Number(first.count) - 1)) })
        return h('div', { style: styles.notice, role: 'status' },
          h('span', { style: styles.noticeText }, label),
          h('button', {
            type: 'button',
            style: styles.noticeButton,
            onClick: () => { jumpTo(first) },
          }, t('notice.jump')),
          h('button', {
            type: 'button',
            style: styles.noticeButton,
            onClick: () => { clearChild(first.childId) },
          }, t('notice.dismiss')))
      }

      // `inject` rather than a bare register: a slot exists only while the entry that
      // declares it is mounted, and registering into an undeclared slot throws. The
      // settings shell declares this one and may mount after us.
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'qialike-edit-follow',
        // Immediately after the theme row (12), which it follows in the same "how this
        // application behaves" group. Before developer tools (15). Upstream orders the
        // feature rows below `current-version` (100).
        order: 13,
        locale: NS,
      }, EditFollowRow))

      // The subagent notice. A list slot, so this adds a row beside the other header
      // utilities instead of replacing them; `order` places it after them, because it is a
      // passing report rather than a control the header is built around.
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'qialike-edit-follow-notice',
        order: 10,
        locale: NS,
        inject: () => ({ hooks: { subagentEdits: noticeSource } }),
      }, SubagentNoticeRow))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
