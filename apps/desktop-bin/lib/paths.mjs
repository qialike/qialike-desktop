/**
 * Where every input and output of the build lives.
 *
 * Both upstream checkouts are **read-only** inputs (DESIGN §3 D12): nothing in
 * this repository may write inside `harnessRoot` or `qialikeRoot`. The farm and
 * every other derived tree live under this repository.
 *
 * @module qialike-desktop/paths
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to this repository's root (the directory holding `apps/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The package name this repository's own root manifest declares.
 *
 * Used to recognise a wrong candidate: the resolution below searches sibling
 * and well-known directories, and without an identity check a candidate could
 * resolve to *this* repository — which is exactly what would happen if this
 * repository were ever placed beside a directory literally named `qialike`.
 */
export const OWN_ROOT_PACKAGE_NAME = '@qialike/desktop-root'

/** The identity of the deepseek-harness checkout. */
export const HARNESS_ROOT_PACKAGE_NAME = '@deepseek-ai/dsh-root'

/** The identity of the qialike CLI checkout. */
export const QIALIKE_ROOT_PACKAGE_NAME = '@qialike/qialike-root'

/**
 * The environment variable naming the deepseek-harness checkout.
 *
 * EXPORTED BECAUSE THE STRING APPEARS IN PLACES THAT DO NOT READ IT. The resolver below is
 * the only code that *uses* this name, but the same literal is also repeated in two error
 * messages and in `build.mjs --help`, none of which would fail if it were renamed. A rename
 * that updated only the resolver would leave the build printing a variable that no longer
 * does anything — and no test would notice, because the message assertions check for the
 * old spelling too. Exporting it is what makes a rename impossible to do halfway.
 *
 * NAMED AFTER THE VARIABLE, WITH THE `_ENV` SUFFIX, which is the harness's own convention
 * for exactly this shape: `DSH_HOME_ENV = 'DSH_HOME'` in
 * `packages/util/home-paths/src/index.ts` — also a `DSH_*` variable holding a directory.
 * The alternative, a name describing the purpose (`HARNESS_ENV`), reads ambiguously in this
 * repository, which already has two other things called an environment: `hostEnvironment()`
 * builds the env a Host child is spawned with, and `loadLayeredEnv('dsh')` loads the
 * harness's own layered env.
 *
 * NOT OUR NAME TO REWRITE. The qialike CLI's build reads the same variable
 * (`apps/tui-bin/build.mjs`: `process.env.DSH_HARNESS ?? resolve(ROOT, '../deepseek-harness')`)
 * and its CI sets it, so one setting points both products at one harness.
 */
export const DSH_HARNESS_ENV = 'DSH_HARNESS'

/** The environment variable naming the qialike CLI checkout. See {@link DSH_HARNESS_ENV}. */
export const DSH_QIALIKE_ENV = 'DSH_QIALIKE'

