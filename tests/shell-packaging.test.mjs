/**
 * Two ways the application can be complete in the repository and broken once
 * packaged.
 *
 * Both were found by launching the packaged AppImage, and neither was visible to
 * any test that existed at the time:
 *
 *   1. **The shell imported the harness by bare specifier.**
 *      `project-manager.ts` imported `@deepseek-ai/dsh-app-boot` — a package that
 *      resolves for nothing in this workspace, because the harness lives in a
 *      read-only checkout and only becomes resolvable *inside the runtime tree*.
 *      The shell died on its first import, in development as much as in a
 *      package, before Electron painted anything. Nothing caught it because
 *      `tsc` is satisfied by the ambient declarations in `types/`, which is
 *      precisely what those declarations are for.
 *
 *   2. **`extraResources` silently dropped `node_modules`.** electron-builder's
 *      file matcher treats that directory specially, so the copy delivered 13105
 *      of the tree's ~35000 files and the Host could not resolve a single import.
 *
 * The first is a source guard over the shell's compiled output. The second tests
 * the pack hook against a real tree, because the property that matters —
 * symlinks surviving — cannot be asserted by reading the configuration.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyRuntimeTree, measureTree, normalizeReadModes } from '../apps/desktop-bin/lib/pack-runtime.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

/**
 * Whether the shell has been compiled yet.
 *
 * `lib/` is not committed — `pnpm run build:packages` produces it, and the build
 * order in README.md runs that before anything else — so on a fresh checkout these
 * checks have nothing to read. Skipped rather than failed, which is the same
 * treatment the runtime-tree suites give an unassembled `dist/`: a missing build
 * is a step not yet taken, not a defect.
 */
const compiled = existsSync(join(ROOT, 'apps', 'desktop', 'lib', 'main.js'))

describe.skipIf(!compiled)('the shell’s own module resolution', () => {
  /** Every compiled shell module, plus the preload. */
  const shellModules = [
    ...globSync('apps/desktop/lib/**/*.js', { cwd: ROOT }),
    'apps/desktop/preload/preload.cjs',
  ]

  it('has compiled output to check', () => {
    expect(shellModules.length).toBeGreaterThan(0)
  })

  it('imports no bare @deepseek-ai specifier', () => {
    // Only *import* forms — `from '…'`, `import('…')`, `require('…')`. The
    // directory is full of legitimate mentions: paths assembled with `join`, and
    // prose. Matching those would make the guard cry wolf and be ignored.
    const offenders = []
    for (const file of shellModules) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const patterns = [
        /\bfrom\s*['"](@deepseek-ai\/[^'"]+)['"]/gu,
        /\bimport\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/gu,
        /\brequire\s*\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/gu,
      ]
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) offenders.push(`${file} imports ${match[1]}`)
      }
    }
    expect(
      offenders,
      'the shell runs in Electron’s main process, where no node_modules holds the harness. '
      + 'Anything it needs from the runtime tree must be imported by absolute path — see '
      + 'loadProfileApi in apps/desktop/src/project-manager.ts.',
    ).toEqual([])
  })

  it('loads the profile API from the runtime tree instead', () => {
    // The positive half: the capability was moved, not dropped.
    const source = readFileSync(join(ROOT, 'apps/desktop/src/project-manager.ts'), 'utf8')
    expect(source).toContain('pathToFileURL')
    expect(source).toContain("'node_modules', '@deepseek-ai', 'dsh-app-boot'")
  })
})

