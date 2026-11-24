/**
 * Can the Office engine actually start, and what is it missing when it cannot?
 *
 * WHY THIS MOVED OUT OF THE SHELL. It began in `apps/desktop/src/office-runtime.ts`, where the shell
 * ran it once per launch and put the answer in a modal dialog. That put the diagnosis in front of
 * every user on every start — including the majority, who never open an Office document — and put it
 * nowhere near the control that fixes it. It lives here now, behind the same row that installs the
 * engine, so the question is asked when the user is looking at the answer.
 *
 * The shell was the wrong owner for a second reason: this is a fact about the runtime tree and the
 * on-demand install root, both of which belong to the Host. The shell had to re-derive the install
 * layout (`INSTALL_ROOT_SEGMENTS`) and keep it in step with this package's writer. That mirror is
 * gone with it.
 *
 * WHY A PROBE RATHER THAN A FILE LIST. The engine is a worker that requires arguments: invoked with
 * none it answers `{"ok":false,…,"error":"Worker requires absolute paths"}` and exits 1. That reply
 * is the signal, not the exit code — a process that cannot resolve its imports never reaches its own
 * argument parsing and prints nothing, and both cases exit non-zero. Measured on Windows
 * 10.0.26300: 107 ms when the runtime resolves, 38 ms and no output at all when it does not. Two
 * cheaper checks were measured and rejected: the file list in `System32` and the `VC\Runtimes\x64`
 * registry value both stay positive on a machine where the loader still cannot start the engine,
 * because they describe the system copy rather than the search the failed process actually performed.
 *
 * @module @qialike/qialike-desktop-office-engine/diagnose
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The Microsoft download the row offers when the runtime cannot start the engine.
 *
 * THE INSTALLER, NOT THE PAGE ABOUT IT. `aka.ms/vc14/vc_redist.x64.exe` is Microsoft's own stable
 * alias for the current v14 x64 package; measured 2026-10-22 it redirects through
 * `aka.ms/vs/18/release/vc_redist.x64.exe` to an 18,731,856-byte installer. Served to the client in
 * the response rather than copied into the browser bundle, so the address has one home.
 *
 * NOTHING IS EXECUTED HERE. The client renders it as an ordinary external link; the shell hands it
 * to the user's browser, which downloads the file and leaves running it to the user. That is the
 * property that keeps this application from ever having to elevate.
 */
export const VC_REDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe'

/**
 * How long the probe waits for the engine to answer.
 *
 * Generous against a measured 107 ms: a cold start on a loaded machine, or an on-access virus
 * scanner reading a 170 MB executable for the first time, is slower than the steady state. A
 * timeout is reported as "could not be asked", never as "broken", so an unusually slow machine does
 * not produce advice to install something the user already has.
 */
export const PROBE_TIMEOUT_MS = 20_000

/** Where the runtime requirement is recorded by the build. */
const DESCRIPTOR_FILE = 'desktop-runtime.json'

/**
 * The engine package this check knows about.
 *
 * Windows-only, and the module is too: the MSVC runtime it reports on is what a Windows engine
 * loads. Everywhere else there is no engine at this path and the check reports `skipped`, which is
 * the honest answer rather than a Windows-specific failure.
 */
const ENGINE_TARGET = 'win32-x64'

/** The engine executable's name inside its package's `bin`. */
const ENGINE_EXECUTABLE = 'libreoffice-kit.exe'

/** Where the on-demand installer writes engines, relative to `$DSH_HOME`. Mirrors `engineInstallRoot`. */
const INSTALL_ROOT_SEGMENTS = ['engines', 'libreoffice-kit']

/**
 * `$DSH_HOME`, resolved without the harness.
 *
 * WHY NOT `@deepseek-ai/dsh-home-paths`, WHICH THE REST OF THIS PACKAGE USES. That package resolves
 * only from the assembled runtime tree, and this module is also loaded from the workspace — by its
 * own tests, and by anything that asks the question outside a running Host. A static import turned
 * the whole suite into `Cannot find package '@deepseek-ai/dsh-home-paths'`.
 *
 * The rule it reimplements is two lines and deliberately identical: `DSH_HOME` when set, else
 * `~/.dsh`. The caller that has the harness (`index.js`) passes its answer in explicitly, so the
 * production path keeps using the harness's resolution and only the fallback lives here.
 *
 * @returns {string} the home directory to look for installed engines under.
 */
function defaultHome() {
  const override = (process.env.DSH_HOME ?? '').trim()
  return override.length > 0 ? resolve(override) : join(homedir(), '.dsh')
}