/** Read a checkout's root `package.json`, or undefined when it is not one. */
function readRootManifest(dir) {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve one upstream checkout.
 *
 * WHY THIS IS NOT JUST `../name`. This repository is developed beside both
 * checkouts, so a sibling default is convenient — but it is only correct while
 * that layout holds. Moving this repository anywhere else makes the sibling
 * missing, and in one specific case makes it *wrong*: a sibling named `qialike`
 * would resolve to whatever directory holds this repository, and the build would
 * then read its own tree expecting the CLI's. So candidates are validated by the
 * root manifest's `name`, which rejects both a missing checkout and a
 * coincidentally-named directory.
 *
 * Candidates are tried in a fixed order: an explicit environment variable, then
 * the sibling layout, then the development layout this project is maintained in.
 * The environment variable is the real contract; the rest are conveniences so a
 * clone in the expected place builds with no configuration.
 *
 * @param options.label - human name for the checkout, used in the failure message.
 * @param options.envVar - the environment variable that overrides everything.
 * @param options.expectedName - the `name` the root manifest must declare.
 * @param options.siblingDir - the directory name to look for beside this repository.
 * @param options.layoutDir - a path under the home directory, for the maintained layout.
 * @param options.env - the environment; injected so tests need no global state.
 * @param options.repoRoot - this repository's root; injected for tests.
 * @param options.home - the home directory; injected for tests.
 * @returns the absolute path to the checkout.
 * @throws Error listing every candidate tried, when none is a checkout.
 */
export function resolveCheckout(options) {
  const env = options.env ?? process.env
  const repoRoot = options.repoRoot ?? ROOT
  const home = options.home ?? homedir()
  const tried = []

  const consider = (candidate, origin) => {
    const path = resolve(candidate)
    if (tried.some((entry) => entry.path === path)) return undefined
    const manifest = readRootManifest(path)
    if (manifest?.name === OWN_ROOT_PACKAGE_NAME) {
      // Named identically to a checkout but is this repository: a configured
      // path that would make the build read its own tree.
      tried.push({ path, origin, problem: 'this is the qialike-desktop repository itself' })
      return undefined
    }
    if (manifest?.name !== options.expectedName) {
      tried.push({
        path,
        origin,
        problem: manifest === undefined
          ? 'no package.json'
          : `package.json declares ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(options.expectedName)}`,
      })
      return undefined
    }
    tried.push({ path, origin })
    return path
  }

  const override = (env[options.envVar] ?? '').trim()
  if (override.length > 0) {
    const found = consider(override, `${options.envVar}`)
    if (found !== undefined) return found
  } else {
    tried.push({ path: `${options.envVar} (unset)`, origin: 'environment', problem: 'not set', skipped: true })
  }

  const sibling = consider(join(repoRoot, '..', options.siblingDir), 'sibling of this repository')
  if (sibling !== undefined) return sibling

  const layout = options.layoutDir === undefined
    ? undefined
    : consider(join(home, options.layoutDir), 'maintained development layout')
  if (layout !== undefined) return layout

  const detail = tried.map((entry) => {
    const origin = entry.skipped === true ? '' : ` (from ${entry.origin})`
    return `    ${entry.path}${origin}${entry.problem === undefined ? '' : ` — ${entry.problem}`}`
  }).join('\n')
  throw new Error(
    `qialike-desktop: cannot find the ${options.label} checkout.\n`
    + `  Candidates tried:\n${detail}\n`
    + `  Point ${options.envVar} at a ${options.label} checkout, or place one beside this repository.`,
  )
}

/**
 * The deepseek-harness checkout the runtime is composed from.
 *
 * THE DEFAULT IS THE SIBLING DIRECTORY, and that is the whole of the rule:
 *
 *   · nothing set          → `<parent of this repository>/deepseek-harness`
 *   · `DSH_HARNESS` set    → that path (an empty value means "unset", matching how the
 *                            qialike CLI reads the same variable)
 *
 * So a checkout at `~/qialike/qialike-desktop` composes from `~/qialike/deepseek-harness`
 * with no configuration at all. There is no third location — see below.
 *
 * WHY THERE IS NO `~/deepseek` FALLBACK. This used to fall back to
 * `~/deepseek/deepseek-harness`, the layout this project was originally maintained in.
 * That made two locations meaningful at once, and a fallback is worse than a failure here:
 * both paths can hold a valid checkout that passes the identity check, and the sibling
 * simply wins — so nothing ever *reports* the duplicate. The fallback would only fire once
 * the intended checkout disappeared, and the build would then succeed from a tree nobody is
 * looking at, composing a runtime from a possibly different harness version or patch set.
 * Without it, that situation is a build failure naming the path it wanted.
 *
 * WHO THIS DOES NOT COVER: the qialike CLI, whose own build resolves its harness as
 * `process.env.DSH_HARNESS ?? <its root>/../deepseek-harness` with no search chain at all
 * (`apps/tui-bin/build.mjs`). A layout where the CLI does not sit beside a harness therefore
 * still needs `DSH_HARNESS` for the CLI's build — one variable, two products, which is why
 * the name is worth keeping rather than replacing. {@link qialikeRoot} below keeps its
 * `~/deepseek` fallback for the mirror-image reason: `../qialike` from this repository is not
 * a checkout (see the module note), so restricting it would make the build fail for every
 * layout except the one this machine happens to have.
 */
export function harnessRoot(env = process.env, options = {}) {
  return resolveCheckout({
    label: 'deepseek-harness',
    envVar: DSH_HARNESS_ENV,
    expectedName: HARNESS_ROOT_PACKAGE_NAME,
    siblingDir: 'deepseek-harness',
    env,
    ...options,
  })
}

/**
 * The qialike checkout supplying the shared runtime modules and two of the
 * three build-time patches.
 *
 * Same two-step shape as {@link harnessRoot} — `DSH_QIALIKE`, else the sibling — with the
 * `~/deepseek/qialike` fallback kept, which is the one deliberate asymmetry between them.
 * The reason is in `harnessRoot`'s note: `../qialike` from this repository is not a
 * checkout, so a layout that differs from this machine's needs some fallback or an
 * explicit variable. An empty value means "unset", as in `harnessRoot`.
 */
export function qialikeRoot(env = process.env, options = {}) {
  return resolveCheckout({
    label: 'qialike',
    envVar: DSH_QIALIKE_ENV,
    expectedName: QIALIKE_ROOT_PACKAGE_NAME,
    siblingDir: 'qialike',
    layoutDir: join('deepseek', 'qialike'),
    env,
    ...options,
  })
}

/**
 * The derived package farm: one directory per harness package, whole-tree
 * copies with the build-time patches applied.
 *
 * It is rebuilt from scratch on every run, so it is safe to delete. It never
 * lives inside an upstream checkout.
 */
export const FARM_DIR = join(ROOT, '.farm', 'packages')

/** Everything the build emits before packaging. */
export const DIST_DIR = join(ROOT, 'dist')

/** A scratch tree for operations that would otherwise write to an upstream checkout. */
export const SCRATCH_DIR = join(ROOT, '.build-scratch')

/**
 * The built Web dist the runtime tree is assembled from, after its application
 * origin has been rewritten to this shell's scheme (DESIGN §12.2 R10).
 *
 * The source dist lives inside the harness checkout, which this build never
 * writes to, so the patched copy is what ships. Rebuilt from scratch each run.
 */
export const WEB_DIST_DIR = join(SCRATCH_DIR, 'web-dist')

/**
 * The staged copy of the CLI's built `@qialike/qialike-app` package.
 *
 * The `qialike-llm` row resolves its provider catalogue from that package, so it
 * has to be a runtime-tree member (see `own-packages.mjs`). It is staged rather
 * than copied whole because the checkout's package directory carries 40 MB of
 * sources the runtime never loads. Rebuilt from scratch each run.
 */
export const QIALIKE_APP_STAGE_DIR = join(SCRATCH_DIR, 'qialike-app')

/**
 * The pnpm content-addressable store the runtime tree installs from.
 *
 * The same choice `pnpm-workspace.yaml` makes for this workspace, and for the
 * same reason: the runtime tree is assembled inside `dist/`, so it does not
 * inherit the root's setting, and pnpm's global default is unusable wherever
 * writes outside the project are not permitted. Overridable with `--store-dir`
 * or `QIALIKE_PNPM_STORE`.
 */
export const DEFAULT_PNPM_STORE = join(ROOT, '.pnpm-store')

/** This repository's browser-surface assets, shadowed over the harness Web dist. */
export const WEB_PUBLIC_DIR = join(ROOT, 'apps', 'desktop-web', 'public')

/**
 * This application's own document template.
 *
 * A sister of `WEB_PUBLIC_DIR` rather than a file inside it, and the distinction is
 * deliberate: everything under `public/` is copied verbatim into the dist, and this file is
 * *rendered* — its markers are substituted and the result is written over the dist's
 * `index.html`. Inside `public/` it would also be copied unrendered, leaving a document in
 * the dist with literal markers and no client to start.
 */
export const WEB_TEMPLATE_FILE = join(ROOT, 'apps', 'desktop-web', 'index.html')

/** The shell's path module, read for the product name the document title uses. */
export const SHELL_PATHS_FILE = join(ROOT, 'apps', 'desktop', 'src', 'paths.ts')

/** The runtime package tree handed to electron-builder as `app.asar/dsh`. */
export const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')

/**
 * The package whose `exports["./profile-boot"]` the desktop Host spawns through.
 * Resolved from the farm so the host never depends on a global `dsh` install.
 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** The profile this application owns; never `desktop` (the official shell) or `tui` (the CLI). */
export const PROFILE_NAME = 'qialike-desktop'

/**
 * The bundle layers composed into {@link PROFILE_NAME}, in application order.
 *
 * `dsh-base` is the shared core, `dsh-web-app` is the browser surface this
 * application reuses wholesale, and the last entry is ours. The order matters:
 * a later bundle's patch rows override an earlier bundle's rows by id.
 */
export const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qialike/qialike-desktop-app',
]

