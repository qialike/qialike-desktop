/**
 * How to run `pnpm` on this host, as a command plus an argv.
 *
 * WHY NOT `spawnSync('pnpm', …)`. That is the obvious spelling and it is wrong on
 * Windows, where pnpm is a `.cmd` shim and BOTH natural spellings fail — measured
 * on Windows 10.0.26300 / Node 24.19.0:
 *
 *   · `spawnSync('pnpm', …)`  -> `ENOENT`. Node's spawn does not apply `PATHEXT`,
 *     so a bare name that resolves to `pnpm.cmd` is not found at all.
 *   · `spawnSync('pnpm.cmd', …)` -> `EINVAL`. Since the CVE-2024-27980 fix, Node
 *     refuses to spawn a `.cmd`/`.bat` without a shell rather than risk argument
 *     injection through `cmd.exe`.
 *
 * THE INVOKING PNPM IS PREFERRED, AND THAT IS THE POINT RATHER THAN A CONVENIENCE.
 * `npm_execpath` is set by the package manager running this build, so when the
 * build is started by the workspace's pinned pnpm this resolves to *that exact
 * pnpm* and the runtime tree is resolved by the same version that resolved the
 * workspace. Falling back to whatever `pnpm` is on PATH would silently substitute
 * the global one — on the machine this was fixed on, PATH held pnpm 12.2.0 while
 * `package.json` pins 11.28.5 — and a different pnpm resolves and locks the tree
 * its own way, so the substitution would not announce itself.
 *
 * It is also the portable branch: `node <pnpm.mjs> …` needs no shell and no
 * `PATHEXT`, so it behaves identically on Linux and Windows.
 *
 * The fallback is only reached when the build is run outside a package manager
 * (`node apps/desktop-bin/build.mjs` directly). Windows then gets `cmd.exe /d /s
 * /c` — the shell Node insists on — with the program and its arguments kept as
 * separate argv entries so no command line is assembled by concatenation.
 *
 * @param args - the pnpm arguments.
 * @returns the command, its argv, and a label naming which one was chosen.
 */
export function pnpmInvocation(args) {
  const execpath = (process.env.npm_execpath ?? '').trim()
  const agent = process.env.npm_config_user_agent ?? ''
  // `agent` is checked as well as the path: `npm_execpath` is equally set when npm
  // or Yarn runs the build, and `node <npm-cli.js> install` is a different program
  // with different flags, not a synonym for pnpm.
  if (execpath.length > 0 && agent.startsWith('pnpm/') && /pnpm/i.test(execpath)) {
    return { command: process.execPath, args: [execpath, ...args], via: `the invoking pnpm (${agent.split(' ')[0]})` }
  }
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm', ...args], via: 'cmd.exe' }
  }
  return { command: 'pnpm', args, via: 'pnpm on PATH' }
}

/**
 * Assemble the runtime package tree the application ships as `app.asar/dsh`.
 *
 * The tree is what the Host resolves everything from, so its contents are the
 * application's real dependency surface. Three populations fill it:
 *
 *   · **Farm packages** — the harness's own `@deepseek-ai/*`, copied from the
 *     farm with the build-time patches already applied.
 *   · **This repository's packages** — our bundle and the Host.
 *   · **Third-party packages** — everything else, resolved by pnpm.
 *
 * WHY A PNPM WORKSPACE RATHER THAN A FLAT DEPENDENCY LIST. The obvious approach
 * is one `package.json` naming every third-party package, installed with a
 * hoisted linker. It is wrong, and running it is what showed why: a single
 * manifest holds one spec per name, but the profile's closure genuinely needs
 * two. `chokidar` is required at `^4.0.3` by `@deepseek-ai/dsh-hmr` and at
 * `^5.0.0` by another reachable package. The harness checkout resolves this the
 * way any package manager does — it holds `chokidar@4.0.3` hoisted and
 * `chokidar@5.0.0` nested under its consumer. A flat manifest has to pick one
 * and would hand the other consumer a version outside its range, which is a
 * failure that shows up as a runtime `TypeError` in a rarely-walked path.
 *
 * So the farm packages are declared as workspace members with their real
 * dependency specs, and pnpm resolves the tree the same way it does for the
 * harness. The build does not reimplement dependency resolution, and a conflict
 * is solved by nesting rather than by the build choosing a victim.
 *
 * AND THEN THE WORKSPACE LAYOUT IS UNDONE. pnpm's output is a *development* layout —
 * real directories in `packages/`, reached through symlinks — which is right for a
 * checkout and wrong for something that is copied into an installer. {@link
 * delinkWorkspace} runs last and turns it into the *resolved* layout: one real
 * directory per package at the path a Node resolver looks in. Read that function's
 * note for what the link layer cost and why hoisting it is measurably safe here.
 * The resolution above is unaffected — a conflict is still solved by nesting; nesting
 * is simply no longer expressed as links.
 *
 * @module qialike-desktop/runtime-tree
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { flattenPackageName } from './harness-farm.mjs'
import { assertNotUpstream, PROFILE_BUNDLES, TARGETS } from './paths.mjs'

/** Scopes that name a package this build supplies rather than fetches. */
const LOCAL_SCOPES = ['@deepseek-ai/', '@qialike/']

/**
 * Packages the profile may load by name without any bundle manifest naming them.
 *
 * The cordis Loader resolves a row's `name` at boot, and a user overlay may add
 * a row naming a package no bundle depends on. Each is installed but never
 * imported until a row names it.
 */