/**
 * The outcome of asking whether the engine can start.
 *
 * `skipped` and `broken` are separate outcomes on purpose. "There is no engine" and "the engine
 * could not be asked" are not failures of the user's machine, and neither should produce advice to
 * install the Visual C++ runtime.
 *
 * @typedef {{ kind: 'ready' }
 *   | { kind: 'skipped', reason: string }
 *   | { kind: 'broken', missing: readonly string[], outcome: string }} OfficeEngineStatus
 */

/**
 * Parse a version string into comparable segments.
 *
 * @param {string | undefined} value - a version, optionally prefixed with `v` and carrying a pre-release suffix.
 * @returns {number[] | undefined} the numeric segments, or undefined when the value is not a version.
 */
export function parseVersion(value) {
  if (value === undefined) return undefined
  const core = value.trim().replace(/^v/u, '').split(/[+-]/u)[0]
  if (core === undefined || core === '') return undefined
  const segments = []
  for (const segment of core.split('.')) {
    if (!/^\d+$/u.test(segment)) return undefined
    segments.push(Number(segment))
  }
  return segments.length === 0 ? undefined : segments
}

/**
 * Compare two parsed versions.
 *
 * @param {readonly number[]} left - the first version.
 * @param {readonly number[]} right - the second version.
 * @returns {number} a negative number, zero, or a positive number, as usual.
 */
export function compareVersions(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * The engine's path inside a runtime tree, and the descriptor that records what it needs.
 *
 * @param {string} runtimeDir - the assembled runtime tree.
 * @returns {{ engine: string, descriptor: string }} the two paths this module reads.
 */
function enginePaths(runtimeDir) {
  return {
    engine: join(runtimeDir, 'node_modules', '@deepseek-ai', `libreoffice-kit-${ENGINE_TARGET}`, 'bin', ENGINE_EXECUTABLE),
    descriptor: join(runtimeDir, DESCRIPTOR_FILE),
  }
}

/**
 * One engine the on-demand installer wrote, at the layout it uses.
 *
 * @param {string} installRoot - `$DSH_HOME/engines/libreoffice-kit`.
 * @param {string} version - the version directory, as the installer named it.
 * @returns {string} the engine executable's absolute path, whether or not it exists.
 */
function installedEnginePath(installRoot, version) {
  return join(
    installRoot, version, ENGINE_TARGET,
    'node_modules', '@deepseek-ai', `libreoffice-kit-${ENGINE_TARGET}`,
    'bin', ENGINE_EXECUTABLE,
  )
}

/**
 * The engine executables this check may probe, most authoritative first.
 *
 * THE INSTALL ROOT IS CONSULTED, AND THAT IS NOT OPTIONAL. A build may leave the engine out
 * (`QIALIKE_DESKTOP_OFFICE_ENGINE=plugin`, the default on Windows), and then the only engine on the
 * machine is one the on-demand installer put under `$DSH_HOME`. A check that looked at the tree
 * alone would answer `skipped` — "there is no engine", which correctly shows nothing — and would
 * stop answering on exactly the machine that still needs the answer, because an installed engine
 * loads the same MSVC runtime as a shipped one and fails the same way without it.
 *
 * The tree comes first because that is the order the kit itself resolves in: its own directory is
 * searched before `NODE_PATH`, so an engine still in the tree is the one whose failure a user sees.
 * Among installed versions the newest is first, which is a preference about which path to *name*
 * rather than a claim about which one the kit would load — the kit enforces its own exact version,
 * and one engine per machine is the normal state.
 *
 * @param {{ runtimeDir: string, home: string }} options - the tree to serve from and `$DSH_HOME`.
 * @returns {readonly string[]} absolute engine paths, possibly empty; never throws on an unreadable root.
 */
export function engineCandidates(options) {
  const installRoot = join(options.home, ...INSTALL_ROOT_SEGMENTS)
  let entries
  try {
    entries = readdirSync(installRoot)
  } catch {
    // An absent root is the normal state of a machine that never installed an engine, and an
    // unreadable one is not a reason to fail a question. Both leave the tree's engine alone.
    entries = []
  }
  const installed = []
  for (const entry of entries) {
    const version = parseVersion(entry)
    if (version === undefined) continue
    installed.push({ version, path: installedEnginePath(installRoot, entry) })
  }
  installed.sort((left, right) => compareVersions(right.version, left.version))
  return [enginePaths(options.runtimeDir).engine, ...installed.map((entry) => entry.path)]
}

/**
 * The runtime DLLs the build recorded for this tree's engine.
 *
 * Read from the descriptor rather than recomputed here: the build derives them from the engine
 * binary's import table, and a second derivation would be a second answer to one question. An absent
 * or older descriptor yields an empty list, which costs the file names but not the verdict.
 *
 * @param {string} descriptorPath - the runtime descriptor.
 * @returns {readonly string[]} the recorded names, or an empty list.
 */
export function recordedRuntimeRequirements(descriptorPath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch {
    return []
  }
  const runtime = parsed?.engineRuntime
  const required = runtime?.required
  if (!Array.isArray(required)) return []
  return required.filter((name) => typeof name === 'string' && name.length > 0)
}

/**
 * Which of the engine's requirements the loader would not find.
 *
 * The search order is modelled as the loader performs it for this case: the engine's own directory
 * first, then `System32`. Anywhere else requires a manifest, a `PATH` entry the engine does not
 * have, or a redirection this application does not install. `System32` is consulted explicitly
 * rather than assumed because these are not Windows components — `ucrtbase.dll` and the
 * `api-ms-win-crt-*` set are supplied by the operating system and are excluded upstream, while the
 * MSVC families come from a separate installation.
 *
 * This runs only after the probe has already failed, so a name reported missing is consistent with
 * an engine that genuinely could not start; it is a naming step, not the verdict.
 *
 * @param {{ engine: string, required: readonly string[], env?: NodeJS.ProcessEnv }} options - the
 *   engine executable, the recorded requirement names, and the environment for `SystemRoot`.
 * @returns {readonly string[]} the names found in neither location.
 */
export function unresolvedRuntimeDlls(options) {
  const env = options.env ?? process.env
  const engineDir = join(options.engine, '..')
  const system32 = env.SystemRoot === undefined || env.SystemRoot === '' ? undefined : join(env.SystemRoot, 'System32')
  return options.required.filter((name) => {
    if (existsSync(join(engineDir, name))) return false
    if (system32 !== undefined && existsSync(join(system32, name))) return false
    return true
  })
}

/**
 * Ask the engine binary whether it can start at all.
 *
 * The engine is spawned with no arguments deliberately. It is a worker that rejects a bare
 * invocation, so any output at all proves the loader resolved every import and the process reached
 * its own code — which is the question, and one no file listing can answer from the outside.
 *
 * @param {string} program - the executable to probe.
 * @param {{ timeoutMs?: number, args?: readonly string[] }} [options] - the bound, and arguments for
 *   `program`. Production passes none, and the engine's answer to a bare invocation is the whole
 *   signal. The parameter exists so the outcome branches can be driven by a scripted program, rather
 *   than by breaking a real engine to reach them.
 * @returns {Promise<{ spoke: boolean, outcome: string }>} whether the program said anything, and the
 *   outcome to report.
 */
export function askEngineToStart(program, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const args = [...(options.args ?? [])]
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish({ spoke: false, outcome: error instanceof Error ? error.message : String(error) })
      return
    }
    let output = ''
    const collect = (chunk) => { output += chunk.toString('utf8') }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const timer = setTimeout(() => {
      child.kill()
      finish({ spoke: false, outcome: `no answer within ${String(timeoutMs)} ms` })
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ spoke: false, outcome: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (output.trim() !== '') {
        finish({ spoke: true, outcome: 'the engine answered' })
        return
      }
      const status = code === null ? `killed by ${String(signal)}` : `exit 0x${(code >>> 0).toString(16).toUpperCase()}`
      finish({ spoke: false, outcome: `the engine produced no output (${status})` })
    })
  })
}

