/**
 * Copy the assembled runtime tree into a packaged application, and prove it
 * arrived intact.
 *
 * WHY THIS IS A HOOK AND NOT `extraResources`. electron-builder's declarative
 * `extraResources` did not copy the tree. Configured as
 * `{ from: 'dist/runtime/dsh', to: 'dsh' }`, it produced a `resources/dsh`
 * containing `packages/` and all four top-level files — 13105 files — and **no
 * `node_modules` at all**. Its file matcher treats `node_modules` specially
 * (dependency collection owns that directory), so the one directory the Host
 * resolves every single import through was the one it dropped.
 *
 * The failure is close to undiagnosable from the outside: the application
 * installs, launches, paints its window, and then the Host exits with a module
 * resolution error naming a package that is visibly present in the repository.
 * That is the R4 class this repository names elsewhere — a package that starts
 * normally and quietly does less.
 *
 * So the copy is explicit (`cpSync`, which is `cp -R`), and it is *verified*
 * against the source before the pack continues. Two properties matter and
 * neither survives a naive copy:
 *
 *   · **Symlinks.** The tree is a pnpm workspace, so 301 `node_modules` entries
 *     are relative links into `packages/`. They are copied as links, not
 *     dereferenced: dereferencing would multiply the tree's size and break the
 *     identity the descriptor's digests were taken over.
 *   · **Natives.** `bin/glibc/system.node` must be a real file the Host can
 *     `dlopen`.
 *
 * @module qialike-desktop/pack-runtime
 */

import { chmodSync, cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Count files, directories, and symlinks under a tree, and list the links.
 *
 * Symlinks are counted as links and **not** followed, so the totals on both sides
 * of a copy are comparable: dereferencing during a copy would inflate the
 * destination, and comparing counts is what catches it.
 *
 * The link paths are returned as well because counting them is not enough — a
 * copy can preserve the *number* of links while pointing them somewhere useless.
 * The destinations are checked individually by {@link copyRuntimeTree}.
 *
 * @param root - the tree to measure.
 * @returns counts plus every symlink's tree-relative path.
 */
export function measureTree(root) {
  const totals = { files: 0, directories: 0, symlinks: 0, links: [] }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        totals.symlinks += 1
        totals.links.push(relative(root, path))
        continue
      }
      if (entry.isDirectory()) { totals.directories += 1; walk(path); continue }
      totals.files += 1
    }
  }
  walk(root)
  return totals
}

/**
 * Give every regular file in a tree a mode the intended user can read.
 *
 * WHY THIS IS NEEDED AT ALL. Whatever mode a file happens to have in the working
 * copy becomes the mode inside the package, and `write`-style tooling creates files
 * `0600`. For a deb that is fatal in a way nothing else here would catch: `dpkg`
 * installs the tree as `root:root` under `/opt`, so a `0600` file is unreadable by
 * the user who runs the application — and the files that ended up `0600` are the
 * hand-written client bundles, i.e. the provider settings page, the branding and
 * the theme picker simply do not load. The compiled and generated files are `0644`
 * because a compiler wrote them, which is why this only ever bit part of the tree.
 *
 * Git does not carry the distinction (its index has only `100644` and `100755`, so a
 * fresh clone is fine), which is exactly what makes this worth fixing at the
 * packaging boundary rather than by asking contributors to chmod: the mode that
 * breaks a package is invisible in review.
 *
 * ONLY read bits are added, and the executable bit is left alone. That is
 * load-bearing in the other direction: this tree carries `bin/rg` and the native
 * `.node` prebuilds, and a blanket `0644` would strip the bit that makes ripgrep
 * runnable.
 *
 * @param root - the tree to normalize.
 * @param log - progress sink.
 * @returns how many files were changed.
 */
export function normalizeReadModes(root, log = () => {}) {
  let changed = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // Symlinks are skipped: `chmod` would follow one into the shared store
      // outside the tree, and the link's own permissions are not what is read.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(path); continue }
      const mode = statSync(path).mode & 0o7777
      // `0o444` is every read bit, which covers owner, group and other without
      // deciding who the installer will make the owner.
      const wanted = mode | 0o444
      if (wanted !== mode) {
        chmodSync(path, wanted)
        changed += 1
      }
    }
  }
  walk(root)
  if (changed > 0) log(`runtime tree: ${String(changed)} file(s) made readable`)
  return changed
}

/**
 * Copy the runtime tree beside the packaged application.
 *
 * @param options.from - the assembled tree (`dist/runtime/dsh`).
 * @param options.appOutDir - electron-builder's output for one platform
 *   (`dist/packages/linux-unpacked`).
 * @param options.log - progress sink.
 * @returns the destination and what it holds.
 * @throws Error when the source is absent, or the copy does not match it.
 */
export function copyRuntimeTree({ from, appOutDir, log = () => {} }) {
  if (!existsSync(join(from, 'desktop-runtime.json'))) {
    throw new Error(
      `qialike-desktop: no assembled runtime tree at ${from}. Assemble it before packaging: `
      + 'pnpm run build',
    )
  }
  const to = join(appOutDir, 'resources', 'dsh')
  rmSync(to, { recursive: true, force: true })
  // `verbatimSymlinks` keeps the link text as authored; `dereference: false` is
  // what makes them links rather than copies of their targets.
  cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true })

  // Before measuring, so the verification below sees what will actually ship.
  normalizeReadModes(to, log)

  const source = measureTree(from)
  const copied = measureTree(to)
  log(`runtime tree: ${String(copied.files)} files, ${String(copied.symlinks)} symlinks -> ${to}`)

  for (const key of ['files', 'directories', 'symlinks']) {
    if (source[key] !== copied[key]) {
      throw new Error(
        `qialike-desktop: the packaged runtime tree does not match the assembled one: `
        + `${key} ${String(copied[key])} at ${to} vs ${String(source[key])} at ${from}. `
        + 'A partial copy produces an application whose Host cannot resolve its imports; '
        + 'see apps/desktop-bin/lib/pack-runtime.mjs for why this is checked rather than assumed.',
      )
    }
  }

  // Every link, not a sample. The count above cannot see a link that arrived
  // pointing nowhere, and that is exactly what a copy with the wrong options
  // produces — the tree looks complete and the Host resolves nothing. Checking
  // all 900-odd costs milliseconds and removes the question of whether the sample
  // was representative.
  const dangling = source.links.filter((link) => !existsSync(join(to, link)))
  if (dangling.length > 0) {
    throw new Error(
      `qialike-desktop: ${String(dangling.length)} of ${String(source.symlinks)} workspace symlinks do `
      + `not resolve in the packaged runtime tree (first: ${dangling[0]}). The Host resolves every `
      + 'import through them, so the application would install and then fail on its first request.',
    )
  }
  return { to, files: copied.files, directories: copied.directories, symlinks: copied.symlinks }
}

/** Whether a path is a directory holding a built Web dist. */
export function distExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The tree-relative path of a native binary, for diagnostics.
 *
 * `node_modules/@deepseek-ai/…`, the resolved path, not `packages/-deepseek-ai-…`, the
 * flattened workspace-member directory: the runtime tree is de-linked after assembly, so
 * the diagnostic has to name the path that actually exists or it sends the reader to a
 * directory that is not there.
 */
export function nativeProbePath() {
  return join('node_modules', '@deepseek-ai', 'node-addon-system-linux-x64', 'bin', 'glibc', 'system.node')
}

/** The tree-relative path of a file, for diagnostics. */
export function relativeTo(root, path) {
  return relative(root, path)
}