export const ROWLESS_PACKAGES = [
  // The profile runner itself. No bundle depends on it — it is the application
  // that composes them — but two things need it present: `runProfile` is
  // imported from its `./profile-boot` subpath, and it is the **install anchor**
  // whose dependency graph the runtime resolver BFS-walks to decide which
  // packages a loader-visible row may name. Without it, rows resolve to nothing.
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-mcp-client', // a user overlay mounts MCP servers by naming it
  '@deepseek-ai/dsh-plugin-manager', // the Plugins page installs external plugins
  '@deepseek-ai/dsh-config-editor', // `--dump-config` and the config editor
]

/**
 * Native packages whose install scripts must run.
 *
 * A hoisted install with scripts disabled leaves these without their compiled
 * addon, and the failure surfaces much later as a failed import. `node-pty`
 * backs the sidebar terminal; `koffi` backs the Windows ACL runner; `sharp` is
 * reached by an attachment path.
 */
export const NATIVE_BUILD_PACKAGES = ['node-pty', 'koffi', 'sharp', 'esbuild']

/**
 * Packages with install scripts that must **not** run, declared explicitly.
 *
 * pnpm refuses to install while any dependency's build script is undecided, so
 * a package cannot simply be left off the list: the build fails with
 * `ERR_PNPM_IGNORED_BUILDS` until someone rules on it. These are ruled out —
 * each is either pure JavaScript whose postinstall is a no-op for us, or a
 * native component this application never loads. The list mirrors the harness's
 * own `allowBuilds` denials so both trees treat them the same way.
 */
export const DENIED_BUILD_PACKAGES = [
  '@google/genai', // postinstall only reports telemetry; pure JS
  'protobufjs', // postinstall only prints a donation notice
  'node-addon-require-builtin', // native helper for a path this application does not take
  'fs-ext', // optional flock helper; the harness prefers its own addon
]

/**
 * Compute the packages reachable from a set of bundle layers.
 *
 * Walks `dependencies` and `optionalDependencies` transitively. A specifier in a
 * locally-provided scope is followed as another farm package; anything else is
 * third-party. `peerDependencies` is deliberately not followed: a peer is the
 * *consumer's* obligation, and treating it as a dependency here would pull in
 * optional integrations nothing mounted.
 *
 * @param options.farmDir - the farm root.
 * @param options.bundles - bundle package names to start from.
 * @param options.provided - package names this build supplies rather than copies.
 * @param options.extra - additional farm packages to include regardless of reachability.
 * @returns `{ farmPackages, thirdParty, missing }`; `thirdParty` is reported for
 *   the build log and the descriptor, not used to drive installation.
 */
export function computeBundleClosure({ farmDir, bundles = PROFILE_BUNDLES, provided = [], extra = [] }) {
  const providedSet = new Set(provided)
  const manifestOf = (name) => {
    const path = join(farmDir, flattenPackageName(name), 'package.json')
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  const farmPackages = new Set()
  const thirdParty = new Map()
  const missing = []
  const queue = [...bundles, ...extra]

  while (queue.length > 0) {
    const name = queue.shift()
    if (farmPackages.has(name) || providedSet.has(name)) continue
    const local = LOCAL_SCOPES.some((scope) => name.startsWith(scope))
    const manifest = manifestOf(name)
    if (manifest === undefined) {
      // A locally-scoped specifier that neither the farm nor this build carries
      // is a row the profile cannot resolve at boot.
      if (local) missing.push(name)
      continue
    }
    farmPackages.add(name)
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('node:')) continue
        if (LOCAL_SCOPES.some((scope) => dependency.startsWith(scope))) {
          queue.push(dependency)
          continue
        }
        thirdParty.set(dependency, spec)
      }
    }
  }
  return { farmPackages, thirdParty, missing }
}

/**
 * Rewrite one copied manifest so a pnpm workspace can resolve it.
 *
 * A harness manifest declares its siblings as `workspace:*` / `workspace:~`,
 * which pnpm only accepts for a package that is itself a workspace member. Every
 * locally-scoped dependency is therefore rewritten to the member form when it is
 * a member, and dropped when it is not — a dependency this build deliberately
 * did not carry (a pruned native platform package, an excluded non-MIT SDK) must
 * not become an npm fetch at build time.
 *
 * A locally-scoped dependency that is *not* a member and does *not* use the
 * workspace protocol is left alone: `@deepseek-ai/libreoffice-kit` is a real
 * published package that lives in no checkout, and dropping it would break the
 * one row that reaches it.
 *
 * @param manifest - the copied manifest, mutated in place.
 * @param members - the set of package names the workspace declares.
 * @returns what was changed, for the build log.
 */
