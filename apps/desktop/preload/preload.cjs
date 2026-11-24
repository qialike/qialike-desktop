/**
 * The preload: the only bridge between the renderer and the shell.
 *
 * Written as CommonJS `.cjs` rather than compiled from TypeScript, because a
 * **sandboxed** preload's `require` polyfill resolves only `electron`, `events`,
 * `timers` and `url`. A compiled ESM preload would need `tsc` to emit a second
 * module format and a bundler to inline its imports; this file is small enough
 * that hand-writing it is less machinery than building it, and the sandbox is
 * worth more than the tooling consistency.
 *
 * It follows the same rule as the IPC layer it fronts: expose the few things
 * HTTP cannot express, and nothing else. No filesystem, no shell, no
 * `ipcRenderer`, no channel names chosen by the caller.
 */

const { contextBridge, ipcRenderer } = require('electron')

/** Channel names are duplicated from `src/ipc.ts`; a preload cannot import them. */
const BOOT = 'qialike-desktop:boot'
const BOOT_FAILED = 'qialike-desktop:boot-failed'
const PICK_DIRECTORY = 'qialike-desktop:pick-directory'
const SAVE_DOCUMENT = 'qialike-desktop:save-document'
const LOCALE = 'qialike-desktop:locale'
const UPDATES_STATUS = 'qialike-desktop:updates-status'
const UPDATES_OPEN = 'qialike-desktop:updates-open'
const UPDATES_CHECK = 'qialike-desktop:updates-check'
const UPDATES_DOWNLOAD = 'qialike-desktop:updates-download'
const UPDATES_PRESENTATION = 'qialike-desktop:updates-presentation'

/** The protocol generation this preload speaks. Must match `HOST_PROTOCOL_VERSION`. */
const PROTOCOL_VERSION = 1

/**
 * The marker the harness client reads to decide it is running inside a desktop
 * application rather than a browser tab.
 *
 * Client packages branch on `'dshDesktop' in globalThis`, and both branches are
 * wrong for this application:
 *
 *   · ABSENT — `ui-settings-models` takes its browser posture and registers the
 *     DeepSeek credential-onboarding dialog and the welcome notice. qialike
 *     authenticates with provider API keys, so both prompt for something this
 *     product does not have.
 *   · PRESENT, unconditionally — `ui-settings-account` stops returning early
 *     (`if (!('dshDesktop' in globalThis)) return`) and mounts the DeepSeek
 *     account section, its launcher menu and a shell overlay. This build disables
 *     that row in `cordis.patch.yml` instead, which is the only way to get the
 *     desktop posture *without* the account surface (DESIGN §12.2 R11).
 *
 * WHICH MEMBERS ARE PRESENT IS A PRODUCT DECISION, not a capability list. The
 * harness's own preload also exposes `browser`, `keyboard` and `shortcuts`; this
 * application implements none of those bridges, and an absent property is the
 * honest answer — every consumer reads through optional chaining
 * (`shortcuts`' `?.keyboard`), so a missing key degrades to browser behaviour
 * rather than throwing.
 *
 * `updates` **is** present, because this shell implements it: the coordinator in
 * `src/update-coordinator.ts` owns a real updater, and upstream's
 * `ui-settings-general` renders a status badge from whatever this carrier
 * reports. Adding it here is what turns that badge on; leaving it out is what
 * keeps it off. Everything else stays absent until something implements it.
 */
const DESKTOP_MARKER = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  updates: {
    status: () => ipcRenderer.invoke(UPDATES_STATUS),
    open: () => ipcRenderer.invoke(UPDATES_OPEN),
    /**
     * Ask whether an update exists, WITHOUT fetching it; and fetch it once the user
     * has agreed to.
     *
     * OURS, NOT UPSTREAM'S. `ui-settings-general` calls only `status`, `open` and
     * `subscribe`. `open` checks and downloads in one motion, which is right for the
     * background badge and wrong for the manual row in Settings: a click that asks a
     * question must not commit the user to a 200 MB download. Neither takes an
     * argument and neither returns anything, so a renderer gains no reach from them —
     * what it may LEARN is still bounded by `status()`, which the end-to-end check
     * asserts.
     */
    check: () => ipcRenderer.invoke(UPDATES_CHECK),
    download: () => ipcRenderer.invoke(UPDATES_DOWNLOAD),
    /**
     * Observe each presentation, and return the detach.
     *
     * The `_event` parameter is stripped rather than forwarded. `ipcRenderer`
     * calls a listener with `(event, ...args)`, and `event` is a live object whose
     * properties are only readable inside the preload — forwarding it would hand
     * the renderer either a proxy it cannot use or, worse, the first positional
     * argument where it expected the state.
     */
    subscribe(listener) {
      const handle = (_event, state) => { listener(state) }
      ipcRenderer.on(UPDATES_PRESENTATION, handle)
      return () => { ipcRenderer.off(UPDATES_PRESENTATION, handle) }
    },
  },
})

/**
 * Only the product document gets a bridge.
 *
 * The shell's own pages (the loading page, an error page) deliberately get
 * nothing: they are static documents whose job is to render when the rest of the
 * application cannot, and a bridge would make them a second attack surface for
 * no benefit.
 */
if (location.protocol === 'qialike-app:' && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshDesktop', DESKTOP_MARKER)
  // THE HARNESS'S NAME, NOT OURS, AND IT IS LOAD-BEARING. The Web client's entry gates
  // its whole desktop branch — the only place a shell-owned page gets
  // `__DSH_TRANSPORT__` — on finding a global named exactly this. Under any other name
  // that branch is dormant, the client's WebSocket resolves against the document origin
  // instead of the Host's, and it retries forever with nothing logged. See `BRIDGE_GLOBAL`
  // in `src/ipc.ts` for the full account. A preload cannot import that constant, so the
  // string is duplicated here and `tests/shell-boot-bootstrap.test.mjs` is what keeps the
  // two in step.
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    protocolVersion: PROTOCOL_VERSION,
    ready: () => ipcRenderer.invoke(BOOT),
    failed: (message) => { ipcRenderer.send(BOOT_FAILED, String(message)) },
    pickDirectory: () => ipcRenderer.invoke(PICK_DIRECTORY),
    // The save dialog and the write both live in the shell: the renderer has no filesystem and
    // cannot open a native dialog. The text crosses the bridge, the path comes back.
    saveDocument: (request) => ipcRenderer.invoke(SAVE_DOCUMENT, request),
    locale: () => ipcRenderer.invoke(LOCALE),
  })
}