/**
 * Release targets the build can produce.
 *
 * Each is built **on its own platform** (DESIGN §3 D13): the harness native
 * prebuilds cannot be cross-produced, so a target built on the wrong host would
 * silently lack them. `electron-builder` flags mirror the upstream shell's.
 */
export const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', builderPlatform: '--mac', builderArch: '--arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64', builderPlatform: '--mac', builderArch: '--x64' },
  'win-x64': { platform: 'win32', arch: 'x64', builderPlatform: '--win', builderArch: '--x64' },
  'linux-x64': { platform: 'linux', arch: 'x64', builderPlatform: '--linux', builderArch: '--x64' },
}

/** Release targets the packaging scripts expose as fixed commands. */
export const PACKAGE_TARGETS = ['mac-arm64', 'win-x64', 'linux-x64']

/** The `node:process.platform`/`arch` spelling for one target name. */
export function targetParts(target) {
  const entry = TARGETS[target]
  if (entry === undefined) {
    const known = Object.keys(TARGETS).join(', ')
    throw new Error(`qialike-desktop: unknown target ${JSON.stringify(target)} (known: ${known})`)
  }
  return entry
}

/**
 * The host's own target name, or undefined when the host is not a release target.
 *
 * `undefined` is a real answer, not an error — see {@link requireHostTarget} for the guard
 * every caller needs, and for why this one stays total.
 */