export function rewriteWorkspaceSpecs(manifest, members) {
  const rewritten = []
  const dropped = []
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[field]
    if (deps === undefined || typeof deps !== 'object' || deps === null) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue
      const local = LOCAL_SCOPES.some((scope) => name.startsWith(scope))
      if (!local) continue
      if (members.has(name)) {
        if (spec !== 'workspace:*') { deps[name] = 'workspace:*'; rewritten.push(`${field}:${name}`) }
        continue
      }
      if (spec.startsWith('workspace:')) {
        delete deps[name]
        dropped.push(`${field}:${name}`)
      }
    }
    if (Object.keys(deps).length === 0) delete manifest[field]
  }

  // Dev dependencies are removed outright rather than rewritten. A shipped
  // runtime never loads one, and pnpm still resolves a workspace member's
  // `devDependencies` — so leaving them makes the install demand members this
  // build deliberately excluded (`@deepseek-ai/dsh-invariants` appears only as a
  // peer and dev dependency of `dsh-agent`), and would pull a toolchain
  // (typescript, vitest, tsdown) into a tree no runtime path can reach.
  if (manifest.devDependencies !== undefined) {
    delete manifest.devDependencies
    dropped.push('devDependencies')
  }

  // Install scripts are removed for the same reason: every harness member's
  // scripts are build-time (`tsc -b`, `tsdown`), none is a runtime concern, and a
  // member that kept a `prepare` script would have it executed by `pnpm install`
  // inside an artifact that is meant to be read-only once assembled.
  if (manifest.scripts !== undefined) {
    delete manifest.scripts
    dropped.push('scripts')
  }
  return { rewritten, dropped }
}

/**
 * Materialize one workspace member: a package copied from the farm, or a
 * generated package, with its specs rewritten.
 *
 * @returns the member name.
 */
