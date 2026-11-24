/**
 * "Export Session" in a Session row's menu — the browser half of
 * `@qialike/qialike-desktop-export`.
 *
 * HAND-WRITTEN, NOT BUILT, for the reason the theme, providers, voice and edit-follow halves
 * spell out: the harness's client-bundle preset is unpublished, and the artifact contract is
 * small enough to write directly.
 *
 * WHY A MENU ITEM AND NOT A HEADER BUTTON. The harness ships `/export` and a header download
 * button, and both hand back the raw `.jsonl` inside a ZIP — a backup of the log, not a document.
 * What was asked for is the CLI's `/export`: a JSON file or a Markdown file a person can read.
 * Putting it beside "Copy Session ID" in the row's own menu is where the other per-Session
 * actions live, and it is reachable for a Session that is not the active one.
 *
 * THE FORMAT IS ASKED, NOT GUESSED. Two formats answer two different needs — JSON for a machine,
 * Markdown for a reader — and neither is a sensible default for the other. A tiny panel inside
 * the menu asks which, then reports the path it wrote.
 *
 * @module @qialike/qialike-desktop-export/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-export',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-export'

    /**
     * The Host route that writes the file.
     *
     * DOCUMENT-RELATIVE, with no leading slash: the served document carries `<base href="./">`,
     * so a root-absolute literal resolves against the origin and breaks under a mount prefix.
     */
    const API = 'api/qialike/export'

    const dictionaries = {
      en: {
        'menu': 'Export Session…',
        'choose': 'Export this Session as:',
        'json': 'JSON',
        'jsonHint': 'The whole conversation as data: messages, tool calls and their output.',
        'markdown': 'Markdown',
        'markdownHint': 'The same conversation as a document you can read or paste.',
        'cancel': 'Cancel',
        'working': 'Exporting…',
        'done': 'Exported {messages} messages to {file}',
        'cancelled': 'Export cancelled.',
        'noShell': 'Saving needs the desktop application; a browser tab cannot open a save dialog.',
        'failed': 'Export failed: {message}',
      },
      zh: {
        'menu': '导出 Session…',
        'choose': '把这个 Session 导出为：',
        'json': 'JSON',
        'jsonHint': '整段对话作为数据：消息、工具调用及其输出。',
        'markdown': 'Markdown',
        'markdownHint': '同一段对话作为可阅读、可粘贴的文档。',
        'cancel': '取消',
        'working': '正在导出…',
        'done': '已导出 {messages} 条消息到 {file}',
        'cancelled': '已取消导出。',
        'noShell': '保存需要桌面应用；浏览器标签页无法打开保存对话框。',
        'failed': '导出失败：{message}',
      },
    }

    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      panel: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 10px', minWidth: '260px' },
      prompt: { fontSize: '12px', ...muted },
      choice: {
        display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start',
        padding: '6px 8px', cursor: 'pointer', borderRadius: '6px', textAlign: 'left',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit',
      },
      choiceTitle: { fontWeight: 600, fontSize: '13px' },
      hint: { fontSize: '11px', ...muted, lineHeight: '1.4' },
      note: { fontSize: '11px', lineHeight: '1.4', wordBreak: 'break-word' },
      error: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' },
      cancel: {
        alignSelf: 'flex-end', font: 'inherit', fontSize: '11px', cursor: 'pointer',
        padding: '2px 8px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * The menu entry: a button that opens a two-choice panel, then reports where the file went.
     *
     * `useMenuOpenState` is injected by the slot owner; the entry dismisses the menu itself when
     * it acts, which is what every shipped entry does. The panel lives INSIDE the menu while a
     * choice is being made — closing the menu first would leave the question floating.
     */
    function ExportMenuItem({ sessionId, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const [asking, setAsking] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(undefined)
      const [failure, setFailure] = React.useState(undefined)

      /**
       * Ask the Host for the document, then ask the user where to put it.
       *
       * TWO STEPS, IN THAT ORDER, and the order matters: the document is built before the dialog
       * opens, so a Session that cannot be read fails with a reason instead of after the user has
       * picked a filename. It also means the dialog never opens onto an export that then fails.
       *
       * THE SAVE DIALOG IS THE SHELL'S. `dshDesktopBoot.saveDocument` is the bridge; a browser
       * build has no such carrier, and the row says so rather than opening a dialog it cannot
       * show.
       */
      const run = async (format) => {
        setBusy(true)
        setFailure(undefined)
        setNote(undefined)
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, format }),
          })
          const body = await response.json().catch(() => undefined)
          if (!response.ok || body?.ok !== true) {
            setFailure(t('failed', { message: body?.message ?? `HTTP ${response.status}` }))
            return
          }
          // The bridge is `dshDesktopBoot.saveDocument` — the same global the shell's boot rows
          // travel on. There is no `dshDesktop.documents`; inventing one was a mistake this line
          // made until the preload was read rather than assumed.
          const boot = globalThis.dshDesktopBoot
          if (typeof boot?.saveDocument !== 'function') {
            // A browser tab has no filesystem and no native dialog. Saying so is better than
            // silently doing nothing, which is what a missing carrier would otherwise produce.
            setFailure(t('noShell'))
            return
          }
          const saved = await boot.saveDocument({
            suggestedName: body.suggestedName,
            contents: body.contents,
            mimeType: body.mimeType,
          })
          // `null` is a cancel, which is not a failure: the user changed their mind and the row
          // goes back to offering the choice.
          if (saved === null || saved === undefined) { setNote(t('cancelled')); return }
          setNote(t('done', { messages: body.messages, file: saved }))
        } catch (error) {
          setFailure(t('failed', { message: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      if (!asking) {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          style: styles.choice,
          onClick: () => { setAsking(true) },
        }, h('span', { style: styles.choiceTitle }, t('menu')))
      }

      const choice = (format, label, hint) => h('button', {
        type: 'button',
        role: 'menuitem',
        style: styles.choice,
        disabled: busy,
        onClick: () => { void run(format) },
      },
        h('span', { style: styles.choiceTitle }, label),
        h('span', { style: styles.hint }, hint))

      return h('div', { style: styles.panel, role: 'group' },
        h('div', { style: styles.prompt }, busy ? t('working') : t('choose')),
        choice('json', t('json'), t('jsonHint')),
        choice('markdown', t('markdown'), t('markdownHint')),
        note === undefined ? null : h('div', { style: styles.note, role: 'status' }, note),
        failure === undefined ? null : h('div', { style: styles.error, role: 'alert' }, failure),
        h('button', {
          type: 'button',
          style: styles.cancel,
          onClick: () => { setAsking(false); setNote(undefined); setFailure(undefined); setMenuOpen(false) },
        }, t('cancel')))
    }

    /**
     * Services this bundle reads.
     *
     * `slots` and `locale` are services, not package names — the distinction that made the update
     * row sit pending and take the whole client down once. `useMenuOpenState` arrives as a prop
     * through the slot's own hook context, so nothing else is needed.
     */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'qialike-export: dictionaries')
      const t = ctx.locale.bind(NS)

      // `inject` rather than a bare register: a slot exists only while the entry that declares it
      // is mounted, and the sidebar may mount after us.
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'qialike-export',
        // After the shipped entries — pin, rename, fork, archive, copy ID — which are ordered in
        // the low hundreds. Exporting is a deliberate act, not a frequent one.
        order: 600,
        locale: NS,
        // THE TRANSLATOR ARRIVES THROUGH `inject`, not from the owner props. `locale: NS` declares
        // the namespace this entry's copy comes from; the seat itself is filled here, which is
        // also why `t` is destructured after the owner's own props.
        inject: () => ({ t }),
      }, ExportMenuItem))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