export function hostTarget() {
  const match = Object.entries(TARGETS)
    .find(([, entry]) => entry.platform === process.platform && entry.arch === process.arch)
  return match?.[0]
}

/**
 * The host's own target name, or a clear failure naming what this host is.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link hostTarget}. `hostTarget()` returning `undefined`
 * is the honest answer for a host that is not a release target — and it was being handled at
 * one call site and not the other. `build.mjs` checks it; `package.mjs` did
 * `hostTarget().split('-')[0]`, so `pnpm run package:linux` on any host outside the table
 * died with `TypeError: Cannot read properties of undefined (reading 'split')`. Measured on
 * an arm64-host simulation, but it applies to **any** non-x64 Linux host: this table has no
 * `linux-arm64` entry, so an arm64 machine is not a release target at all.
 *
 * A TypeError is the wrong failure for that: it names neither the host, nor the known
 * targets, nor the reason. The repository's own rule is that an unsupported host fails with
 * a sentence (see `build.mjs`, which has said so all along) — this makes that sentence
 * available to every caller instead of one.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: that passing `--target` will help. It will not, for
 * this case — the native prebuilds cannot be cross-produced, so a target must be built on
 * its own platform. `build.mjs` adds that hint itself because it accepts `--target`; a
 * caller that does not take the flag should not advertise it.
 *
 * @returns the host's target name.
 * @throws Error naming the host, the known targets, and the reason.
 */
export function requireHostTarget() {
  const target = hostTarget()
  if (target === undefined) {
    throw new Error(
      `qialike-desktop: this host (${process.platform}-${process.arch}) is not a release target. `
      + `Known targets: ${Object.keys(TARGETS).join(', ')}. `
      + 'Native prebuilds cannot be cross-produced, so a target must be built on its own platform '
      + '(DESIGN §3 D13).',
    )
  }
  return target
}

/**
 * Assert a path is inside an upstream checkout, which the build must never write.
 *
 * The farm and the patch appliers operate on copies precisely so this can hold.
 * Callers guard every write with it (DESIGN §3 D12).
 *
 * @param path - absolute path about to be written.
 * @throws Error naming the checkout when the path is inside one.
 */
export function assertNotUpstream(path) {
  const targets = [
    ['deepseek-harness checkout', harnessRoot()],
    ['qialike checkout', qialikeRoot()],
  ]
  for (const [label, root] of targets) {
    if (path === root || path.startsWith(root + '/')) {
      throw new Error(
        `qialike-desktop: refusing to write inside the ${label} at ${root} `
        + `(path: ${path}). Both upstream checkouts are read-only inputs; `
        + 'copy into the farm under this repository and patch the copy instead.',
      )
    }
  }
}

/**
 * Report whether a checkout looks built, for an actionable failure.
 *
 * Both upstream trees are consumed as **built** artifacts: the harness supplies
 * compiled `lib/` JavaScript and the qialike app supplies the same. A checkout
 * that has never run its own build fails deep inside the farm with a confusing
 * missing-file error, so the build checks up front (DESIGN §12.2 R9).
 *
 * @param root - the checkout root.
 * @param probe - a repo-relative path that must exist once the checkout is built.
 * @returns undefined when built, else a human-readable reason.
 */
export function missingBuild(root, probe) {
  if (!existsSync(root)) return `the checkout does not exist at ${root}`
  const target = join(root, probe)
  if (!existsSync(target)) {
    return `the checkout at ${root} is not built (missing ${probe}); run its own build first`
  }
  return undefined
}