function writeMember({ from, to, members, name, extraDependencies }) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  if (from !== undefined) {
    cpSync(from, to, { recursive: true, preserveTimestamps: true })
  } else {
    writeFileSync(join(to, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', private: true }, null, 2)}\n`)
  }
  const manifestPath = join(to, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Edges the source manifest cannot express. A dependency on the qialike CLI is
  // real but its path is resolved at build time (`DSH_QIALIKE`, a sibling, or
  // `~/deepseek/*`), so a committed spec would be a lie for every other layout —
  // and `workspace:*` would make this repository's own root install demand a
  // member its workspace does not have. The runtime tree is where the edge can
  // be stated truthfully, and it has to be: the profile resolver builds its
  // package table from this graph, so a package reached only through the
  // node_modules directory is invisible to it.
  const extra = extraDependencies?.[name]
  if (extra !== undefined) {
    manifest.dependencies = { ...manifest.dependencies, ...extra }
  }
  const changes = rewriteWorkspaceSpecs(manifest, members)
  // A workspace member must be private or pnpm warns about publishing it.
  manifest.private = true
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return changes
}

/**
 * Lay out the pnpm workspace and install it.
 *
 * @param options.runtimeDir - the runtime tree root.
 * @param options.farmDir - the farm root.
 * @param options.members - package names to declare as workspace members, in order.
 * @param options.own - `{ name, dir }` entries for this repository's packages.
 * @param options.generated - `{ name, write(dir) }` entries for packages this build synthesizes.
 * @param options.extraDependencies - per-member dependency edges the source manifests cannot state.
 * @param options.storeDir - pnpm content-addressable store.
 * @param options.log - progress sink.
 * @returns `{ installed, members }` where `members` is the final declared set.
 */
export function installWorkspace({
  runtimeDir, farmDir, members, own, generated, storeDir, extraDependencies, log = () => {},
}) {
  assertNotUpstream(runtimeDir)
  const memberNames = new Set([...members, ...own.map((entry) => entry.name), ...generated.map((entry) => entry.name)])

  // The root depends on every member. Without this pnpm links nothing, because
  // a workspace member is only reachable from `node_modules` when something
  // depends on it — and the whole point of this tree is that the Loader can
  // resolve a bundle or a row's `name` from `node_modules/@deepseek-ai/*`, the
  // way it does inside the harness monorepo.
  const rootDependencies = Object.fromEntries(
    [...memberNames].sort().map((name) => [name, 'workspace:*']),
  )
  writeFileSync(join(runtimeDir, 'package.json'), `${JSON.stringify({
    name: 'qialike-desktop-runtime',
    version: '0.0.0',
    private: true,
    dependencies: rootDependencies,
  }, null, 2)}\n`)
  writeFileSync(join(runtimeDir, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - 'packages/*'",
    '',
    // Nested copies are how a real conflict is resolved; see the module note.
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
    'allowBuilds:',
    ...NATIVE_BUILD_PACKAGES.map((name) => `  ${JSON.stringify(name)}: true`),
    ...DENIED_BUILD_PACKAGES.map((name) => `  ${JSON.stringify(name)}: false`),
    '',
  ].join('\n'))

  const packagesDir = join(runtimeDir, 'packages')
  mkdirSync(packagesDir, { recursive: true })
  const rewritten = []
  const dropped = []
  for (const name of memberNames) {
    const ownEntry = own.find((entry) => entry.name === name)
    const generatedEntry = generated.find((entry) => entry.name === name)
    const to = join(packagesDir, flattenPackageName(name))
    if (generatedEntry !== undefined) {
      rmSync(to, { recursive: true, force: true })
      mkdirSync(to, { recursive: true })
      generatedEntry.write(to)
      const manifest = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'))
      manifest.private = true
      writeFileSync(join(to, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      continue
    }
    const from = ownEntry !== undefined ? ownEntry.dir : join(farmDir, flattenPackageName(name))
    if (!existsSync(from)) continue
    const changes = writeMember({ from, to, members: memberNames, name, extraDependencies })
    rewritten.push(...changes.rewritten.map((entry) => `${name} ${entry}`))
    dropped.push(...changes.dropped.map((entry) => `${name} ${entry}`))
  }
  log(`runtime: workspace with ${memberNames.size} members (${rewritten.length} specs linked, ${dropped.length} excluded deps dropped)`)

  const args = ['install', '--no-frozen-lockfile']
  if (storeDir !== undefined) args.push('--store-dir', storeDir)
  const invocation = pnpmInvocation(args)
  log(`runtime: resolving the dependency tree (via ${invocation.via})`)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: runtimeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    throw new Error(
      `qialike-desktop: cannot run pnpm via ${invocation.via}: ${result.error.message}. `
      + 'pnpm is required to resolve the runtime dependency tree.',
    )
  }
  if (result.status !== 0) {
    // pnpm reports most failures on **stdout**, not stderr — a store it cannot
    // open, an unresolvable specifier, a lockfile conflict. Reading only stderr
    // produced an empty message after the colon, which is worse than a raw dump:
    // it names the failing command without saying anything about the cause. Both
    // streams are therefore kept, stderr first because when it is non-empty it is
    // the more specific of the two.
    const stderr = [(result.stderr ?? '').trim(), (result.stdout ?? '').trim()]
      .filter((part) => part.length > 0)
      .join('\n')
    // `ERR_PNPM_IGNORED_BUILDS` is the one failure whose remedy is a code change
    // in this repository rather than in the environment, so it gets its own
    // message naming both lists instead of the raw pnpm output.
    if (stderr.includes('ERR_PNPM_IGNORED_BUILDS')) {
      const named = [...stderr.matchAll(/([^\s,]+@[\d][^\s,)]*)/g)].map((match) => match[1])
      throw new Error(
        'qialike-desktop: a dependency of the runtime tree has an install script this build has not '
        + `ruled on:\n      ${named.join('\n      ') || '(see pnpm output below)'}\n`
        + '  · pnpm refuses to install while any build script is undecided, so this is a decision, '
        + 'not an error to suppress.\n'
        + '  · Add it to NATIVE_BUILD_PACKAGES in apps/desktop-bin/lib/runtime-tree.mjs if its '
        + 'compiled output is needed at runtime, or to DENIED_BUILD_PACKAGES if it is not.\n'
        + `  · pnpm said: ${stderr.split('\n')[0]}`,
      )
    }
    throw new Error(
      `qialike-desktop: pnpm install failed in ${runtimeDir} (exit ${String(result.status)}):\n`
      + `${stderr.split('\n').slice(-25).join('\n')}`,
    )
  }
  const delinked = delinkWorkspace({ runtimeDir, log })
  // Last, and deliberately after the de-link: the prune walks the tree as files, so it wants the layout
  // every later consumer will see rather than pnpm's link layer. Before the descriptor too — see the
  // note on {@link pruneNonRuntimeFiles}.
  const pruned = pruneNonRuntimeFiles({ runtimeDir, log })
  return { members: memberNames, rewritten, dropped, delinked, pruned }
}

/**
 * Replace pnpm's workspace-link layer with one real directory per package.
 *
 * WHY THIS IS NOT COSMETIC. pnpm lays a workspace out as `packages/<name>` (the real
 * directory) plus `node_modules/<name>` symlinks into it — and, because a package that
 * declares a workspace dependency needs it resolvable from its own directory, further
 * symlinks *inside* each member's `node_modules`. This build had 955 of them, and one
 * package (`schemastery`) was referenced by 135 of those links. Every consumer that
 * treats the tree as files rather than as a live file system therefore materialises that
 * one package 135 times:
 *
 *   · `electron-builder`'s NSIS target dereferences symlinks, so the installer payload
 *     grew from 573 MB to 2,317 MB and from 38,877 files to 207,549 — which is why the
 *     installer was ~700 MB rather than ~200 MB;
 *   · the recursive copies pushed paths to 295 characters, past Windows' 260-character
 *     `MAX_PATH`, so parts of the installed tree are unreachable to ordinary tools;
 *   · more than one copy of a module is a correctness hazard as well as a size one.
 *
 * WHY HOISTING TO `node_modules` IS CORRECT HERE, MEASURED RATHER THAN ASSUMED. Every
 * link was checked before this step was written: 955 links, 0 unresolvable, and across
 * 305 distinct package names **not one name resolved to two different directories**. So
 * no link is carrying a version conflict, and Node's ordinary upward `node_modules`
 * lookup from any member directory reaches the single hoisted copy. Had any name
 * resolved to two directories, those would be two versions and the nesting would have to
 * survive — see `tests/delink-workspace.test.mjs`, which asserts the conflict case is
 * refused rather than silently flattened.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not bundle the tree into one file, and it
 * cannot: the third-party closure (396 MB of the 573 MB) and the native addons the
 * sandbox and the terminal need — `system.node`, `landlock-run`, `koffi`, `node-pty` —
 * are real files that no JavaScript bundle can inline. What this removes is the
 * *indirection and the duplication*, not `node_modules` itself; a Node process resolves
 * its dependencies through `node_modules`, and the harness is loaded as built `lib/`
 * output either way.
 *
 * @param options.runtimeDir - the assembled runtime tree.
 * @param options.log - progress sink.
 * @returns counts for the build's report.
 * @throws Error when a member declares no name, or two members claim one name.
 */
export function delinkWorkspace({ runtimeDir, log = () => {} }) {
  const packagesDir = join(runtimeDir, 'packages')
  const nodeModulesDir = join(runtimeDir, 'node_modules')
  if (!existsSync(packagesDir)) return { moved: 0, removedLinks: 0, prunedDirs: 0 }

  const members = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)

  let moved = 0
  for (const dirName of members) {
    const from = join(packagesDir, dirName)
    const manifestPath = join(from, 'package.json')
    let name
    try {
      name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
    } catch {
      name = undefined
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `qialike-desktop: the runtime tree's packages/${dirName} declares no usable "name", so there is `
        + 'no node_modules path to hoist it to. Every farm and own package must declare one; a nameless '
        + 'member means the farm copied something that is not a package.',
      )
    }
    const to = join(nodeModulesDir, ...name.split('/'))
    if (existsSync(to)) {
      const existing = lstatSync(to)
      if (existing.isSymbolicLink()) {
        // pnpm's link to this very directory. Removed so the move can take its place.
        rmSync(to, { force: true })
      } else if (existing.isDirectory()) {
        // Two members claiming one name would make one of them silently win. Refused:
        // the survivors cannot be told apart afterwards, and a wrong module is a
        // failure that surfaces far from here.
        throw new Error(
          `qialike-desktop: two runtime-tree members claim the package name ${JSON.stringify(name)}: `
          + `packages/${dirName} and the existing directory ${relative(runtimeDir, to)}. `
          + 'Flattening cannot represent both, so this is refused rather than resolved by order.',
        )
      } else {
        rmSync(to, { force: true })
      }
    }
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    moved += 1
  }

  // Every remaining link pointed into packages/, whose members have all just moved, so
  // each one is now dangling. Removed in a second pass rather than during the loop so
  // the loop above only ever moves whole, intact directories.
  let removedLinks = 0
  const removeLinks = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        rmSync(path, { force: true })
        removedLinks += 1
        continue
      }
      if (entry.isDirectory()) removeLinks(path)
    }
  }
  removeLinks(runtimeDir)

  // The nested `node_modules` that held only links are empty now. Left in place they
  // would be thousands of empty directories inside the installer, and each one adds a
  // path segment to everything below it — which is the `MAX_PATH` half of the problem.
  let prunedDirs = 0
  const pruneEmpty = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      pruneEmpty(path)
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true, force: true })
        prunedDirs += 1
      }
    }
  }
  // Applied to the tree's children, never to the tree: an empty runtimeDir would mean
  // this step had gone wrong, and removing it would hide that.
  for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(runtimeDir, entry.name)
    pruneEmpty(child)
    // AND THE CHILD ITSELF, which the pass above does not reach: `packages/` is emptied by
    // the moves and this is what removes it. Without this it survived as an empty
    // directory, which is both a lie about the tree's shape and one more path segment.
    if (readdirSync(child).length === 0) {
      rmSync(child, { recursive: true, force: true })
      prunedDirs += 1
    }
  }

  log(
    `runtime: de-linked ${moved} package(s) into node_modules `
    + `(${removedLinks} link(s) removed, ${prunedDirs} empty directory(ies) pruned)`,
  )
  return { moved, removedLinks, prunedDirs }
}

