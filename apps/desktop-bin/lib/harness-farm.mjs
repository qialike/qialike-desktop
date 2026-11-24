/**
 * The package farm: every harness package this application may resolve at
 * runtime, copied whole into a derived tree under this repository.
 *
 * Why copy instead of symlinking to the checkout, which would be cheaper: a
 * symlinked package resolves its own bare imports by walking up from its **real**
 * path, so it would land in the harness's private `node_modules` and pick up the
 * untransformed, unpatched copies. Copying keeps resolution inside the farm,
 * where the build controls what each package sees.
 *
 * This is deliberately **not** the qialike CLI's farm. That one exists to feed
 * `bun build --compile`, so it strips a package down to the JavaScript a
 * single-file bundle can absorb: only `lib/**\/*.js`, with every
 * `createRequire(import.meta.url)('../package.json')` rewritten to a literal,
 * and the `/src` export subpaths deleted. Here packages stay whole, because the
 * runtime has a real filesystem and real `package.json` files, and because the
 * native prebuilds (executables and `.node` addons) must survive as files on
 * disk. Sharing one implementation would have meant writing the union of both
 * behaviours plus a mode switch.
 *
 * @module qialike-desktop/harness-farm
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { assertNotUpstream } from './paths.mjs'

/**
 * Packages pulled in by third-party SDKs whose licences are not MIT.
 *
 * Apache-2.0 for the Agent Client Protocol and OpenAI Codex SDKs, and a
 * commercial "all rights reserved" licence for the Claude Agent SDK. None is
 * referenced by the bundles this application composes, so excluding them keeps
 * them out of the shipped tree entirely rather than shipping an artefact whose
 * redistribution terms we have not cleared.
 *
 * The list mirrors the qialike CLI's `EXCLUDED_NON_MIT_SDK_PACKAGES` so both
 * products refuse the same set.
 */
export const EXCLUDED_NON_MIT_SDK_PACKAGES = new Set([
  '@deepseek-ai/dsh-subagent-claude-code', // pulls @anthropic-ai/claude-agent-sdk (commercial licence)
  '@deepseek-ai/dsh-subagent-codex', // pulls @openai/codex (Apache-2.0)
  '@deepseek-ai/dsh-acp', // pulls @agentclientprotocol/sdk (Apache-2.0)
  '@deepseek-ai/dsh-subagent-acp', // pulls @agentclientprotocol/sdk (Apache-2.0)
  '@deepseek-ai/dsh-session-snapshot', // pulls @agentclientprotocol/sdk (Apache-2.0)
])

/**
 * Where harness packages live, relative to the checkout root.
 *
 * `native/system/packages` is the one root the CLI's scanner does **not** walk,
 * because the CLI stubs every native package out of its single-file bundle. This
 * application ships them for real, so the platform prebuild packages have to be
 * in the farm for the runtime to load them.
 */
export const SCAN_ROOTS = [
  'vendor',
  'packages',
  'native/system/packages',
  // `@deepseek-ai/dsh` — the profile runner the Host spawns through, and the
  // install anchor the runtime resolver walks. It lives under `apps/` because it
  // is the CLI application, not a library. Only this one app directory is
  // scanned: `apps/desktop*` are the upstream Electron shell and its host, which
  // this application replaces rather than composes.
  'apps/cli',
]

/**
 * The scope whose packages the farm carries.
 *
 * Only `@deepseek-ai/*`: the farm is the harness layer. This repository's own
 * packages are workspace members built separately.
 */
export const HARNESS_SCOPE = '@deepseek-ai/'

/** The `native/system` entry package that fans out to the per-platform prebuilds. */
export const NATIVE_ENTRY_PACKAGE = '@deepseek-ai/node-addon-system'

/** Prefix of the per-platform native prebuild packages. */
export const NATIVE_PLATFORM_PREFIX = '@deepseek-ai/node-addon-system-'

/**
 * Directory and file names the farm never carries.
 *
 * `node_modules` would drag in each package's private dependency tree and defeat
 * the point of a farm with a single resolution surface. `*.tsbuildinfo` is
 * ~20 MB of TypeScript incremental state with no runtime meaning. The test
 * directories are large and are never imported by a running profile.
 */
