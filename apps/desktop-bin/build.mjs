#!/usr/bin/env node
/**
 * The build entry point.
 *
 * Composes the runtime this application ships: gate the harness version, verify
 * the checkout is built, copy the package farm, apply the build-time patches,
 * select the target's native prebuilds, and record what was produced.
 *
 * The stage this runs today is the farm and its checks. Assembling the runtime
 * package tree, compiling this repository's own bundles, and driving
 * electron-builder are later milestones; each is a function called from
 * {@link main} with a `--`-prefixed mode so the pipeline stays inspectable at
 * every step rather than becoming one opaque run.
 *
 * @module qialike-desktop/build
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { applyHarnessPatches } from './lib/apply-patches.mjs'
import { stageWebFrontendSchemed } from './harness-patches/app-scheme.mjs'
import { applyWebShadow } from './lib/web-shadow.mjs'
import {
  copyFarm,
  expandClosureFromImports,
  externalDependencies,
  readPrebuilds,
  scanPackages,
  selectNativePrebuilds,
  verifyNativeBinaries,
} from './lib/harness-farm.mjs'
import { CLI_VERSION, HARNESS_VERSION_MAX, HARNESS_VERSION_MIN, assertCliCompatible, assertHarnessCompatible } from './lib/harness-version.mjs'
import {
  computeBundleClosure,
  installWorkspace,
  memberDir,
  officeEngineMode,
  pruneOfficeEngine,
  ROWLESS_PACKAGES,
  webFrontendMember,
  writeRuntimeDescriptor,
} from './lib/runtime-tree.mjs'
import { writeThirdPartyNotices } from './lib/third-party-notices.mjs'
import { compileCliPolicy } from './lib/cli-policy.mjs'
import { compileCliThemes } from './lib/cli-themes.mjs'
import { ENGINE_EXECUTABLE, describeEngineRuntime } from './lib/vc-runtime.mjs'
import {
  ownPackages, stageQialikeAppPackage, OUR_BUNDLE, POLICY_PACKAGE, PROVIDERS_PACKAGE, QIALIKE_APP_PACKAGE,
  THEME_PACKAGE,
} from './lib/own-packages.mjs'
import {
  DIST_DIR,
  FARM_DIR,
  PROFILE_BUNDLES,
  PROFILE_NAME,
  DEFAULT_PNPM_STORE,
  DSH_HARNESS_ENV,
  DSH_QIALIKE_ENV,
  QIALIKE_APP_STAGE_DIR,
  ROOT,
  SHELL_PATHS_FILE,
  TARGETS,
  WEB_DIST_DIR,
  WEB_PUBLIC_DIR,
  WEB_TEMPLATE_FILE,
  assertNotUpstream,
  harnessRoot,
  hostTarget,
  missingBuild,
  qialikeRoot,
  targetParts,
} from './lib/paths.mjs'

/**
 * Probes that a checkout has been built.
 *
 * Both upstream trees are consumed as built artifacts. Checking up front turns
 * "the farm silently copied TypeScript and the runtime cannot import it" into a
 * sentence naming the command to run (DESIGN §12.2 R9).
 */
const BUILD_PROBES = {
  harness: {
    probe: 'packages/bundle/base/lib/index.js',
    remedy: 'pnpm install && pnpm run build:lib:host && pnpm run build:lib:client',
    label: 'deepseek-harness',
  },
  qialike: {
    probe: 'packages/qialike-app/lib/index.js',
    remedy: 'pnpm build',
    label: 'qialike',
  },
}

/** Human-readable byte size. */
function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Fail with an actionable message when a checkout is absent or unbuilt.
 * @param label - which checkout, for the message.
 * @param root - its path.
 */
function requireBuilt(label, root) {
  const spec = BUILD_PROBES[label]
  const reason = missingBuild(root, spec.probe)
  if (reason === undefined) return
  throw new Error(
    `qialike-desktop: ${spec.label}: ${reason}\n`
    + `  · Build it first:  cd ${root} && ${spec.remedy}\n`
    + `  · Or point the build elsewhere:  DSH_${label.toUpperCase()}=/path/to/checkout`,
  )
}