describe('copyRuntimeTree', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-pack-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * A tree shaped like the runtime one: real files, a workspace symlink, and a
   * native binary, which is what the copy has to preserve.
   */
  function fixture() {
    const from = join(root, 'runtime', 'dsh')
    mkdirSync(join(from, 'packages', '-pkg-a', 'lib'), { recursive: true })
    mkdirSync(join(from, 'node_modules', '@scope'), { recursive: true })
    mkdirSync(join(from, 'packages', '-native', 'bin'), { recursive: true })
    writeFileSync(join(from, 'desktop-runtime.json'), '{}\n')
    writeFileSync(join(from, 'packages', '-pkg-a', 'package.json'), '{}\n')
    writeFileSync(join(from, 'packages', '-pkg-a', 'lib', 'index.js'), 'export {}\n')
    writeFileSync(join(from, 'packages', '-native', 'bin', 'system.node'), 'binary\n')
    // The relative symlink a pnpm workspace uses to expose a member by name.
    symlinkSync(join('..', '..', 'packages', '-pkg-a'), join(from, 'node_modules', '@scope', 'pkg-a'))
    return { from, appOutDir: join(root, 'out', 'linux-unpacked') }
  }

  it('copies everything, symlinks included', () => {
    const { from, appOutDir } = fixture()
    const source = measureTree(from)
    expect(source.symlinks).toBe(1)

    const result = copyRuntimeTree({ from, appOutDir })
    expect(result.files).toBe(source.files)
    expect(result.symlinks).toBe(source.symlinks)
    expect(source.links).toHaveLength(1)
    // The link resolves *through* the copy, which is the property the Host needs
    // and the one a copy with the wrong options loses.
    const link = join(appOutDir, 'resources', 'dsh', 'node_modules', '@scope', 'pkg-a', 'lib', 'index.js')
    expect(readFileSync(link, 'utf8')).toContain('export')
  })

  it('refuses a tree that was never assembled', () => {
    const { appOutDir } = fixture()
    const empty = join(root, 'runtime', 'nothing')
    mkdirSync(empty, { recursive: true })
    expect(() => copyRuntimeTree({ from: empty, appOutDir })).toThrow(/no assembled runtime tree/)
  })

  it('refuses a tree whose links point outside it', () => {
    // A dangling link is the shape a symlink-destroying copy leaves behind: the
    // count still matches, the files are all present, and nothing resolves.
    const { from, appOutDir } = fixture()
    rmSync(join(from, 'node_modules', '@scope', 'pkg-a'))
    symlinkSync(join('..', '..', 'packages', 'gone'), join(from, 'node_modules', '@scope', 'pkg-a'))
    expect(() => copyRuntimeTree({ from, appOutDir })).toThrow(/do not resolve in the packaged runtime tree/)
  })

  it('reports what it copied, not what it was asked to copy', () => {
    // The counts come back from the destination, so a caller logging them is
    // reporting the artifact rather than the intention.
    const { from, appOutDir } = fixture()
    const result = copyRuntimeTree({ from, appOutDir })
    expect(result.to).toBe(join(appOutDir, 'resources', 'dsh'))
    expect(result.files).toBeGreaterThan(0)
  })

  it('replaces a previous copy rather than merging with it', () => {
    const { from, appOutDir } = fixture()
    copyRuntimeTree({ from, appOutDir })
    const destination = join(appOutDir, 'resources', 'dsh')
    writeFileSync(join(destination, 'stale-from-a-previous-run.txt'), 'stale\n')
    copyRuntimeTree({ from, appOutDir })
    expect(() => readFileSync(join(destination, 'stale-from-a-previous-run.txt'), 'utf8')).toThrow()
  })
})


// POSIX-ONLY BY SUBJECT, not by inconvenience. `normalizeReadModes` exists for one
// packaging boundary: `dpkg` installs a deb as `root:root` under `/opt`, so a file
// that arrives `0600` is unreadable by the user who runs the application. Windows has
// neither that install model nor POSIX mode bits — `chmod` there sets only the
// read-only attribute, so `mode | 0o444` is already satisfied at `0666` and the
// function correctly reports that it changed nothing. Asserting the modes below on
// Windows would assert the host. The NSIS package it produces instead relies on the
// per-user installation directory, so there is no equivalent step to cover.
describe.skipIf(process.platform === 'win32')('normalizeReadModes', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-modes-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('makes a 0600 file readable, which is what a deb install requires', () => {
    // The defect this exists for. `dpkg` installs the tree as root:root under
    // /opt, so a 0600 file is unreadable by the user who runs the application —
    // and the files that ended up 0600 were the hand-written client bundles, so
    // the provider settings page, the branding and the theme picker silently did
    // not load. Git cannot express the difference (its index has only 100644 and
    // 100755), which is why it is fixed here rather than by chmodding sources.
    const file = join(root, 'client.js')
    writeFileSync(file, 'x\n', { mode: 0o600 })
    expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(normalizeReadModes(root)).toBe(1)
    // Every read bit, so it does not matter which user the installer names.
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it('leaves the executable bit alone', () => {
    // The direction that would be a worse bug than the one being fixed: this tree
    // carries `bin/rg` and the native prebuilds, and a blanket 0644 would make
    // ripgrep unrunnable.
    const binary = join(root, 'rg')
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 })
    const before = statSync(binary).mode & 0o111
    expect(before).toBe(0o100)
    normalizeReadModes(root)
    expect(statSync(binary).mode & 0o777).toBe(0o744)
    // Unchanged, not "some execute bit exists": for a real binary the owner bit is
    // the one that matters, and a normalizer that cleared it would be caught here.
    expect(statSync(binary).mode & 0o111).toBe(before)
  })

  it('reports what it changed, and changes nothing on a second pass', () => {
    writeFileSync(join(root, 'a.js'), 'x\n', { mode: 0o600 })
    writeFileSync(join(root, 'b.js'), 'x\n', { mode: 0o644 })
    expect(normalizeReadModes(root)).toBe(1)
    // Idempotent: a build that reported work every time would hide a real change.
    expect(normalizeReadModes(root)).toBe(0)
  })

  it('does not follow symlinks out of the tree', () => {
    // A 0600 file *outside* the tree, reached by a link inside it. Following the
    // link would chmod a file in the shared pnpm store, which is not ours to change.
    const outside = join(root, '..', `qialike-outside-${String(process.pid)}.js`)
    writeFileSync(outside, 'x\n', { mode: 0o600 })
    const inside = join(root, 'nested')
    mkdirSync(inside, { recursive: true })
    symlinkSync(outside, join(inside, 'link.js'))
    normalizeReadModes(inside)
    expect(statSync(outside).mode & 0o777).toBe(0o600)
    rmSync(outside, { force: true })
  })
})
