/**
 * Gate: the assembled runtime tree is the one the descriptor describes.
 *
 * This is the check DESIGN §12.2 R4 asks for, moved to where it can do the most
 * good. A packaging run can succeed, produce a plausible installer, and ship a
 * tree that is missing a native binary — and the resulting application starts
 * normally and then runs its shell without the confinement its own policy text
 * describes. The only symptom is a boundary that is not there.
 *
 * So the descriptor records a digest for every file, and this compares the tree
 * against it. Three failures are distinguished, because they mean different
 * things:
 *
 *   · **Missing** — a file the build recorded is gone. Something pruned it after
 *     assembly, which is how a native binary disappears.
 *   · **Changed** — a file whose bytes differ. Either a build wrote into an
 *     assembled tree, or two builds were interleaved.
 *   · **Unrecorded** — a file present but absent from the descriptor. Harmless in
 *     itself, but it means the inventory is not the whole tree, and the next
 *     person to trust it will be wrong.
 *
 * @module qialike-desktop/gates/runtime-tree
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DIST_DIR } from '../lib/paths.mjs'
import { NATIVE_ENTRY_PACKAGE, nativePlatformPackage, targetHasNoNativePrebuild } from '../lib/harness-farm.mjs'
import { ENGINE_EXECUTABLE, engineBinDir, engineRuntimeRequirements } from '../lib/vc-runtime.mjs'

/** The runtime tree this gate inspects. */
export function runtimeDir(root = DIST_DIR) {
  return join(root, 'runtime', 'dsh')
}

/** Walk a tree into a `path -> { bytes, sha256 }` map, following no symlinks. */
function inventory(root) {
  const files = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) { files.set(relative(root, path).split(sep).join('/'), 'link'); continue }
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile()) continue
      const body = readFileSync(path)
      files.set(relative(root, path).split(sep).join('/'), {
        bytes: statSync(path).size,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
    }
  }
  walk(root)
  return files
}

/**
 * Check one runtime tree against its descriptor.
 *
 * @param root - the tree root.
 * @returns one violation per problem, empty when clean.
 */
export function checkRuntimeTree(root = runtimeDir()) {
  const violations = []
  const descriptorPath = join(root, 'desktop-runtime.json')
  if (!existsSync(descriptorPath)) {
    return [{
      detail: `no runtime tree at ${root}. Assemble it first: pnpm run build`,
    }]
  }
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))

  // A descriptor assembled with `--skip-digests` cannot be verified, and saying
  // so is better than reporting a clean tree that was never checked.
  const recorded = descriptor.files ?? []
  const digestless = recorded.filter((file) => file.link !== true && file.sha256 === undefined)
  if (digestless.length > 0) {
    violations.push({
      detail: `the descriptor records ${digestless.length} file(s) without a digest, so the tree cannot `
        + 'be verified. Rebuild without --skip-digests before packaging.',
    })
    return violations
  }

  const actual = inventory(root)
  let missing = 0
  let changed = 0
  const changedSample = []
  for (const file of recorded) {
    const found = actual.get(file.path)
    if (found === undefined) {
      missing += 1
      if (missing <= 10) changedSample.push(`missing: ${file.path}`)
      continue
    }
    if (file.link === true) continue
    if (found === 'link') {
      changed += 1
      if (changedSample.length < 10) changedSample.push(`became a link: ${file.path}`)
      continue
    }
    if (found.sha256 !== file.sha256) {
      changed += 1
      if (changedSample.length < 10) changedSample.push(`changed: ${file.path}`)
    }
  }

  const recordedPaths = new Set(recorded.map((file) => file.path))
  let unrecorded = 0
  for (const path of actual.keys()) {
    if (recordedPaths.has(path)) continue
    // The descriptor itself is written after the inventory is taken.
    if (path === 'desktop-runtime.json') continue
    unrecorded += 1
    if (unrecorded <= 5) changedSample.push(`unrecorded: ${path}`)
  }

  if (missing > 0) {
    violations.push({
      detail: `${missing} file(s) recorded in the descriptor are absent from the tree. `
        + `A pruned native binary shows up here. Examples:\n      ${changedSample.filter((line) => line.startsWith('missing')).join('\n      ')}`,
    })
  }
  if (changed > 0) {
    violations.push({
      detail: `${changed} file(s) differ from the recorded digest — the tree was modified after assembly.`,
    })
  }
  if (unrecorded > 0) {
    violations.push({
      detail: `${unrecorded} file(s) present but absent from the descriptor; the inventory is incomplete.`,
    })
  }
  return violations
}