/**
 * Verify the native prebuilds a target needs, and decide what a gap means.
 *
 * A gap is fatal only when the binary has no alternative — see
 * `NATIVE_BINARY_REQUIREMENT`. A missing *rung* (Landlock on Linux, where bwrap
 * is the preferred mechanism) is reported instead, because refusing would make
 * the package unbuildable on every host without a musl toolchain while the
 * shipped application still confines through bwrap. What is never acceptable is
 * a gap this build has not classified.
 *
 * @param farmDir - the farm root.
 * @param parts - a `TARGETS` entry.
 * @param libc - the target's libc on Linux, used to skip the other libc's binaries.
 * @returns the gaps, split by severity.
 */
function checkNativeBinaries(farmDir, parts, libc) {
  const gaps = verifyNativeBinaries(farmDir, parts.platform, parts.arch, libc)
  const fatal = gaps.filter((gap) => gap.need === 'required')
  if (fatal.length > 0) {
    const detail = fatal.map((gap) => `      - ${gap.path}: ${gap.why}`).join('\n')
    throw new Error(
      `qialike-desktop: the ${parts.platform}-${parts.arch} native prebuild is missing a binary that `
      + `has no alternative:\n${detail}\n`
      + `  · Produce it:  cd ${harnessRoot()} && pnpm run build:native-system\n`
      + '  · A package built without it starts normally and then fails where the binary was needed, '
      + 'so this is refused rather than warned about.',
    )
  }
  return { gaps, degraded: gaps.filter((gap) => gap.need === 'rung') }
}

/**
 * Run the build.
 * @param options - parsed command line.
 */
