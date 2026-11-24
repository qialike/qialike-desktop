/**
 * The office-engine row's host half: what the engine's state is, and installing one on request.
 *
 * WHY A ROW RATHER THAN SHELL CODE. The engine is resolved by `@deepseek-ai/libreoffice-kit`, which
 * runs in the *Host* process — so the process that has to be able to resolve an installed engine is
 * the Host, and a Cordis row is mounted in it. That is what makes one row sufficient: the shell
 * never resolves the engine as a module, so there is nothing for the shell to configure.
 *
 * WHY THE SEARCH PATH IS SET HERE AND NOWHERE ELSE. `NODE_PATH` is appended to
 * `require.resolve.paths()`, which is the list the kit resolves its engine through. Setting it has
 * no effect on its own — Node builds its global path list once at bootstrap — so the change is
 * followed by `Module._initPaths()`, and MEASURED: a module's own `createRequire` sees a path added
 * this way, in the same process, with no restart. That is the whole of the "installed and usable"
 * mechanism, and it is why the row applies it both when an install finishes and when it mounts (an
 * engine installed by a previous run has to work on a cold start too).
 *
 * WHY THE ROW INTERPRETS NOTHING ABOUT THE ENGINE. The adapter and the engine are two packages and
 * only the engine is large; the decision to leave the engine out is a *build* decision
 * (`QIALIKE_DESKTOP_OFFICE_ENGINE`), recorded in the runtime descriptor. This row reads the
 * resulting state rather than a flag, so a tree that carries an engine reports `bundled` and offers
 * nothing — one code path for both kinds of build.
 *
 * @module @qialike/qialike-desktop-office-engine
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { VC_REDIST_URL, checkOfficeEngine } from './diagnose.js'
import {
  NODE_PATH_SEPARATOR,
  bundledEngineVersion,
  engineInstallRoot,
  enginePackageCandidates,
  enginePackageDir,
  engineSearchDir,
  engineVersion,
  resolveEngineSource,
  installEngine,
  readInstalledVersion,
} from './install.js'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-office-engine'

/** The one route this row serves. */
export const API_PATH = '/api/qialike/office-engine'

/** The adapter package, whose sibling directory is where a bundled engine sits. */
const KIT_PACKAGE = '@deepseek-ai/libreoffice-kit'

/** Resolve from this module, which lives in the runtime tree beside both packages. */
const require_ = createRequire(import.meta.url)

/**
 * Whether this host reports glibc, which is what decides if Linux has a native engine at all.
 *
 * The kit asks `process.report.getReport().header.glibcVersionRuntime`, and mirrors of that rule
 * have to agree with it or this row would offer an engine the kit will not look for. musl Linux
 * answers no, and falls back to WebAssembly — the same fallback the kit makes.
 *
 * @returns whether glibc is present.
 */
function hostGlibc() {
  if (process.platform !== 'linux') return true
  try {
    return process.report.getReport().header?.glibcVersionRuntime !== undefined
  } catch {
    // Unreadable report: claim no glibc, which selects the WebAssembly engine. The other direction
    // would name a native package that may not exist for this host, and the download would be the
    // way that was discovered.
    return false
  }
}