/**
 * Check that the native binaries the descriptor declared as present really are.
 *
 * Separate from the digest check because it answers a different question: not
 * "is this the tree that was built" but "does this tree confine the shell". The
 * build records which rungs it shipped; this confirms they are still there.
 */
export function checkNativeRungs(root = runtimeDir()) {
  const descriptorPath = join(root, 'desktop-runtime.json')
  if (!existsSync(descriptorPath)) return []
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  const violations = []

  const platform = descriptor.platform
  const arch = descriptor.arch
  if (typeof platform !== 'string' || typeof arch !== 'string') return violations

  const packageDir = join(root, 'node_modules', ...nativePlatformPackage(platform, arch).split('/'))
  const prebuildsPath = join(packageDir, 'prebuilds.json')
  if (!existsSync(prebuildsPath)) {
    // A PLATFORM THE ADDON IS NOT BUILT FOR HAS NO PREBUILD TO BE MISSING. win32 is
    // the case: it reaches koffi and `MoveFileExW` rather than POSIX `flock` and
    // Landlock, and the harness's release matrix produces no win32 package at all.
    // `targetHasNoNativePrebuild` is the shared rule, so this gate and the build's own
    // check cannot disagree about which platforms have a prebuild.
    //
    // THE NARROW READING IS THE POINT: every other platform missing this package still
    // fails here, because "absent from the matrix" is also true of freebsd, where the
    // POSIX path is taken and the addon is required.
    //
    // What this check is worth on win32 is bounded and worth stating: the runtime tree
    // is assembled without `optionalDependencies` (the foreign platform packages are
    // pruned as unresolvable), so the entry manifest here no longer declares any
    // platform and the decision reduces to the named list. The staleness guard — a
    // future upstream win32 prebuild cancelling the exemption — is therefore live in
    // `verifyNativeBinaries`, which reads the farm's intact manifest, and inert here.
    const entryManifest = join(root, 'node_modules', ...NATIVE_ENTRY_PACKAGE.split('/'), 'package.json')
    if (targetHasNoNativePrebuild(entryManifest, platform, arch)) return violations
    violations.push({
      detail: `the ${platform}-${arch} native prebuild package is absent from the runtime tree; `
        + 'the shell cannot be confined on this target.',
    })
    return violations
  }
  // Only the host libc's addon is loaded, so the other is not expected.
  const libc = descriptor.native?.libc
  for (const binary of JSON.parse(readFileSync(prebuildsPath, 'utf8')).binaries ?? []) {
    if (binary.libc !== undefined && libc !== undefined && binary.libc !== libc) continue
    const file = join(packageDir, binary.path)
    if (existsSync(file)) continue
    // A degraded rung is reported as a warning the release notes can carry; a
    // required binary is a violation, because nothing else provides it.
    const requirement = descriptor.native?.gaps?.find((gap) => gap.path === binary.path)?.need
    if (requirement === 'rung') continue
    violations.push({
      detail: `the ${binary.tool} binary (${binary.path}) is absent from the runtime tree.`,
    })
  }
  return violations
}

/**
 * Check that the tree's Office engine has its external runtime requirements recorded.
 *
 * The engine is a statically linked LibreOffice build that imports no LibreOffice library, so it
 * runs on a machine with no LibreOffice — measured by reading its import table and by watching a
 * live render load nothing from an installed copy. Its MSVC runtime imports are the one thing that
 * can still stop it there, and when they are absent the process never starts: the user sees an
 * Office preview that fails and a message pointing at the file rather than at the missing runtime.
 *
 * This project does not ship those DLLs, so there is nothing in the tree to check for presence.
 * What is checked is that the descriptor records what the engine needs, read out of the binary.
 * Two ways that can be wrong, both silent at run time and both caught here:
 *
 *   · the descriptor records nothing, so the shell has no names to report and can only say that
 *     Office previews are unavailable without saying why;
 *   · the tree's engine imports something the recorded list omits, which happens when a build
 *     skipped the step that reads the binary, or when an engine was replaced after assembly.
 *
 * A tree without the engine is clean: the engine package is a `win32-x64` optional dependency, so
 * Linux and macOS trees never contain it.
 */