async function main(options) {
  const log = (message) => { process.stdout.write(`${message}\n`) }

  if (options.target !== undefined && !(options.target in TARGETS)) {
    throw new Error(
      `qialike-desktop: unknown --target ${JSON.stringify(options.target)} `
      + `(known: ${Object.keys(TARGETS).join(', ')})`,
    )
  }
  const target = options.target ?? hostTarget()
  if (target === undefined || !(target in TARGETS)) {
    throw new Error(
      `qialike-desktop: this host (${process.platform}-${process.arch}) is not a release target. `
      + `Pass --target with one of: ${Object.keys(TARGETS).join(', ')}. `
      + 'Native prebuilds cannot be cross-produced, so a target must be built on its own platform '
      + '(DESIGN §3 D13).',
    )
  }
  const parts = targetParts(target)
  // Only the host's own libc addon is ever loaded, so the other one's absence is
  // not a gap. `process.report` describes the *build* host, which is the target
  // host by construction (a target is built on its own platform, D13).
  const libc = parts.platform !== 'linux' ? undefined
    : (process.report?.getReport().header.glibcVersionRuntime === undefined ? 'musl' : 'glibc')

  // ── gate: the harness release must be one this build was validated against ──
  const harness = harnessRoot()
  const version = assertHarnessCompatible(harness)
  log(`harness: ${version} (validated ${HARNESS_VERSION_MIN}..${HARNESS_VERSION_MAX}) at ${harness}`)

  // ── gate: both checkouts must be built, and neither may be written to ──
  requireBuilt('harness', harness)
  requireBuilt('qialike', qialikeRoot())
  // The CLI is gated on its VERSION, which `requireBuilt` cannot do: that probe only asks whether
  // lib/index.js exists. Its built output is copied verbatim into the runtime tree, so a checkout
  // left at the previous release builds cleanly and ships the wrong provider layer — a difference
  // no version number in the artifact reveals. See CLI_VERSION.
  const cli = qialikeRoot()
  const cliVersion = assertCliCompatible(cli)
  log(`qialike:    ${cliVersion} (validated ${CLI_VERSION}) at ${cli}`)
  assertNotUpstream(FARM_DIR)

  // ── inspect the plugin surface before paying for a copy ──
  const scanned = scanPackages(harness)
  log(`scan: ${scanned.size} harness packages across vendor/, packages/, native/system/packages/`)

  // ── copy, patch, and narrow the farm ──
  const farm = copyFarm({ harnessRoot: harness, farmDir: FARM_DIR, log })
  // This product's own version, read from the root manifest rather than from the harness: the whole point of
  // the `app-version` patch is that the two differ, and the updater in the same window compares against this
  // one.
  const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const patched = await applyHarnessPatches({ farmDir: FARM_DIR, version: appVersion, log })
  const pruned = selectNativePrebuilds({ farmDir: FARM_DIR, platform: parts.platform, arch: parts.arch, log })

  // ── verify the target's native prebuilds ──
  // A binary with no alternative stops the build; a missing fallback rung is
  // reported and recorded, because it narrows which machines get kernel
  // confinement rather than removing it. A platform the addon is not built for
  // (win32 — see PLATFORMS_WITHOUT_THE_NATIVE_ADDON) has nothing to verify, and
  // says so rather than reporting a prebuild complete that does not exist.
  const hasNativePrebuild = readPrebuilds(FARM_DIR, parts.platform, parts.arch) !== undefined
  const { gaps: nativeGaps, degraded } = checkNativeBinaries(FARM_DIR, parts, libc)
  for (const gap of degraded) {
    log(`native: ${gap.path} absent — ${gap.why}`)
  }
  if (nativeGaps.length === 0) {
    log(hasNativePrebuild
      ? `native: ${parts.platform}-${parts.arch} prebuild complete`
      : `native: ${parts.platform}-${parts.arch} uses no native prebuild from this tree `
        + '(durable writes go through koffi, not the POSIX addon)')
  }

  // ── record what this run produced ──
  const external = externalDependencies(FARM_DIR)
  const descriptor = {
    schema: 1,
    target,
    platform: parts.platform,
    arch: parts.arch,
    harness: { root: harness, version, packages: farm.packages.length },
    qialike: { root: qialikeRoot() },
    profile: { name: PROFILE_NAME, bundles: PROFILE_BUNDLES },
    farm: {
      dir: FARM_DIR,
      bytes: farm.bytes,
      strippedSourceSubpaths: farm.strippedSubpaths,
      prunedNativePackages: pruned,
      externalDependencies: external,
    },
    patches: Object.fromEntries(Object.entries(patched).map(([name, files]) => [name, files])),
    native: {
      libc,
      gaps: nativeGaps,
      // Recorded so the shell and the release notes can state which machines get
      // kernel confinement rather than implying every machine does.
      degradedRungs: degraded.map((gap) => ({ path: gap.path, why: gap.why })),
    },
  }
  const descriptorPath = join(ROOT, 'dist', `build-${target}.json`)
  mkdirSync(join(ROOT, 'dist'), { recursive: true })
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`)

  log('')
  log(`target:     ${target} (${parts.platform}-${parts.arch})`)
  log(`packages:   ${farm.packages.length} copied, ${mb(farm.bytes)}`)
  log(`external:   ${external.length} third-party specifiers in the whole farm`)
  log(`patches:    ${Object.keys(patched).join(', ')}`)
  log(`descriptor: ${descriptorPath}`)

  if (options.generateOnly) {
    log('\n--generate-only: farm generated; no runtime tree was assembled.')
    return
  }

  // ── assemble the runtime tree the Host resolves from ──
  const runtimeDir = join(DIST_DIR, 'runtime', 'dsh')
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })

  // Only the closure, not the whole farm: a package nothing reaches contributes
  // bytes to the installer and a dependency surface nothing validates.
  // The bundle's `qialike-llm` row resolves the CLI's built provider catalogue,
  // so that package joins the workspace as a member. It carries no dependency
  // edge from our manifest; see `stageQialikeAppPackage`.
  // Compiled before `ownPackages()` reads the tree, because the policy package is
  // only placed once these files exist: `OWN_PACKAGES` declares them as required so
  // a fresh checkout cannot place a package whose entry point imports files that
  // were never generated. DESIGN §5.1 prescribes compiling these two modules from
  // the checkout's sources — see the compile step for why importing them is not an
  // option.
  compileCliPolicy({
    qialike: qialikeRoot(),
    outDir: join(ROOT, 'packages', 'qialike-desktop-policy', 'lib'),
    log,
  })

  // The colour schemes, generated the same way and for the same reason: the CLI's
  // set is the single source, one module needs transpiling and the other needs an
  // AST walk. See `cli-themes.mjs` for why importing either is not an option.
  await compileCliThemes({
    qialike: qialikeRoot(),
    outDir: join(ROOT, 'packages', 'qialike-desktop-theme', 'lib'),
    log,
  })

  const own = ownPackages()
  const qialikeApp = stageQialikeAppPackage({
    qialike: qialikeRoot(),
    stageDir: QIALIKE_APP_STAGE_DIR,
    log,
  })
  if (qialikeApp !== undefined) own.push(qialikeApp)
  const closure = computeBundleClosure({
    farmDir: FARM_DIR,
    bundles: PROFILE_BUNDLES,
    provided: [OUR_BUNDLE, ...own.map((entry) => entry.name)],
    extra: ROWLESS_PACKAGES,
  })
  // The declared graph is necessary but not sufficient: a package whose built
  // output imports an undeclared module is resolvable in the harness monorepo
  // and nowhere else. Closing the set over actual imports is what makes the
  // runtime tree self-contained.
  const expanded = expandClosureFromImports({
    farmDir: FARM_DIR,
    members: [...closure.farmPackages, ...ROWLESS_PACKAGES],
    log,
  })
  log(`closure: ${expanded.members.size} harness packages, `
    + `${new Set([...closure.thirdParty.keys(), ...expanded.thirdParty]).size} third-party`)
  // A locally-provided package that neither the farm nor this build carries is a
  // row the profile cannot resolve at boot. Reported before anything is copied.
  if (closure.missing.length > 0) {
    log(`closure: ${closure.missing.length} unresolvable local package(s): ${[...new Set(closure.missing)].join(', ')}`)
  }

  // M1 loads the harness's own browser surface, so the first milestone tests the
  // composition rather than our markup. M2 swaps this for our dist. Either way the
  // copy is staged before use: the source dist sits inside the read-only checkout,
  // and its chunks spell the upstream application origin, which this shell's own
  // scheme has to replace (DESIGN §12.2 R10).
  const webFrontendSource = options.webFrontend ?? join(harness, 'apps', 'web', 'dist')
  log(`runtime: web frontend from ${relative(ROOT, webFrontendSource) || webFrontendSource}`)
  const webFrontendDist = stageWebFrontendSchemed({
    sourceDist: webFrontendSource,
    targetDir: WEB_DIST_DIR,
    log,
  })
  // Branding is ours regardless of whose dist this is, so it is applied after the
  // scheme rewrite and to the same staged copy rather than to a second one.
  const brand = applyWebShadow({
    distDir: webFrontendDist,
    sourceDir: WEB_PUBLIC_DIR,
    templateFile: WEB_TEMPLATE_FILE,
    shellPathsFile: SHELL_PATHS_FILE,
    log,
  })

  const workspace = installWorkspace({
    runtimeDir,
    farmDir: FARM_DIR,
    // Rowless packages are members too: a user overlay names them by row, and a
    // package absent from the workspace is one the Loader cannot resolve.
    members: [...expanded.members],
    own,
    generated: [webFrontendMember({ sourceDist: webFrontendDist, version })],
    storeDir: options.storeDir ?? process.env.QIALIKE_PNPM_STORE ?? DEFAULT_PNPM_STORE,
    // The provider rows resolve the CLI's built catalogue, so the runtime graph
    // needs the edge from our package to it. See `installWorkspace`.
    extraDependencies: {
      [PROVIDERS_PACKAGE]: { [QIALIKE_APP_PACKAGE]: 'workspace:*' },
    },
    log,
  })

  // After the tree is assembled and de-linked, and before the descriptor is written: the
  // descriptor is where the engine's runtime requirements are recorded, and they are read out
  // of the engine binary rather than written down for it.
  //
  // The Office policy runs first, because it decides whether there is an engine for that line to
  // read at all. Pruning after it would describe an engine this build no longer ships.
  const officeEngine = officeEngineMode()
  const officePruned = officeEngine === 'plugin'
    ? pruneOfficeEngine({ runtimeDir, log })
    : { removed: [], bytes: 0 }
  const engineRuntime = describeEngineRuntime(runtimeDir, log, { platform: parts.platform, officeEngine })

  // THE NOTICE IS WRITTEN HERE, and both halves of that matter. After `installWorkspace`, because
  // the prune inside it walks the whole tree — a notice written earlier would be walked too, and a
  // `.md` is not in its suffix list but relying on that would be a rule kept by accident. After the
  // Office prune, so the notice describes the tree this build actually ships. And BEFORE the
  // descriptor, because the descriptor inventories the tree and this file is part of the artifact.
  //
  // It exists because a package compiled into a bundle leaves no package behind to carry its
  // licence: KaTeX's twenty fonts ship beside Inter's and JetBrains Mono's, whose `.txt` files are
  // there, and KaTeX's notice was not — measured on the 0.4.9 artifact, 26 font files, 3 licences.
  writeThirdPartyNotices({
    runtimeDir,
    repositoryNotice: readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    // The PRODUCT version, not the harness's: the notice describes this artifact.
    version: appVersion,
    log,
  })

  const written = writeRuntimeDescriptor({
    runtimeDir,
    withDigests: !options.skipDigests,
    descriptor: {
      ...descriptor,
      runtime: {
        dir: runtimeDir,
        members: workspace.members.size,
        harnessPackages: expanded.members.size,
        // Reached only through a built import, never through a manifest. Listed
        // so a harness release that quietly grows one more is visible here.
        undeclaredPackages: expanded.added,
        ownPackages: own.map((entry) => entry.name),
        specsLinked: workspace.rewritten.length,
        excludedDepsDropped: workspace.dropped.length,
      },
      // Which policy this tree was built under, and what it cost. Recorded because the two
      // modes differ by 145-182 MiB and by whether the Office preview can work at all, and
      // because nothing else in the descriptor says which one this is: `engineRuntime` below
      // describes the engine a *Windows* tree carries, so it reads `present: false` on Linux
      // whether or not a Linux engine was shipped.
      office: {
        engine: {
          mode: officeEngine,
          packages: officePruned.removed.map((entry) => entry.name),
          bytes: officePruned.bytes,
        },
      },
      // The Microsoft runtime the Office engine loads, read out of the engine binary and
      // recorded so the shell can name what is absent on a machine that lacks it. The files
      // are not shipped: an application-local copy never receives Microsoft's updates, so
      // the machine's own redistributable stays authoritative.
      engineRuntime,
      // `source` names where the dist was read from; the shipped bytes are the
      // staged and scheme-rewritten copy, which is what the digests cover.
      webFrontend: { source: webFrontendSource, staged: relative(ROOT, webFrontendDist) || webFrontendDist },
    },
  })
  log(`runtime: ${written.files} files, ${mb(written.bytes)}`)
  log(`runtime: ${written.path}`)
}

const { values } = parseArgs({
  options: {
    'generate-only': { type: 'boolean', default: false },
    'skip-digests': { type: 'boolean', default: false },
    target: { type: 'string' },
    'store-dir': { type: 'string' },
    'web-frontend': { type: 'string' },
    clean: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write([
    'qialike-desktop build',
    '',
    'Usage: node apps/desktop-bin/build.mjs [options]',
    '',
    'Options:',
    '  --generate-only   compose and verify the farm, then stop (no runtime tree)',
    '  --target <name>   release target to build for; defaults to the host',
    '  --store-dir <p>   pnpm content-addressable store for third-party installs',
    '  --web-frontend <p> built Web dist to serve; defaults to the harness own',
    '  --skip-digests    omit sha256 from the runtime inventory (faster iteration)',
    '  --clean           remove the farm and dist/ before starting',
    '  --help            show this help',
    '',
    `Targets: ${Object.keys(TARGETS).join(', ')}`,
    '',
    'Environment:',
    `  ${DSH_HARNESS_ENV}   harness checkout; default: the sibling ../deepseek-harness`,
    '                (the same variable is read by the qialike CLI build)',
    `  ${DSH_QIALIKE_ENV}   qialike checkout;  default: the sibling ../qialike`,
    '  QIALIKE_PNPM_STORE  pnpm store for the runtime install',
    '',
  ].join('\n'))
  process.exit(0)
}

if (values.clean) {
  rmSync(FARM_DIR, { recursive: true, force: true })
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
}

try {
  await main({
    generateOnly: values['generate-only'],
    skipDigests: values['skip-digests'],
    target: values.target,
    storeDir: values['store-dir'],
    webFrontend: values['web-frontend'],
  })
} catch (error) {
  process.stderr.write(`\n${error.message}\n\n`)
  process.exit(1)
}
