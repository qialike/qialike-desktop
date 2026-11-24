/**
 * The desktop Host: boot the `qialike-desktop` profile and report its
 * authenticated URL to the Electron shell over Node child-process IPC.
 *
 * This is the process the shell spawns with `ELECTRON_RUN_AS_NODE=1`. It is a
 * plain Cordis profile runner — the same one `dsh web` uses — pointed at a
 * different profile directory, which is what makes the desktop application the
 * browser surface rather than a reimplementation of it.
 *
 * WHAT THIS PROCESS OWNS. Only the profile boot and the shell's control
 * requests. It deliberately does **not** own the profile's *contents*: the shell
 * initializes the profile before spawning this process, exactly as upstream's
 * Electron shell owns `$DSH_HOME/profiles/desktop`. This process may create it
 * as a fallback so it can be run standalone during development, and
 * `initProfile` never overwrites an existing file, so both callers are safe.
 *
 * WHAT IS ABSENT VERSUS UPSTREAM. Upstream's `@deepseek-ai/dsh-desktop-host`
 * also mounts an Office engine, a bundled Python/Node/pnpm runtime, and a
 * Platform (DeepSeek account) session publisher. This application ships none of
 * them (DESIGN §3 D14, §12.1): it is a coding agent, not a document pipeline,
 * and it authenticates with provider API keys rather than a hosted account.
 *
 * @module @qialike/qialike-desktop-host
 */