/** The adapter's directory, or undefined when it cannot be resolved. */
function kitDirectory() {
  try {
    return dirname(require_.resolve(`${KIT_PACKAGE}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * The runtime tree this row is mounted from, derived from the adapter's own location.
 *
 * WHY DERIVED RATHER THAN PASSED IN. The engine a build ships sits at
 * `<runtime>/node_modules/@deepseek-ai/libreoffice-kit-<target>/bin`, and the adapter resolves from
 * the same `node_modules`, so the tree root is three directories above the kit:
 * `<runtime>/node_modules/@deepseek-ai/libreoffice-kit` -> `@deepseek-ai` -> `node_modules` -> tree.
 *
 * The alternative was a path handed down from the shell, and that is the coupling this module was
 * moved here to remove: in a deployment with no Electron shell there is nobody to hand it down.
 *
 * @returns the runtime tree root, or undefined when the adapter does not resolve.
 */
function runtimeTree() {
  const kit = kitDirectory()
  return kit === undefined ? undefined : join(kit, '..', '..', '..')
}

/**
 * Everything this row knows about the engine without touching the network.
 *
 * EVERY CANDIDATE IS DESCRIBED, not just the preferred one, because "is there an engine" is a
 * question about the host rather than about one package: on Linux the kit prefers a native engine
 * that is not published, and falls back to WebAssembly, so a row that only looked at the preferred
 * name would report `missing` on a machine where the wasm engine is installed and working.
 *
 * @returns the description, or `{ known: false }` when the adapter cannot be resolved.
 */
export function describeEngine() {
  const kit = kitDirectory()
  if (kit === undefined) {
    return { known: false, why: `cannot resolve ${KIT_PACKAGE} from this runtime tree` }
  }
  const glibc = hostGlibc()
  const version = engineVersion(kit)
  const home = dshHomePath()
  const candidates = enginePackageCandidates(process.platform, process.arch, { glibc }).map((candidate) => {
    const root = engineInstallRoot(home, version, candidate.target)
    const packageDir = enginePackageDir(root, candidate.name)
    return {
      ...candidate,
      root,
      packageDir,
      bundled: bundledEngineVersion(kit, candidate.name),
      installed: readInstalledVersion(packageDir),
    }
  })
  // `bundled` wins over `installed`, because that is the order the resolver sees: the tree's own
  // `node_modules` comes before anything on `NODE_PATH`.
  const usable = candidates.find((candidate) => candidate.bundled === version)
    ?? candidates.find((candidate) => candidate.installed === version)
  const mode = usable === undefined
    ? 'missing'
    : usable.bundled === version ? 'bundled' : 'installed'
  return { known: true, version, home, candidates, mode, usable }
}

/**
 * Add one directory to `NODE_PATH` and rebuild Node's global resolution paths.
 *
 * @param directory - the directory to add.
 * @returns whether the path list changed.
 */
export function applySearchPath(directory) {
  const current = (process.env.NODE_PATH ?? '').split(NODE_PATH_SEPARATOR).filter((part) => part !== '')
  const changed = !current.includes(directory)
  if (changed) process.env.NODE_PATH = [...current, directory].join(NODE_PATH_SEPARATOR)
  // Rebuilt even when the list did not change: `_initPaths` is what makes the list effective, and a
  // caller that asks for a path is a caller that needs it to resolve right now.
  initPaths()
  return changed
}

/**
 * Rebuild Node's global module paths from the current `NODE_PATH`.
 *
 * `Module._initPaths` IS INTERNAL, and there is no public equivalent — which is why the call is
 * guarded rather than assumed, and why a failure is reported instead of thrown: an engine that
 * installs and needs a restart is a worse experience than one that installs and works, but a
 * strictly better one than a crash. The contract lock in `tests/office-engine-install.test.mjs`
 * fails if the function stops existing, so this cannot rot in silence.
 *
 * @returns whether the rebuild happened.
 */
export function initPaths() {
  try {
    const module_ = require_('node:module')
    if (typeof module_._initPaths !== 'function') return false
    module_._initPaths()
    return true
  } catch {
    return false
  }
}

/**
 * The install job's state, as the interface reads it.
 *
 * Module-level because there is one engine and one install per process; a second concurrent
 * install would download 46 MiB twice to write the same directory.
 */
let job = { phase: 'idle' }

/** Whether an install is running. */
const busy = () => job.phase !== 'idle' && job.phase !== 'done' && job.phase !== 'failed'

/**
 * Resolve what installing would fetch, and how large it is.
 *
 * A SEPARATE STEP BECAUSE IT NEEDS THE NETWORK. The status route answers from local state so the
 * interface can render immediately; this one is asked for when the user shows interest, and its
 * cost is a few kilobytes of JSON. The sizes come from the registry's own metadata rather than a
 * number written down here, which would be wrong the moment the engine is updated.
 *
 * WHY IT WALKS THE CANDIDATES. The kit's preferred engine on Linux is a native package that is not
 * published, so asking the registry about the first candidate is expected to answer 404 and is not a
 * failure — the next candidate is the one that exists. Reporting "unreachable" for that would be
 * wrong about a host the kit can serve.
 *
 * @param described - the engine description.
 * @param fetchImpl - injectable for tests.
 * @returns `{ registry, packageName, target, downloadBytes, unpackedBytes }`.
 * @throws Error when no candidate exists on any registry.
 */
export async function planInstall(described, fetchImpl = fetch) {
  // DELEGATED, NOT REIMPLEMENTED. This walked the candidates and the registries itself until the
  // same walk was needed inside `installEngine` for callers that do not plan first; two copies of
  // "which source" is the kind of thing that drifts, and the copy here would have been the one
  // that was right while the library stayed broken. The library owns the walk; this reshapes its
  // answer for the interface.
  const resolved = await resolveEngineSource({
    platform: process.platform,
    arch: process.arch,
    glibc: hostGlibc(),
    version: described.version,
    fetchImpl,
  })
  return {
    registry: resolved.registry,
    packageName: resolved.candidate.name,
    target: resolved.candidate.target,
    downloadBytes: resolved.downloadBytes,
    unpackedBytes: resolved.unpackedBytes,
  }
}

/**
 * Start installing the engine, and report progress through {@link job}.
 *
 * @param described - the engine description.
 * @param log - diagnostic sink.
 */
function startInstall(described, plan, log) {
  job = { phase: 'resolving' }
  void (async () => {
    try {
      const result = await installEngine({
        platform: process.platform,
        arch: process.arch,
        glibc: hostGlibc(),
        version: described.version,
        home: described.home,
        // The candidate the plan found, rather than the preferred one: on Linux those differ.
        packageName: plan.packageName,
        registry: plan.registry,
        onProgress: (update) => { job = { ...update } },
        log,
      })
      // Wired only after the bytes are on disk and verified, so a failed install cannot leave the
      // resolver pointed at a directory that does not hold an engine. Every candidate root goes on
      // the path, so the kit's own choice of engine is what decides which one is found.
      // The `node_modules` directory of each candidate root, not the root: a `NODE_PATH` entry is
      // searched as though it were a `node_modules` directory itself, so the root above it resolves
      // nothing. See `engineSearchDir`.
      const wired = described.candidates
        .map((candidate) => applySearchPath(engineSearchDir(candidate.root)))
        .includes(true)
      job = { phase: 'done', files: result.files, wired, packageName: plan.packageName }
    } catch (error) {
      job = { phase: 'failed', failure: error instanceof Error ? error.message : String(error) }
    }
  })()
}

/** JSON response helper. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Read a JSON object body. */
async function readBody(request) {
  try {
    const parsed = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'the body must be a JSON object'
    }
    return parsed
  } catch {
    return 'the body must be valid JSON'
  }
}

/**
 * Mount the route.
 *
 * Registered through `ctx.inject` rather than a hard `inject` entry, for the reason the settings row
 * gives: a profile with no connection has no browser surface to serve, and this row should stay
 * mountable there rather than being held pending forever.
 *
 * @param ctx - the host context this row is mounted in.
 */
export function apply(ctx) {
  const log = (message) => { console.log(`qialike desktop: ${message}`) }

  // An engine installed by a previous run has to be resolvable on this one, and nothing else in
  // this process will say so. Done at mount rather than lazily at the first conversion, because by
  // then the kit may already have been asked and refused.
  const atMount = describeEngine()
  if (atMount.known && atMount.mode === 'installed') {
    // Every candidate root, not only the installed one: NODE_PATH is a list of places to look, and
    // the kit asks for whichever package name it decided on. Adding all of them lets that decision
    // be the kit's, rather than this row having to predict it.
    for (const candidate of atMount.candidates) applySearchPath(engineSearchDir(candidate.root))
    // `usable.root`, NOT `root`. `describeEngine()` returns `{ known, version, home, candidates,
    // mode, usable }` — the chosen candidate is a nested object, so the top-level `root` is
    // `undefined` and this line printed `found at undefined` from the day it was written until
    // 0.4.7. Nothing failed: the engine was found, wired and used, and only the one sentence that
    // existed to say so was wrong — which is the kind of defect that teaches a reader to distrust
    // the log rather than to read it.
    log(`office-engine: ${atMount.usable.packageName ?? atMount.usable.name}@${atMount.version} found at ${atMount.usable.root}`)
  }

  /**
   * The plan the interface last asked for, reused by an install that follows it.
   *
   * A memo rather than a requirement: `install` plans on its own when this is absent.
   */
  let planned

  /**
   * The last answer the engine gave about whether it can start, and when it gave it.
   *
   * CACHED BECAUSE THE PROBE IS NOT FREE. It spawns a 170 MB executable (measured 107 ms when the
   * runtime resolves), and the panel asks for its state on a timer while an install runs. Probing on
   * every poll would launch that process dozens of times for one question whose answer cannot change
   * in between.
   *
   * INVALIDATED BY AN INSTALL, which is the one event that can change the answer, and by the TTL for
   * the case nothing here controls: the user installing the Visual C++ runtime while this row sits
   * open. Two minutes is long enough that polling costs one probe and short enough that a user who
   * fixes the machine sees it without a restart.
   */
  let probed
  const PROBE_TTL_MS = 120_000

  /**
   * Ask the engine whether it starts, reusing an answer that is still fresh.
   *
   * @returns the diagnosis, or `undefined` when there is no engine to ask.
   */
  async function probeEngine() {
    const now = Date.now()
    if (probed !== undefined && now - probed.at < PROBE_TTL_MS) return probed.value
    const runtime = runtimeTree()
    if (runtime === undefined) return { kind: 'skipped', reason: `cannot resolve ${KIT_PACKAGE} from this runtime tree` }
    // `home` passed explicitly: the harness owns the `$DSH_HOME` rule in production, and the
    // fallback inside `diagnose.js` exists only for callers that load it outside a Host.
    const value = await checkOfficeEngine({ runtimeDir: runtime, home: dshHomePath() })
    probed = { at: Date.now(), value }
    return value
  }

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    scope.effect(() => connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const described = describeEngine()
          if (!described.known) {
            return json({ ok: false, message: described.why }, 503)
          }
          if (request.method === 'GET') {
            return json({
              ok: true,
              mode: described.mode,
              version: described.version,
              // Where to get the runtime when the engine cannot start. Served rather than written
              // into the browser bundle so the address has one home, next to the probe that fails
              // when it is needed.
              redistUrl: VC_REDIST_URL,
              // The candidates, so the interface can say which engine a host would get without
              // asking the network. `installed` and `bundled` are per candidate on purpose: on Linux
              // the preferred one is unpublished, and one pair of fields could not say "the native
              // engine is absent and the wasm one is installed".
              candidates: described.candidates.map((candidate) => ({
                packageName: candidate.name,
                target: candidate.target,
                bundled: candidate.bundled,
                installed: candidate.installed,
              })),
              install: job,
            })
          }
          const body = await readBody(request)
          if (typeof body === 'string') return json({ ok: false, message: body }, 400)

          if (body.op === 'probe') {
            // `skipped` is a fact about the tree, not a fault: a build with the engine left out and
            // no install yet has nothing to run, and the panel says so from `mode` instead.
            const status = await probeEngine()
            return json({
              ok: true,
              kind: status.kind,
              missing: status.kind === 'broken' ? status.missing : [],
              outcome: status.kind === 'broken' ? status.outcome : '',
              reason: status.kind === 'skipped' ? status.reason : '',
              redistUrl: VC_REDIST_URL,
            })
          }
          if (body.op === 'plan') {
            planned = await planInstall(described)
            return json({ ok: true, ...planned })
          }
          if (body.op === 'install') {
            // Already resolvable means there is nothing to fetch. `bundled` is included because
            // installing an engine the tree already carries would download 46 MiB to shadow it.
            if (described.mode !== 'missing') {
              return json({ ok: true, alreadyPresent: described.mode })
            }
            if (busy()) return json({ ok: true, alreadyRunning: true })
            // Planned here when the interface never asked, so this route works on its own: a caller
            // should not have to know the order to call things in.
            planned = planned ?? await planInstall(described)
            // The engine about to be written is a different file from the one probed a moment ago,
            // so the cached answer is about a process that will no longer be the one launched.
            probed = undefined
            startInstall(described, planned, log)
            return json({ ok: true, started: true, packageName: planned.packageName, registry: planned.registry })
          }
          return json({ ok: false, message: `unknown op ${JSON.stringify(body.op)}` }, 400)
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-office-engine: install API')
  })
}