const EXCLUDED_NAMES = new Set(['node_modules', '.git', 'test', 'tests'])

/** Whether one path component should be skipped when copying a package. */
function isExcludedName(name) {
  return EXCLUDED_NAMES.has(name) || name.endsWith('.tsbuildinfo')
}

/**
 * Walk the scan roots and collect every harness package.
 *
 * Two layout shapes are supported: `<root>/<name>` (`vendor/*`, and
 * `native/system/packages/*`) and `<root>/<group>/<name>` (`packages/*\/*`).
 * A directory counts as a package when it holds a `package.json` naming a
 * {@link HARNESS_SCOPE} package.
 *
 * @param harnessRoot - absolute checkout path.
 * @returns a map of package name to `{ dir, group }`, in scan order.
 * @throws Error when a scan root is missing, which means the checkout layout moved.
 */
export function scanPackages(harnessRoot) {
  const found = new Map()
  const add = (dir, group) => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(HARNESS_SCOPE)) return
    if (EXCLUDED_NON_MIT_SDK_PACKAGES.has(manifest.name)) return
    // First writer wins so an earlier scan root shadows a later duplicate,
    // matching Node's own precedence for a hoisted tree.
    if (!found.has(manifest.name)) found.set(manifest.name, { dir, group })
  }

  for (const root of SCAN_ROOTS) {
    const base = join(harnessRoot, root)
    if (!existsSync(base)) {
      throw new Error(
        `qialike-desktop: the harness checkout at ${harnessRoot} has no ${root}/ directory. `
        + 'The checkout layout this build expects has changed; re-check SCAN_ROOTS in '
        + 'apps/desktop-bin/lib/harness-farm.mjs against the harness version.',
      )
    }
    // A scan root may name a package directly (`apps/cli`), a set of packages
    // (`vendor`), or a set of groups of packages (`packages`).
    if (existsSync(join(base, 'package.json'))) {
      add(base, root)
      continue
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      if (existsSync(join(dir, 'package.json'))) {
        add(dir, root)
        continue
      }
      // A group directory (`packages/client/ui-chat`).
      for (const nested of readdirSync(dir, { withFileTypes: true })) {
        if (nested.isDirectory()) add(join(dir, nested.name), root)
      }
    }
  }
  return found
}

/**
 * The name of the native prebuild package for one target.
 * @param target - a key of `TARGETS` in `paths.mjs`.
 * @returns the package name, e.g. `@deepseek-ai/node-addon-system-linux-x64`.
 */
export function nativePlatformPackage(platform, arch) {
  return `${NATIVE_PLATFORM_PREFIX}${platform}-${arch}`
}

/** Flatten a package name to a directory name, as the CLI's farm does. */
export function flattenPackageName(name) {
  return name.replace(/[^A-Za-z0-9-]+/g, '-')
}

/**
 * Copy one package directory into the farm, skipping {@link isExcludedName}.
 *
 * @returns the number of bytes copied, for the build's size report.
 */
function copyPackageTree(from, to) {
  let bytes = 0
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (isExcludedName(entry.name)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      bytes += copyPackageTree(src, dst)
      continue
    }
    if (!entry.isFile()) continue // sockets, fifos: never shipped
    cpSync(src, dst, { preserveTimestamps: true })
    bytes += statSync(src).size
  }
  return bytes
}

/**
 * Remove every `/src` export subpath from a copied manifest.
 *
 * Those entries point at TypeScript sources, which a Node runtime cannot load.
 * The CLI deletes them for the same reason (its comments record that a stray
 * `./src/*` resolution reintroduces top-level `createRequire` reads the build
 * had already rewritten). Nothing in a composed profile resolves them, so
 * deleting them converts a latent runtime failure into an absent subpath.
 *
 * @returns the number of subpaths removed.
 */
export function stripSourceExports(manifest) {
  const exports = manifest.exports
  if (exports === undefined || typeof exports !== 'object' || exports === null) return 0
  let removed = 0
  for (const [subpath, target] of Object.entries(exports)) {
    const value = typeof target === 'string' ? target : target?.default
    const pointsAtSource = typeof value === 'string' && value.includes('/src/')
    if (subpath.includes('/src/') || pointsAtSource) {
      delete exports[subpath]
      removed += 1
    }
  }
  return removed
}