import { join } from 'node:path'
import { inspect } from 'node:util'
// `PROFILE_TEMPLATES` MOVES OFF THIS SPECIFIER AGAIN IN 0.2.2-rc.1. Its history is worth keeping,
// because each move is invisible to the compiler and only shows up as a failed boot:
//   · up to 0.2.1-rc.2 — `dsh-app-boot` exported it
//   · 0.2.1-rc.3       — moved out; this file imported `@deepseek-ai/dsh-official-bundles`
//   · 0.2.1-rc.5       — back in `dsh-app-boot`, and the official-bundles package was deleted
//   · 0.2.2-rc.1       — the package returns and `app-boot` stops exporting it again
// Importing the wrong one fails at load (`Cannot find package …` / `does not provide an export
// named …`) while TypeScript stays satisfied by `types/harness.d.ts`, which is exactly how the
// rc.5 break reached a running build.
import { initProfile, loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
// The Peer the boot handshake's injection collector speaks for; 0.2.2-rc.1 requires it again.
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'

import { connectionOf, webServerOf } from './harness-context.ts'
import { installQuitInspection, type QuitInspection } from './quit-inspection.ts'

/** The shell's quit question, answered once per request. */
type QuitInspector = () => Promise<QuitInspection>

/** The profile this application owns; never `desktop` or `tui`. */
export const PROFILE_NAME = 'qialike-desktop'

/**
 * The port the Host binds.
 *
 * Chosen to sit beside the two ports this application may run alongside:
 * upstream's Electron shell uses 19387 and `dsh web` uses 3080. Nothing requires
 * a fixed port — the shell reads the bound port back from the ready message —
 * but a distinct default keeps the three from colliding during development.
 */
export const DEFAULT_PORT = 19388

/** Upper bound of the startup diagnostic carried over IPC; the head holds message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

/** Messages this Host sends to the shell. */
export type HostEvent =
  | { readonly type: 'ready'; readonly url: string; readonly injections: readonly unknown[] }
  | { readonly type: 'fatal'; readonly message: string; readonly diagnostic: string }
  | { readonly type: 'shutdown-complete' }
  | { readonly type: 'quit-inspection'; readonly requestId: number; readonly activeTasks: boolean; readonly scheduledTasks: boolean; readonly error?: string }

/** Messages the shell sends to this Host. */
interface ShellMessage {
  readonly type: string
  readonly requestId?: number
}

/**
 * Send one message to the shell, tolerating a disconnected channel.
 *
 * The shell may exit at any point, including between the readiness check and the
 * send. A failed control message must not crash a running profile, and a failed
 * readiness message cannot be recovered from, so both report through the return
 * value rather than throwing into the boot path.
 */
function send(message: HostEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
}

/**
 * Ensure the profile directory exists and names this application's bundles.
 *
 * `initProfile` writes only the files that are absent, so a profile the shell
 * already prepared — including one a user has since added plugins to — is left
 * untouched. `PROFILE_TEMPLATES` has no entry for our profile name, so the
 * bundle list comes from the descriptor the shell passes in, falling back to the
 * built-in list when this process runs standalone.
 *
 * @param profileDir - `$DSH_HOME/profiles/<name>`.
 * @param bundles - bundle layers, in application order.
 */
export function ensureProfile(profileDir: string, bundles: readonly string[]): void {
  const template = PROFILE_TEMPLATES[PROFILE_NAME]
  initProfile(profileDir, template?.bundles ?? [...bundles])
}

/**
 * Boot the profile and wire the shell's control channel.
 *
 * @param options - argv-derived inputs.
 * @returns a promise that settles when the profile has shut down.
 */
export async function main(options: {
  runtimeDir: string
  projectDir: string
  profileDir?: string
  port: number
  bundles: readonly string[]
}): Promise<void> {
  const { runtimeDir, projectDir, port, bundles } = options
  const profileDir = options.profileDir ?? projectDir
  ensureProfile(profileDir, bundles)

  // The install anchor is the runtime's own `dsh` manifest. Every bundle this
  // application composes resolves from the runtime tree beside it, never from a
  // global install, which is what lets the application run with no `dsh` on PATH.
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
  reportSkippedBundles('dsh', profile)

  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: PROFILE_NAME,
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    // `--no-open` because Electron owns the window: the Host must not hand the
    // URL to the system browser as `dsh web` does.
    args: ['--no-open', '--port', String(port)],
  })

  let stopping: Promise<void> | undefined
  let quitInspection: QuitInspector | undefined

  const stop = (): Promise<void> => stopping ??= (async () => {
    // A startup failure is reported by main(); shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()

  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    const request = message as ShellMessage
    if (request.type === 'shutdown') { void stop(); return }
    if (request.type !== 'quit-inspection') return
    if (!Number.isSafeInteger(request.requestId)) return
    const requestId = request.requestId as number
    void (async () => {
      try {
        if (stopping !== undefined || quitInspection === undefined) {
          throw new Error('qialike desktop quit: the Host is unavailable')
        }
        await send({ type: 'quit-inspection', requestId, ...(await quitInspection()) })
      } catch (error) {
        // The shell treats an unknown state as interruptible work and asks before
        // quitting, which is the safe direction: a spurious prompt costs a click,
        // a missed one loses a running task.
        await send({
          type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })().catch((error: unknown) => { console.error(error) })
  })

  process.once('disconnect', () => { void stop() })

  const { ctx } = await application
  quitInspection = installQuitInspection(ctx)

  const webServer = webServerOf(ctx)
  // KEEP-ALIVE TIMEOUTS, SET EXPLICITLY BECAUSE THE DEFAULT PAIR DISAGREES WITH OUR CLIENT.
  //
  // The Host's server is an upstream `http.Server` that sets none of these, so it runs on Node's
  // defaults: `keepAliveTimeout` 5 s and `headersTimeout` 60 s. The shell forwards through the
  // global `fetch` (undici), which pools connections far longer than 5 s. The pool therefore hands
  // back sockets this server has already closed, the request is written into a connection nothing
  // will answer, and — because a closed idle socket sends no RST — the failure stays invisible
  // until `headersTimeout` expires a minute later.
  //
  // MEASURED on a packaged build before this was set: the same URL answered in 61,526 ms with the
  // shell's 502 "the desktop Host is unreachable", then in 28 ms with a 200 on the very next call.
  // A 9-byte 404 hung identically, so neither payload size nor any single route was involved, and
  // every hung call landed between 60 and 92 s.
  //
  // `keepAliveTimeout` is raised well above any plausible client idle interval, and
  // `headersTimeout` is kept above it as Node requires — a smaller `headersTimeout` would abort a
  // connection that is merely idle between requests. The shell also sends `connection: close`, so
  // the two layers agree rather than race.
  const server = (webServer as unknown as {
    server?: { keepAliveTimeout: number, headersTimeout: number }
  }).server
  if (server !== undefined) {
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
  }
  // Read the bound port back rather than echoing the requested one: the profile
  // may be configured to bind port 0, and the shell's proxy must forward to
  // whatever was actually bound.
    // THE URL COMES FROM `connection.authenticatedUrl()` AGAIN, FOR THE FOURTH TIME.
    //
    // The interface history is worth keeping because every step fails at BOOT rather than at compile
    // time, so a build that typechecks proves nothing: a method here up to 0.2.1-rc.2; a
    // `webserver/entry-url` event that `dsh-authentication-token` subscribed to in 0.2.1-rc.3 and
    // 0.2.2-rc.3; and now the method again, with that package deleted. `packages/bundle/web-app`
    // announces its own address with `connection.authenticatedUrl(webUrl)`, which is what makes this
    // the supported path rather than a fallback.
    const url = connectionOf(ctx).authenticatedUrl(`http://127.0.0.1:${String(webServer.port)}`)
  // THE PEER IS BACK, FOR THE THIRD TIME IN THIS INTERFACE'S HISTORY.
  //
  // rc.3 made it `collectIndexInjections(peer)` and `dsh-api-remote-access` read `peer.principal`;
  // rc.5 withdrew that (the collector took no argument and the subscriber pushed a constant owner
  // baseline); 0.2.2-rc.1 restores it, and the restores are not cosmetic — called with no argument
  // the Host dies on boot with `Cannot read properties of undefined (reading 'principal')`.
  //
  // `owner` is the honest principal rather than a placeholder: this process is the application
  // itself, opening its own window against its own Host, and upstream uses the same frozen literal
  // for that case. A Peer per boot is also what the subscriber expects — it looks the principal up
  // to choose which access snapshot to inject, so a shared stand-in would answer for the wrong
  // caller the day a non-owner connects.
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  try {
    await send({ type: 'ready', url, injections: webServer.collectIndexInjections(peer) })
  } finally {
    // The Peer owns a child scope; the handshake is its only use, so it is disposed rather than
    // left holding a fiber for the life of the process.
    await peer.dispose()
  }
}

/**
 * Parse the Host's positional and flag arguments.
 *
 * Positional rather than flagged for the two paths, matching upstream: the shell
 * builds this argv itself and the values are never user-supplied.
 *
 *   argv[2] runtimeDir   the assembled runtime tree
 *   argv[3] projectDir   the profile directory, and this process's cwd
 *   --port <n>           bind port
 *   --bundles <a,b,c>    bundle layers, in application order
 */
export function parseHostArgs(argv: readonly string[]): {
  runtimeDir: string
  projectDir: string
  port: number
  bundles: string[]
} {
  const runtimeDir = argv[2]
  const projectDir = argv[3]
  if (runtimeDir === undefined || projectDir === undefined) {
    throw new Error('qialike-desktop-host: usage: <runtimeDir> <projectDir> [--port <n>] [--bundles <a,b,c>]')
  }
  let port = DEFAULT_PORT
  let bundles: string[] = []
  for (let index = 4; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--port') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`qialike-desktop-host: --port must be an integer in 0..65535, received ${JSON.stringify(argv[index + 1])}`)
      }
      port = value
      index += 1
      continue
    }
    if (flag === '--bundles') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('qialike-desktop-host: --bundles needs a comma-separated list')
      bundles = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      index += 1
      continue
    }
    throw new Error(`qialike-desktop-host: unknown argument ${JSON.stringify(flag)}`)
  }
  return { runtimeDir, projectDir, port, bundles }
}

if (import.meta.main) {
  const parsed = parseHostArgs(process.argv)
  main(parsed).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here rather than through
    // stderr: stderr bytes and this IPC message race, and the shell reports the
    // first failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    void send({ type: 'fatal', message, diagnostic })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