/**
 * Check whether the Office engine can start, and name what it is missing when it cannot.
 *
 * The engine probed is the first candidate that exists — the tree's, or one the on-demand installer
 * wrote under `$DSH_HOME`. `missing` is then resolved against THAT engine's own directory, which is
 * the search the failed process actually performed.
 *
 * @param {{ runtimeDir: string, env?: NodeJS.ProcessEnv, home?: string,
 *   probe?: (engine: string) => Promise<{ spoke: boolean, outcome: string }> }} options - the tree to
 *   serve from, the environment `System32` is resolved from, `$DSH_HOME`, and a probe override used
 *   only by tests.
 * @returns {Promise<OfficeEngineStatus>} the status the row reports.
 */
export async function checkOfficeEngine(options) {
  const home = options.home ?? defaultHome()
  const candidates = engineCandidates({ runtimeDir: options.runtimeDir, home })
  const engine = candidates.find((path) => existsSync(path))
  if (engine === undefined) {
    return {
      kind: 'skipped',
      reason: `no Office engine at ${enginePaths(options.runtimeDir).engine}, `
        + `nor under ${join(home, ...INSTALL_ROOT_SEGMENTS)}`,
    }
  }
  const probe = options.probe ?? ((path) => askEngineToStart(path))
  const { spoke, outcome } = await probe(engine)
  if (spoke) return { kind: 'ready' }

  const required = recordedRuntimeRequirements(enginePaths(options.runtimeDir).descriptor)
  return { kind: 'broken', missing: unresolvedRuntimeDlls({ engine, required, env: options.env }), outcome }
}