/**
 * Generate the package that carries the browser surface's built assets.
 *
 * `@deepseek-ai/dsh-web-app` resolves its dist through
 * `require.resolve('@deepseek-ai/dsh-web-frontend/package.json')`, so a package
 * with that name has to exist with a `dist/` beside its manifest. The harness
 * monorepo's `apps/web` is not published under that name, so the build writes
 * the package around a chosen dist.
 *
 * For M1 the dist is the harness's own, loaded unchanged, which makes the first
 * milestone a test of the composition rather than of our markup. From M2 it is
 * this repository's — the swap is a change of `sourceDist`, which is why the
 * package is generated rather than vendored.
 *
 * @returns a `{ name, write }` entry for {@link installWorkspace}.
 */
export function webFrontendMember({ sourceDist, version = '0.0.0' }) {
  return {
    name: '@deepseek-ai/dsh-web-frontend',
    write(dir) {
      if (!existsSync(join(sourceDist, 'index.html'))) {
        throw new Error(
          `qialike-desktop: no built Web frontend at ${sourceDist} (no index.html). `
          + 'Build it first: cd <harness> && pnpm run build:web',
        )
      }
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
        name: '@deepseek-ai/dsh-web-frontend',
        version,
        description: 'Web application entry: the built browser surface served by the Web Host',
        type: 'module',
        exports: { './dist/*': './dist/*', './package.json': './package.json' },
      }, null, 2)}\n`)
      cpSync(sourceDist, join(dir, 'dist'), { recursive: true, preserveTimestamps: true })
    },
  }
}

/**
 * Suffixes that name a file no runtime can load.
 *
 * `.ts`/`.tsx`/`.mts`/`.cts` are TypeScript sources and `.d.ts`/`.d.mts`/`.d.cts` are declarations.
 * Electron's Node loads neither: a `.ts` file is not JavaScript to it, and a `.d.ts` is not executable
 * at all.
 *
 * THE SUBPATH EXPORTS THAT NAME THEM ARE ALREADY UNUSABLE, which is what makes removing the files safe
 * rather than merely tidy. This tree carries 772 such subpaths across 378 packages — `zod`'s
 * `./v4/@zod/source` → `src/index.ts`, `commander`'s `./typings/index.d.ts`, `openai`'s `./types`. They
 * exist for TypeScript tooling; a runtime that followed one would fail on the extension, with or without
 * the file. `types`/`typings` fields are not consulted by Node's resolver at all.
 *
 * Longest first, so `.d.ts` is recognised as a declaration rather than as a `.ts` source.
 */
const NON_RUNTIME_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.ts', '.tsx', '.mts', '.cts']

/**
 * Manifest fields whose value names a file a runtime actually loads.
 *
 * These are the fields a Node resolver reads, as opposed to `types`/`typings` (declarations) and
 * `exports` subpaths (which may name anything, including the source entry points above).
 */
const RUNTIME_ENTRY_FIELDS = ['main', 'module', 'browser']

/**
 * Remove sources and declarations from an assembled runtime tree.
 *
 * WHY A GUARD RATHER THAN A MEASUREMENT. A manifest whose `main`, `module`, `browser` or `bin` named one
 * of these suffixes would be a genuinely loadable entry point, and pruning it would ship a tree whose own
 * manifest points at nothing. No package in this tree does that — measured across all 640 manifests — but
 * that measurement is exactly the kind of fact a later dependency can invalidate in silence, so this
 * refuses instead: it throws and names the manifest. The failure mode it prevents is a build that
 * succeeds and an application that cannot start.
 *
 * Runs after {@link delinkWorkspace} and before the descriptor is written, because the descriptor is the
 * inventory every later check compares the tree against — pruning afterwards would leave the gate
 * reporting files as missing that this step removed on purpose.
 *
 * @param options.runtimeDir - the assembled runtime tree.
 * @param options.log - progress sink.
 * @returns `{ removed, bytes, prunedDirs, bySuffix }`.
 * @throws Error when a manifest names a pruned file as a runtime entry point.
 */
export function pruneNonRuntimeFiles({ runtimeDir, log = () => {} }) {
  const suffixOf = (name) => NON_RUNTIME_SUFFIXES.find((suffix) => name.endsWith(suffix))
  const baseOf = (path) => path.split(sep).pop() ?? path

  /** Every file, package manifests included, so the guard below sees the whole tree. */
  const allFiles = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(path); continue }
      allFiles.push(path)
    }
  }
  walk(runtimeDir)

  // Guard first, and over the whole tree: a manifest that names a file this step would delete is a
  // contradiction between the manifest and the tree, and it is cheaper to find it before deleting
  // anything than to explain a half-pruned tree.
  for (const path of allFiles) {
    if (baseOf(path) !== 'package.json') continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const entries = []
    for (const field of RUNTIME_ENTRY_FIELDS) {
      if (typeof manifest[field] === 'string') entries.push([field, manifest[field]])
    }
    const bin = manifest.bin
    if (typeof bin === 'string') entries.push(['bin', bin])
    else if (bin !== null && typeof bin === 'object') {
      for (const [name, value] of Object.entries(bin)) {
        if (typeof value === 'string') entries.push([`bin.${name}`, value])
      }
    }
    for (const [field, target] of entries) {
      // A subpath entry (`./x.ts`) is not a loadable file name on its own, only the suffix matters.
      if (suffixOf(target) === undefined) continue
      throw new Error(
        `qialike-desktop: ${relative(runtimeDir, path)} names ${JSON.stringify(target)} as its ${field}, `
        + 'which is a source or declaration file and therefore one this build removes. A runtime cannot '
        + 'load it either way, so the manifest is wrong rather than this step: point that field at the '
        + `compiled file. (Package ${JSON.stringify(manifest.name ?? '(unnamed)')}.)`,
      )
    }
  }

  let removed = 0
  let bytes = 0
  const bySuffix = new Map()
  for (const path of allFiles) {
    const suffix = suffixOf(baseOf(path))
    if (suffix === undefined) continue
    bytes += statSync(path).size
    rmSync(path, { force: true })
    removed += 1
    bySuffix.set(suffix, (bySuffix.get(suffix) ?? 0) + 1)
  }

  // Directories the removal emptied. Left behind they would still be shipped as directories by every
  // consumer that walks the tree, and `src/` and `dist/types/` would appear in a listing with nothing in
  // them. Deepest first, so a parent emptied by its children is reached in the same pass.
  let prunedDirs = 0
  const pruneEmpty = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      pruneEmpty(path)
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true, force: true })
        prunedDirs += 1
      }
    }
  }
  pruneEmpty(runtimeDir)

  const summary = [...bySuffix].sort((a, b) => b[1] - a[1])
    .map(([suffix, count]) => `${suffix} ${count}`).join(', ')
  log(`runtime: pruned ${removed} source/declaration file(s), ${(bytes / 1048576).toFixed(1)} MB `
    + `(${summary}); ${prunedDirs} emptied director${prunedDirs === 1 ? 'y' : 'ies'} removed`)
  return { removed, bytes, prunedDirs, bySuffix }
}

/** The scope and name prefix every LibreOffice engine package shares. */
export const OFFICE_ENGINE_PREFIX = '@deepseek-ai/libreoffice-kit-'

/** The environment variable that chooses what a build does with the engine. */
export const OFFICE_ENGINE_ENV = 'QIALIKE_DESKTOP_OFFICE_ENGINE'

/** The two policies a build may run under. */
export const OFFICE_ENGINE_MODES = ['bundled', 'plugin']

/**
 * What a build does with the engine when the environment says nothing, per platform.
 *
 * LINUX SHIPS WITHOUT IT. On Linux the whole path is verified end to end — the installer fetches
 * from a registry the users of this product can reach, checks the digest, unpacks safely, wires the
 * search path, and the preview then really renders — so the 145.3 MiB is not paid by everyone for a
 * feature most sessions never use. The design record measures what that costs and who pays it:
 * `docs/desktop/office-engine-plugin.md` §10.
 *
 * WINDOWS SHIPS WITHOUT IT TOO, AND ITS TWO FORMER OBJECTIONS ARE ANSWERED RATHER THAN OVERRIDDEN.
 * It used to bundle for two reasons that were specific to it, and both are now closed:
 *
 *   · The kit has NO WebAssembly fallback off Linux — `resolveEngine` throws instead of continuing —
 *     so a pruned Windows tree whose install failed had nothing to fall back to. The published
 *     native packages are what that fallback would have covered, and they exist at the exact version
 *     the kit in the tree pins: `libreoffice-kit-win32-x64@0.1.5` (182 MiB unpacked) and
 *     `libreoffice-kit-win32-arm64@0.1.5` (171.7 MiB), both present on npmmirror and npmjs. The
 *     install is therefore the engine, not a second-best substitute for one.
 *   · The VC-runtime probe read the engine out of the tree, to tell "the Microsoft runtime is
 *     missing" apart from "the engine is missing". Pruning it there would have removed a diagnostic
 *     as well as a package. The probe is `diagnose.js` in
 *     `@qialike/qialike-desktop-office-engine` since 0.4.7 — it runs from the Office row rather than
 *     the shell, and it checks the on-demand install root as well, so the diagnosis still fires for
 *     an engine this build did not ship.
 *
 * MACOS STILL BUNDLES IT, AND THAT IS A SCOPE DECISION RATHER THAN A PREFERENCE: it has not been
 * through the install verification the two platforms above have. Flip it when that phase is done,
 * not by extending this line.
 *
 * @param platform - `process.platform`.
 * @returns `'plugin'` on Linux and Windows, `'bundled'` on macOS.
 */
export function defaultOfficeEngineMode(platform) {
  return platform === 'darwin' ? 'bundled' : 'plugin'
}

/**
 * The Office engine policy for this build.
 *
 * AN UNKNOWN VALUE THROWS rather than falling back. Silently bundling would ship the
 * 145–182 MiB the operator asked to remove; silently pruning would ship an application
 * whose Office preview cannot work. Both are worse than a build that stops and says
 * which word it did not understand.
 *
 * @param env - the environment to read.
 * @param platform - the target platform, defaulting to the host's.
 * @returns `'bundled'` or `'plugin'`.
 * @throws Error when the variable is set to anything else.
 */
export function officeEngineMode(env = process.env, platform = process.platform) {
  const raw = (env[OFFICE_ENGINE_ENV] ?? '').trim().toLowerCase()
  if (raw === '') return defaultOfficeEngineMode(platform)
  if (!OFFICE_ENGINE_MODES.includes(raw)) {
    throw new Error(
      `qialike-desktop: ${OFFICE_ENGINE_ENV} must be one of ${OFFICE_ENGINE_MODES.join(', ')}, `
      + `got ${JSON.stringify(env[OFFICE_ENGINE_ENV])}.`,
    )
  }
  return raw
}

/**
 * Remove the LibreOffice engine packages from the assembled tree.
 *
 * WHY THE ENGINE AND NOT THE ADAPTER. The two are separate npm packages and only one of
 * them is large: `@deepseek-ai/libreoffice-kit` carries the conversion API, the `dsoffice`
 * CLI and the engine-selection logic at 0.29 MiB, and the engine it resolves —
 * `libreoffice-kit-wasm` on Linux, `libreoffice-kit-win32-x64` on Windows — is 145–182 MiB.
 * The prefix therefore keeps its trailing dash, which is what stops this from matching the
 * adapter. Removing the adapter too would break the row that mounts it; removing only the
 * engine turns a working preview into the `unavailable` state the UI already renders.
 *
 * HOW THE ENGINE IS FOUND AGAIN, once this has run: through `NODE_PATH`, which the shell
 * sets to the plugin directory. The kit resolves its engine with `require.resolve.paths()`
 * from its own location, and every directory on that list is consulted — so an engine in a
 * user-writable directory is found while the tree's own copy still takes precedence when
 * one is present. The design record measures both halves of that.
 *
 * EVERY `libreoffice-kit-<target>` PACKAGE GOES, not just this platform's, because a tree
 * holding another platform's engine is a tree holding dead weight. The name is read from
 * each candidate's manifest rather than matched on the directory name, so a directory that
 * merely looks like one is not deleted on that resemblance.
 *
 * IDEMPOTENT, so a second assembly pass over the same tree cannot fail. Runs after
 * {@link delinkWorkspace} — the tree has real directories by then and no link can be left
 * dangling — and before the descriptor is written, which is what keeps the inventory this
 * build publishes in step with the files it ships.
 *
 * @param options.runtimeDir - the assembled runtime tree.
 * @param options.log - progress sink.
 * @returns `{ removed, bytes }`, where `removed` names each package.
 * @throws Error when a package the policy needs to keep is about to be removed.
 */
export function pruneOfficeEngine({ runtimeDir, log = () => {} }) {
  /** Candidates found before anything is deleted, so a refusal can still be a clean one. */
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // A symlink is not followed: this runs on a de-linked tree, and reading through a link
      // to decide what to delete is how a prune reaches a file it was never pointed at.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name.startsWith('libreoffice-kit-')) {
        let name
        try {
          name = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name
        } catch {
          name = undefined
        }
        if (typeof name === 'string' && name.startsWith(OFFICE_ENGINE_PREFIX)) {
          found.push({ name, path })
          continue
        }
      }
      walk(path)
    }
  }
  walk(runtimeDir)

  // The adapter must survive this. Checked before deleting rather than after, because the
  // failure it prevents — a tree whose Office row cannot load at all — is indistinguishable
  // at runtime from a hundred other module-resolution failures.
  const adapterStops = found.filter((entry) => entry.name === OFFICE_ENGINE_PREFIX.slice(0, -1))
  if (adapterStops.length > 0) {
    throw new Error(
      `qialike-desktop: ${OFFICE_ENGINE_PREFIX.slice(0, -1)} matched the engine prefix, so this prune `
      + 'would remove the adapter that resolves an engine instead of the engine itself.',
    )
  }

  const sizeOf = (dir) => {
    let bytes = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { bytes += sizeOf(path); continue }
      if (entry.isFile()) bytes += statSync(path).size
    }
    return bytes
  }

  const removed = []
  let bytes = 0
  for (const entry of found) {
    const size = sizeOf(entry.path)
    rmSync(entry.path, { recursive: true, force: true })
    removed.push({ name: entry.name, bytes: size })
    bytes += size
  }
  // Emptied parent directories are left alone on purpose: `@deepseek-ai/` always holds other
  // packages, and removing a directory this step did not itself empty would be a prune with a
  // wider blast radius than the one it reports.
  if (removed.length > 0) {
    log(`office: pruned ${removed.length} engine package(s), ${(bytes / 1048576).toFixed(1)} MB: `
      + removed.map((entry) => entry.name).join(', '))
  } else {
    log('office: no engine package in this tree to prune')
  }
  return { removed, bytes }
}

/**
 * The directory a workspace member is laid out in, as a Node resolver finds it.
 *
 * `node_modules/<name>`, not `packages/<flattened>`. pnpm places the real directory in
 * `packages/` and links to it, but {@link delinkWorkspace} moves each member to its
 * `node_modules` path and drops the links, so after assembly this is the one place a
 * member lives — and the same place `require`/`import` would resolve it to.
 *
 * @param runtimeDir - the assembled runtime tree.
 * @param name - the package name.
 * @returns the member's directory.
 */
export function memberDir(runtimeDir, name) {
  return join(runtimeDir, 'node_modules', ...name.split('/'))
}

/**
 * Inventory every file in the runtime tree with its size and digest.
 *
 * This is the record that turns DESIGN §12.2 R4 from a hope into a check: a
 * native binary that failed to arrive, or a package that was pruned, shows up
 * as an absent entry rather than as a profile that starts and then runs without
 * the confinement its policy describes.
 *
 * @param root - the runtime tree root.
 * @param options.withDigests - hash each file (slower; the startup check reads them).
 * @returns `{ files, bytes }`.
 */
export function inventoryRuntime(root, { withDigests = true } = {}) {
  const files = []
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // A symlink is recorded as a link, not followed: pnpm's workspace linking
      // makes node_modules mostly links, and following them would both duplicate
      // the inventory and hide which packages are actually linked.
      if (entry.isSymbolicLink()) {
        files.push({ path: relative(root, path).split(sep).join('/'), link: true })
        continue
      }
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile()) continue
      const size = statSync(path).size
      bytes += size
      const record = { path: relative(root, path).split(sep).join('/'), bytes: size }
      if (withDigests) record.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
      files.push(record)
    }
  }
  walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, bytes }
}

/**
 * Write the runtime descriptor beside the tree.
 *
 * The descriptor is the shell's and the Host's shared statement of what this
 * build produced: which target, which harness, which bundles composed, and the
 * exact file inventory. Startup validates it before trusting the tree.
 */
export function writeRuntimeDescriptor({ runtimeDir, descriptor, withDigests = true }) {
  const inventory = inventoryRuntime(runtimeDir, { withDigests })
  const body = {
    schema: 1,
    ...descriptor,
    inventory: { files: inventory.files.length, bytes: inventory.bytes },
    files: inventory.files,
  }
  const path = join(runtimeDir, 'desktop-runtime.json')
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
  // Counts, not the inventory itself: a caller that formats this into a log
  // line should not be handed 11k file records to interpolate.
  return { path, files: inventory.files.length, bytes: inventory.bytes }
}

/**
 * Read and structurally validate a runtime descriptor.
 *
 * @param runtimeDir - the runtime tree root.
 * @returns the descriptor.
 * @throws Error when it is absent or does not describe a runtime tree.
 */
export function readRuntimeDescriptor(runtimeDir) {
  const path = join(runtimeDir, 'desktop-runtime.json')
  if (!existsSync(path)) {
    throw new Error(`qialike-desktop: ${path} is missing; the runtime tree was not assembled by this build`)
  }
  const descriptor = JSON.parse(readFileSync(path, 'utf8'))
  if (descriptor.schema !== 1) {
    throw new Error(`qialike-desktop: runtime descriptor schema ${String(descriptor.schema)} is not supported (expected 1)`)
  }
  if (TARGETS[descriptor.target] === undefined) {
    throw new Error(`qialike-desktop: runtime descriptor names unknown target ${JSON.stringify(descriptor.target)}`)
  }
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) {
    throw new Error('qialike-desktop: runtime descriptor carries no file inventory')
  }
  return descriptor
}