export function checkEngineRuntime(root = runtimeDir()) {
  const descriptorPath = join(root, 'desktop-runtime.json')
  if (!existsSync(descriptorPath)) return []
  const violations = []

  const binDir = engineBinDir(root)
  const enginePath = join(binDir, ENGINE_EXECUTABLE)
  if (!existsSync(enginePath)) return violations

  const recorded = JSON.parse(readFileSync(descriptorPath, 'utf8')).engineRuntime
  if (recorded === undefined || recorded.present !== true || !Array.isArray(recorded.required)) {
    violations.push({
      detail: 'the descriptor records no external runtime requirement for a tree whose Office '
        + 'engine has one; a user missing the Visual C++ Redistributable would be told the preview '
        + 'failed without being told which runtime to install.',
    })
    return violations
  }

  // Compared case-insensitively: the image spells these names in upper case and the recorded list
  // keeps that spelling, so a round-trip through a different case must not read as a gap.
  const recordedNames = new Set(recorded.required.map((name) => String(name).toLowerCase()))
  const unrecorded = engineRuntimeRequirements(enginePath)
    .filter((name) => !recordedNames.has(name.toLowerCase()))
  if (unrecorded.length > 0) {
    violations.push({
      detail: `the Office engine in the tree imports ${unrecorded.join(', ')}, which the descriptor `
        + 'does not record; the startup check would not name them on a machine that lacks them.',
    })
  }
  return violations
}

/**
 * Assert the tree carries no sources or declarations.
 *
 * WHAT THIS PROTECTS. `pruneNonRuntimeFiles` removes them during assembly, and this gate is what makes
 * that rule hold after the fact: without it, a dependency added later could reintroduce a `src/` tree and
 * nothing would notice, because the descriptor is written *from* the tree — an inventory agrees with
 * whatever is there, including files that should not be. The gate is therefore the only place the
 * property is stated independently of the artifact.
 *
 * WHY THE SUFFIX LIST IS DUPLICATED HERE RATHER THAN IMPORTED. Importing it would make this check agree
 * with the prune by construction, including when the prune is wrong — the failure this exists to catch is
 * precisely a change to what counts as a runtime file, so the list has to be written twice or it is not a
 * check. `NON_RUNTIME_SUFFIXES` in `lib/runtime-tree.mjs` is the other copy, and the two are meant to be
 * read together.
 *
 * @param root - the tree root.
 * @returns one violation per problem, empty when clean.
 */
export function checkNoNonRuntimeFiles(root = runtimeDir()) {
  if (!existsSync(root)) {
    return [{ detail: `no runtime tree at ${root}. Assemble it first: pnpm run build` }]
  }
  const suffixes = ['.d.ts', '.d.mts', '.d.cts', '.ts', '.tsx', '.mts', '.cts']
  const found = []
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(path); continue }
      if (!suffixes.some((suffix) => entry.name.endsWith(suffix))) continue
      found.push(relative(root, path).split(sep).join('/'))
      bytes += statSync(path).size
    }
  }
  walk(root)
  if (found.length === 0) return []
  return [{
    detail: `the tree carries ${found.length} source or declaration file(s), ${(bytes / 1048576).toFixed(1)} MB, `
      + 'which no runtime loads — assembly should have pruned them, so either the prune did not run or a '
      + `dependency reintroduced one. Examples:\n      ${found.slice(0, 5).join('\n      ')}`,
  }]
}

/**
 * Gate entry point.
 * @returns `{ ok, violations }`.
 */
export function run() {
  const violations = [
    ...checkRuntimeTree(),
    ...checkNativeRungs(),
    ...checkEngineRuntime(),
    ...checkNoNonRuntimeFiles(),
  ]
  return { ok: violations.length === 0, violations }
}

/** Render the gate result for a CLI run. */
export function format(result) {
  if (result.ok) return 'runtime-tree: ok'
  return ['runtime-tree: FAILED', ...result.violations.map((v) => `  - ${v.detail}`)].join('\n')
}