/**
 * Build the farm: copy every scanned package, then apply the size and licence
 * rules that need the copy in place.
 *
 * @param harnessRoot - absolute checkout path.
 * @param farmDir - destination; wiped first so the tree is a pure function of the checkout.
 * @param log - progress sink.
 * @returns a summary for the descriptor.
 */
export function copyFarm({ harnessRoot, farmDir, log = () => {} }) {
  assertNotUpstream(farmDir)
  const packages = scanPackages(harnessRoot)
  rmSync(farmDir, { recursive: true, force: true })
  mkdirSync(farmDir, { recursive: true })

  let bytes = 0
  let strippedSubpaths = 0
  const copied = []
  for (const [name, { dir }] of packages) {
    const dest = join(farmDir, flattenPackageName(name))
    bytes += copyPackageTree(dir, dest)

    const manifestPath = join(dest, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const removed = stripSourceExports(manifest)
    if (removed > 0) {
      strippedSubpaths += removed
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    copied.push({ name, dest })
  }
  log(`farm: copied ${copied.length} packages (${(bytes / 1048576).toFixed(1)} MB), `
    + `stripped ${strippedSubpaths} /src export subpaths`)
  return { packages: copied, bytes, strippedSubpaths }
}

/**
 * Read a native prebuild package's `prebuilds.json`.
 *
 * The manifest is the package's own declaration of what a complete build
 * contains, which is what makes a partial checkout detectable: this repository
 * cannot tell a binary is missing by looking at the package name alone.
 *
 * @returns the parsed manifest, or undefined when the package is not in the farm.
 */
export function readPrebuilds(farmDir, platform, arch) {
  const dir = join(farmDir, flattenPackageName(nativePlatformPackage(platform, arch)))
  const manifestPath = join(dir, 'prebuilds.json')
  if (!existsSync(manifestPath)) return undefined
  return { dir, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

/**
 * How badly a target needs one declared native binary.
 *
 * A `prebuilds.json` lists what a complete build contains; it does not say
 * which entries have an alternative. That distinction decides whether a gap is
 * a refused build or a reported degradation, so it is encoded here with its
 * reason rather than inferred.
 *
 * The classification is not a guess about importance. `dsh-sandbox-local`
 * declares its Linux rung chain as `["bwrap", "landlock"]` and marks both as
 * claiming full enforcement — so landlock is the *fallback* to a system binary
 * the user's machine supplies, and its absence does not leave the shell
 * unconfined. `flock` has no such alternative.
 */
export const NATIVE_BINARY_REQUIREMENT = {
  // Durable file and session writes call into this addon. Nothing else provides
  // it, so a package without it corrupts writes rather than degrading.
  flock: { need: 'required', why: 'durable file writes have no alternative implementation' },
  // The Landlock launcher. Linux prefers bwrap, which is a system binary, and
  // falls back to this only when bwrap cannot build its profile. Its absence
  // narrows the machines that get kernel confinement; it does not remove it.
  'landlock-run': {
    need: 'rung',
    why: 'Linux tries bwrap first and falls back to Landlock; a host without bwrap '
      + 'loses kernel confinement unless this binary ships',
  },
}

/**
 * The requirement for one declared binary, matched by tool name.
 *
 * An unrecognised tool is `required`: a binary this build has never seen is one
 * whose absence has not been reasoned about, and refusing is the direction that
 * cannot silently ship a weaker boundary.
 */
export function nativeBinaryRequirement(binary) {
  return NATIVE_BINARY_REQUIREMENT[binary.tool] ?? {
    need: 'required',
    why: `this build has no fallback note for the ${binary.tool} tool`,
  }
}

/**
 * The platforms whose durable-write path never reaches the native addon.
 *
 * WIN32 IS THE ONLY ONE, and the reason is in the runtime rather than in a
 * preference. The addon is POSIX — `flock(2)` plus a Landlock launcher — and on
 * win32 the session lock and the atomic publishes do not use it at all:
 * `session-persistence-jsonl/src/lease.ts` branches on `process.platform === 'win32'`
 * to `win32.ts`, which binds `CreateSemaphoreW` / `MoveFileExW` out of kernel32
 * through koffi. The harness's own package matrix agrees: `native/system/scripts/
 * github-matrix.mjs` has runners for linux-x64, linux-arm64, darwin-x64 and
 * darwin-arm64 only, and `runnerFor` **throws** for any other platform, so no
 * win32 prebuild can be produced even in principle.
 *
 * WHY IT IS A NAMED LIST AND NOT "WHATEVER HAS NO `prebuilds.json`". Absence from
 * the matrix is *also* true of platforms like freebsd, where `lease.ts` takes the
 * POSIX path and the addon genuinely IS required. Reading bare absence as "needs
 * nothing" would silently drop the durability guarantee on exactly those platforms,
 * which is the direction this gate exists to prevent. So the exemption is spelled
 * out, small enough to argue about, and paired with the staleness check below.
 */
const PLATFORMS_WITHOUT_THE_NATIVE_ADDON = new Set(['win32'])

/**
 * Whether the harness's native entry package declares a prebuild for one target.
 *
 * The entry's `optionalDependencies` are the harness's own enumeration of the
 * platforms this addon is produced for — optional precisely because any one
 * checkout carries only some of them — and `github-matrix.mjs` derives CI and the
 * release matrix from the same set of platform packages.
 *
 * THIS IS THE STALENESS CHECK ON {@link PLATFORMS_WITHOUT_THE_NATIVE_ADDON}. If the
 * harness ever starts shipping a win32 prebuild, this reports "declared" and the
 * exemption stops applying on its own, so an upstream change cannot leave the gate
 * switched off by a list here that nobody re-read.
 *
 * EXPORTED so the build's farm check and the `runtime-tree` gate answer this the same
 * way. They inspect different trees — the farm and the assembled runtime — but they
 * must not disagree about which platforms have a prebuild at all, and a second copy
 * of this rule is exactly how they would come to.
 *
 * FAILS TOWARDS REFUSING: an absent or unreadable entry manifest is not evidence
 * that the target needs nothing, so it reports "declared" and the caller refuses.
 *
 * @param entryManifestPath - path to `@deepseek-ai/node-addon-system/package.json`.
 * @param wanted - the platform package name to look for.
 * @returns true when the target's prebuild is declared, or when that cannot be shown not to be.
 */
export function declaresNativePlatform(entryManifestPath, wanted) {
  if (!existsSync(entryManifestPath)) return true
  try {
    const manifest = JSON.parse(readFileSync(entryManifestPath, 'utf8'))
    return Object.prototype.hasOwnProperty.call(manifest.optionalDependencies ?? {}, wanted)
  } catch {
    return true
  }
}

/**
 * Whether a platform needs no prebuild from this tree, because the addon is not
 * built for it.
 *
 * Both facts are required: the platform must be one the addon is not produced for
 * (see {@link PLATFORMS_WITHOUT_THE_NATIVE_ADDON}), and the entry manifest must
 * confirm that by not declaring it. The second condition is what keeps a future
 * upstream win32 prebuild from being silently ignored.
 *
 * @param entryManifestPath - path to the entry package's manifest in the tree being checked.
 * @param platform - target platform.
 * @param arch - target architecture.
 * @returns whether the target legitimately has no prebuild package.
 */
export function targetHasNoNativePrebuild(entryManifestPath, platform, arch) {
  if (!PLATFORMS_WITHOUT_THE_NATIVE_ADDON.has(platform)) return false
  return !declaresNativePlatform(entryManifestPath, nativePlatformPackage(platform, arch))
}

/**
 * Check that every binary a target's native package declares is present in the farm.
 *
 * Each gap is classified through {@link nativeBinaryRequirement}. Callers decide
 * what to do with a `rung` gap — report it, or refuse — but a `required` gap is
 * always fatal, because the failure it produces is a package that builds
 * successfully and then cannot write durably.
 *
 * One more conditional applies on Linux: the platform package ships a `system.node`
 * per libc, and only the host's own libc is loaded. A musl build on a glibc
 * machine is therefore not a gap, and vice versa.
 *
 * A THIRD CONDITIONAL IS WHETHER THE TARGET USES THE ADDON AT ALL, and it is
 * checked first. Without it, the one platform that legitimately has no prebuild —
 * win32 — is the one platform the build refuses, because "no `prebuilds.json`" was
 * read as "an unbuilt checkout". See {@link targetHasNoNativePrebuild}, whose
 * exemption is deliberately narrow: any other platform without a prebuild still
 * refuses, which is what keeps this from becoming a general "missing native package
 * is fine" rule.
 *
 * @param farmDir - the farm root.
 * @param platform - target platform.
 * @param arch - target architecture.
 * @param libc - the target's libc (`glibc` or `musl`), when the platform has one.
 * @returns one entry per missing binary, empty when complete.
 */
export function verifyNativeBinaries(farmDir, platform, arch, libc) {
  const wanted = nativePlatformPackage(platform, arch)
  const found = readPrebuilds(farmDir, platform, arch)
  if (found === undefined) {
    const entryManifest = join(farmDir, flattenPackageName(NATIVE_ENTRY_PACKAGE), 'package.json')
    if (targetHasNoNativePrebuild(entryManifest, platform, arch)) return []
    return [{
      tool: undefined,
      package: wanted,
      path: 'prebuilds.json',
      need: 'required',
      why: `the native prebuild package for ${platform}-${arch} is not present in the checkout`,
      reason: `the native prebuild package for ${platform}-${arch} is not in the farm at all`,
    }]
  }
  const missing = []
  for (const binary of found.manifest.binaries ?? []) {
    // A per-libc binary for the other libc is never loaded, so its absence is
    // not a gap. Without this, every glibc host would fail on the musl entry.
    if (binary.libc !== undefined && libc !== undefined && binary.libc !== libc) continue
    const file = join(found.dir, binary.path)
    if (existsSync(file)) continue
    const requirement = nativeBinaryRequirement(binary)
    missing.push({
      tool: binary.tool,
      package: nativePlatformPackage(platform, arch),
      path: binary.path,
      need: requirement.need,
      why: requirement.why,
      reason: `declared in prebuilds.json as ${binary.tool} (${binary.kind}) but absent from the checkout`,
    })
  }
  return missing
}

/**
 * Prune native prebuild packages that do not belong to the target.
 *
 * The entry package declares all four platforms as `optionalDependencies`, so a
 * checkout may hold all of them. Shipping the other three would add tens of
 * megabytes of unusable binaries, and on macOS a foreign `.node` fails
 * signature verification.
 *
 * A target matches exactly one package: this build produces per-architecture
 * releases, never a universal binary (DESIGN §3 D10), so there is no case where
 * two platform packages belong in one tree.
 *
 * @returns the names removed.
 */
export function selectNativePrebuilds({ farmDir, platform, arch, log = () => {} }) {
  const wanted = nativePlatformPackage(platform, arch)
  const removed = []
  for (const entry of readdirSync(farmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(farmDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
    if (typeof name === 'string' && name.startsWith(NATIVE_PLATFORM_PREFIX) && name !== wanted) {
      rmSync(join(farmDir, entry.name), { recursive: true, force: true })
      removed.push(name)
    }
  }
  if (removed.length > 0) log(`farm: pruned ${removed.length} foreign native package(s): ${removed.join(', ')}`)
  return removed
}

/**
 * The third-party packages the farm's own manifests require.
 *
 * Returned as names rather than installed here: the install is pnpm's job and
 * belongs to the runtime-tree step, which knows the profile bundle closure. This
 * function exists so a build can report what it will need and so the descriptor
 * records a closure that can be diffed when the harness moves.
 *
 * @param farmDir - the farm root.
 * @returns a sorted list of bare specifiers outside {@link HARNESS_SCOPE}.
 */
export function externalDependencies(farmDir) {
  const names = new Set()
  for (const entry of readdirSync(farmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(farmDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (!name.startsWith('@')) {
          // A bare name may still be a builtin; the runtime step resolves those.
          if (!name.startsWith('node:')) names.add(name)
          continue
        }
        if (!name.startsWith(HARNESS_SCOPE)) names.add(name)
      }
    }
  }
  return [...names].sort()
}

/** The farm-relative path of a package, for descriptor and error messages. */
export function farmPathOf(farmDir, name) {
  return relative(farmDir, join(farmDir, flattenPackageName(name)))
}

/**
 * Every bare module specifier a package's built JavaScript actually imports.
 *
 * WHY THIS EXISTS, AND WHY THE DECLARED GRAPH IS NOT ENOUGH. A workspace member
 * is only resolvable if something lists it, so the runtime tree is built by
 * walking manifests. That walk cannot see a **phantom dependency**: a package
 * whose built output imports a module its manifest never declares, relying on
 * the monorepo's hoisting to make it resolvable. The harness has one —
 * `@deepseek-ai/dsh-app-boot/lib/index.js` imports
 * `@deepseek-ai/cordis-plugin-group`, which appears in no dependency field of
 * its manifest — and the first boot failed on exactly that import.
 *
 * The qialike CLI compensates with a hand-written list of cordis builtins. A
 * list is a guess that rots the next time the harness adds an import, so this
 * reads the imports out of the built files instead. The result is the *actual*
 * graph rather than the declared one, which is what the runtime will execute.
 *
 * @param dir - a package directory.
 * @returns the distinct bare specifiers found under `lib/`.
 */
export function scanPackageImports(dir) {
  const found = new Set()
  const lib = join(dir, 'lib')
  if (!existsSync(lib)) return found
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
      let source
      try {
        source = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const specifier of bareSpecifiers(source)) found.add(specifier)
    }
  }
  walk(lib)
  return found
}

/**
 * The bare specifiers in one JavaScript source.
 *
 * A regex rather than a parser: this runs over another repository's compiled
 * output, whose toolchain is not ours to depend on, and only the specifier text
 * is needed. All four import forms plus `require` are matched so a lazily
 * imported plugin cannot hide.
 */
export function bareSpecifiers(source) {
  const found = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      // Relative and absolute paths resolve within the package; Node builtins
      // are supplied by the runtime; a `data:`/`file:` URL is not a dependency.
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
      if (specifier.startsWith('data:') || specifier.startsWith('file:')) continue
      found.push(specifier)
    }
  }
  return found
}

/**
 * The package part of a specifier: `@scope/name/sub/path` -> `@scope/name`.
 */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Grow a member set until it is closed under actual imports.
 *
 * Starts from the declared closure and repeatedly adds farm packages that a
 * member's built code imports, so a phantom dependency pulls its package in
 * rather than failing at boot. Third-party specifiers reached this way are
 * returned as well: they are the ones pnpm must have installed, and comparing
 * them against the declared set is how a missing install becomes visible.
 *
 * @param options.farmDir - the farm root.
 * @param options.members - declared member names; not mutated.
 * @param options.log - progress sink.
 * @returns `{ members, thirdParty, added }`.
 */
export function expandClosureFromImports({ farmDir, members, log = () => {} }) {
  const closure = new Set(members)
  const thirdParty = new Set()
  const added = []
  const scanned = new Set()
  const queue = [...members]
  while (queue.length > 0) {
    const name = queue.shift()
    if (scanned.has(name)) continue
    scanned.add(name)
    const dir = join(farmDir, flattenPackageName(name))
    if (!existsSync(dir)) continue
    for (const specifier of scanPackageImports(dir)) {
      const packageName = packageNameOf(specifier)
      const local = packageName.startsWith('@deepseek-ai/') || packageName.startsWith('@qialike/')
      if (!local) { thirdParty.add(packageName); continue }
      if (closure.has(packageName)) continue
      // A locally-scoped import the farm does not carry is a real gap: a
      // deliberate exclusion (a non-MIT SDK) or a moved package. Reported by
      // the caller through its own missing list, not added here.
      if (!existsSync(join(farmDir, flattenPackageName(packageName), 'package.json'))) continue
      closure.add(packageName)
      added.push(packageName)
      queue.push(packageName)
    }
  }
  if (added.length > 0) {
    log(`closure: +${added.length} package(s) reached only through built imports `
      + `(undeclared in any manifest): ${added.join(', ')}`)
  }
  return { members: closure, thirdParty, added }
}
