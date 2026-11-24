/**
 * The renderer boundary: channel names, sender validation, and what the preload
 * exposes.
 *
 * Two rules govern everything here, and both are about the renderer being
 * untrusted even though this application wrote it:
 *
 *  1. **Every channel validates its sender.** The check is on the *frame*, not
 *     the window: an `iframe` or an embedded guest shares the process but not the
 *     privilege, and a check that only asked "is this our window" would hand it
 *     the same access.
 *  2. **No channel carries a capability the product needs at runtime.** There is
 *     no filesystem, no shell, no package manager, and no raw `ipcRenderer`. The
 *     product talks to the Host over HTTP like any client; the shell's IPC exists
 *     only for the things HTTP cannot express — the boot rows, native dialogs,
 *     and the window's own state.
 *
 * @module @qialike/desktop/ipc
 */

import type { IpcMainInvokeEvent } from 'electron'
import type { UpdatePresentation } from './update-contract.ts'
import { APP_ORIGIN, SHELL_ORIGIN } from './web-document.ts'

/** The hostname of {@link APP_ORIGIN}. */
export const APP_HOSTNAME = new URL(APP_ORIGIN).hostname

/** The hostname of {@link SHELL_ORIGIN}. */
export const SHELL_HOSTNAME = new URL(SHELL_ORIGIN).hostname

/**
 * Channel names, all prefixed so a stray `ipcMain` listener elsewhere is
 * obviously not one of ours.
 */
export const DESKTOP_IPC = {
  /** The renderer asks for its boot rows; the shell answers once the Host is up. */
  boot: 'qialike-desktop:boot',
  /** The renderer reports that it could not start, with the message to show. */
  bootFailed: 'qialike-desktop:boot-failed',
  /** Native directory picker, attached to the application window. */
  pickDirectory: 'qialike-desktop:pick-directory',
  /**
   * Native save dialog, then write the document the renderer hands over.
   *
   * WHY THE SHELL WRITES IT. The page serves from `qialike-app://app`, and a navigation to a
   * `blob:` or `data:` URL is not a download there — Chromium's own save flow depends on a
   * `will-download` event this origin never raises in a way that offers a path. The dialog plus
   * a `writeFile` from the main process is the one path whose behaviour is the same on every
   * platform, and it is also the only one that can put the file where the user chose rather
   * than in a Downloads directory.
   */
  saveDocument: 'qialike-desktop:save-document',
  /** The window's locale, so the page and the native menus agree. */
  locale: 'qialike-desktop:locale',
  /** Host lifecycle controls the development menu uses. */
  restartHost: 'qialike-desktop:restart-host',
  /** The renderer asks what the updater knows. */
  updatesStatus: 'qialike-desktop:updates-status',
  /** The renderer asks the shell to show the update dialog / offer an install. */
  updatesOpen: 'qialike-desktop:updates-open',
  updatesCheck: 'qialike-desktop:updates-check',
  updatesDownload: 'qialike-desktop:updates-download',
  /** The shell pushes each new presentation to the renderer. */
  updatesPresentation: 'qialike-desktop:updates-presentation',
} as const

/** One IPC channel name. */
export type DesktopChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC]

/**
 * Whether a frame's URL belongs to one of this application's own documents.
 *
 * `qialike-app:` is a privileged scheme this process registered, so a frame
 * carrying it was created by the shell. The hostname check keeps the shell's
 * documents distinct from the product's: a shell document has no business on a
 * channel that answers with product state.
 */
export function isApplicationFrame(frameUrl: string, hostnames: readonly string[] = [APP_HOSTNAME]): boolean {
  let url: URL
  try {
    url = new URL(frameUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'qialike-app:') return false
  return hostnames.includes(url.hostname)
}

/**
 * Reject an IPC call from a frame the shell did not create.
 *
 * @param event - the IPC event.
 * @param hostnames - the document hostnames allowed to call this channel.
 * @throws Error naming the offending frame, so a mis-scoped channel is debugged
 *   rather than silently working for the wrong caller.
 */
export function assertApplicationSender(event: IpcMainInvokeEvent, hostnames?: readonly string[]): void {
  const frameUrl = event.senderFrame?.url ?? ''
  if (!isApplicationFrame(frameUrl, hostnames)) {
    throw new Error(
      `qialike desktop: refused an IPC call on ${event.senderFrame === null ? 'a detached frame' : frameUrl}; `
      + `this channel accepts only ${(hostnames ?? [APP_HOSTNAME]).join(', ')} documents.`,
    )
  }
}

/**
 * The boot payload the renderer needs to start the client.
 *
 * `injections` are the Host's index rows — the module table and the bootstrap
 * batches. `streamBaseUrl` is the Host origin the client opens its WebSocket
 * against, which is not the application origin: the socket goes to the Host
 * directly so the shell is not in the streaming path.
 */
export interface DesktopBootPayload {
  readonly injections: readonly unknown[]
  readonly streamBaseUrl: string
  /** The product version, for the About panel and the version footer. */
  readonly version: string
  /** The release channel, when the build carries one. */
  readonly channel?: string
}

/**
 * What the preload exposes to the product document.
 *
 * Declared here rather than in the preload so the renderer's TypeScript can name
 * it without importing anything from the main process.
 */
export interface DesktopBridge {
  readonly protocolVersion: number
  /** Resolve with the boot rows; rejects when the Host never became ready. */
  ready(): Promise<DesktopBootPayload>
  /** Report a client start failure, which the shell surfaces natively. */
  failed(message: string): void
  /** Native directory picker; null when the user cancels. */
  pickDirectory(): Promise<string | null>
  /**
   * Ask where to save, then write the text there.
   *
   * @param request - suggested file name, the serialized document, and its media type.
   * @returns the chosen absolute path, or null when the user cancelled.
   */
  saveDocument(request: { suggestedName: string, contents: string, mimeType: string }): Promise<string | null>
  /** The resolved application locale. */
  locale(): Promise<string>
}

/**
 * The update carrier the renderer reads at `globalThis.dshDesktop.updates`.
 *
 * Declared because it is a contract with **upstream's** client plugin, not ours:
 * `ui-settings-general`'s `DesktopUpdateSource` calls exactly three of them — `status`, `open` and
 * `subscribe` — and a renamed one is a status badge that silently stops updating. `check` and `download`
 * are additions this product made for its own Settings row; upstream never calls them, so their shape may
 * change without breaking it. The rest is copied from that package's `DesktopUpdateBridge`, deliberately
 * not simplified —
 * `subscribe` returning its own unsubscribe is what the client relies on to detach
 * when the sidebar collapses.
 */
export interface DesktopUpdateCarrier {
  /** The current presentation. */
  status(): Promise<UpdatePresentation>
  /** Ask the shell to show the update dialog, and to offer an install if ready. */
  open(): Promise<void>
    /**
     * Check now, WITHOUT downloading what it finds.
     *
     * The two extra members below are OURS, not upstream's: `DesktopUpdateSource` calls only the three it
     * needs, and adding to the object cannot break it. They exist because this product adds a Settings row
     * where the user asks whether there is an update — and a manual question must not silently start a
     * 200 MB download. Upstream's `open()` cannot express that: it checks and downloads in one motion.
     */
    check(): Promise<void>
    /** Download what a previous check found. */
    download(): Promise<void>
  /** Observe each new presentation; the return value detaches. */
  subscribe(listener: (state: UpdatePresentation) => void): () => void
}

/**
 * The global name the preload installs {@link DesktopBridge} under.
 *
 * WHY THIS IS THE HARNESS'S NAME AND NOT OURS. It was `qialikeDesktopBoot`, which cost
 * the product its live connection. The Web client's browser entry
 * (`apps/web/src/main.ts`) contains the only code that gives a shell-owned page its
 * `__DSH_TRANSPORT__`, and it is gated on finding a global **named** `dshDesktopBoot`:
 *
 *   const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
 *   if (desktop !== undefined) { ... transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl } ... }
 *
 * Under the other name that branch was dormant, so the transport global was never set,
 * the stream carrier fell back to `document.baseURI` — the `qialike-app:` origin, which
 * no socket can reach — and the client retried forever behind a window that rendered
 * correctly. Nothing logged, nothing threw, and HTTP worked throughout.
 *
 * The name is not documented anywhere in the upstream checkout (`grep` over every `.md`
 * and `.json` finds it only in the code), which is why this took a rendered window and a
 * DevTools console to find. It is recorded in `docs/UPSTREAM-NOTES.md` as a contract worth
 * documenting upstream. Meanwhile, adopting the name means the entry's own branch applies
 * the boot rows and resolves the gate, and this shell no longer reimplements any of it.
 */
export const BRIDGE_GLOBAL = 'dshDesktopBoot'

/**
 * The desktop marker's global name.
 *
 * A *different* global from {@link BRIDGE_GLOBAL}, and the distinction matters: this is
 * the harness's own marker, read by upstream client plugins to decide they are running in
 * a desktop application, so adding a member to it changes how those plugins behave. The
 * bridge is this shell's contract with the client entry and nothing else reads it.
 */
export const DESKTOP_MARKER_GLOBAL = 'dshDesktop'

/** Declaration for the renderer's TypeScript. */
declare global {
  // eslint-disable-next-line no-var
  var dshDesktopBoot: DesktopBridge | undefined
  // eslint-disable-next-line no-var
  var dshDesktop: { readonly protocolVersion: number; readonly updates?: DesktopUpdateCarrier } | undefined
}
