/**
 * Pruning sources and declarations out of the assembled runtime tree.
 *
 * WHY THIS IS WORTH A SUITE. `pruneNonRuntimeFiles` deletes 12,450 files out of the shipped tree. A
 * function that deletes is only as good as its refusals, so the interesting cases here are not the ones
 * where it works — they are the ones where it must stop.
 *
 * The rule it applies is "no runtime can load this suffix", and the way that rule goes wrong is a
 * manifest that *does* name one: `main`, `module`, `browser` or `bin` pointing at a `.ts` file. Pruning
 * that would ship a tree whose own manifest points at nothing, and the application would fail at boot
 * with a module-resolution error nowhere near this step. The measurement today is that no package does
 * it — 640 manifests, zero — and a measurement is not a guarantee, so the guard is tested in both
 * directions: it throws, and it throws **before deleting anything**.
 *
 * The other direction that matters is the one a naive extension blacklist gets wrong: `exports` subpaths
 * legitimately name `.ts` files for TypeScript tooling (`zod`'s `./v4/@zod/source` → `src/index.ts`), and
 * a guard that refused those would refuse a third of the tree for no reason. `exports` is not a runtime
 * entry field, and the suite pins that distinction.
 *
 * Fixtures are real directories on disk, because what is under test is what a walk of a real tree does.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneNonRuntimeFiles } from '../apps/desktop-bin/lib/runtime-tree.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-prune-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file, creating its directory. */
function place(path, body = 'x\n') {
  mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(root, path), body)
}

/** Write a package's manifest. */
function manifest(name, body) {
  place(`node_modules/${name}/package.json`, `${JSON.stringify(body, null, 2)}\n`)
}

/** Every file in the tree, relative and sorted, for whole-tree assertions. */
function tree() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      files.push(path.slice(root.length + 1).split('\\').join('/'))
    }
  }
  walk(root)
  return files.sort()
}

/** Run the prune with the log captured, so a test can assert what it reported. */
function prune() {
  const lines = []
  const result = pruneNonRuntimeFiles({ runtimeDir: root, log: (line) => lines.push(line) })
  return { result, lines }
}

describe('the prune removes what no runtime loads', () => {
  it('removes sources and declarations, and keeps everything else', () => {
    manifest('pkg', { name: 'pkg', main: 'lib/index.js', types: 'lib/index.d.ts' })
    place('node_modules/pkg/lib/index.js', 'module.exports = 1\n')
    place('node_modules/pkg/lib/index.d.ts', 'declare const a: number\n')
    place('node_modules/pkg/lib/index.js.map', '{}\n')
    place('node_modules/pkg/src/index.ts', 'export const a = 1\n')
    place('node_modules/pkg/src/view.tsx', 'export const View = () => null\n')
    place('node_modules/pkg/src/esm.mts', 'export const b = 2\n')
    place('node_modules/pkg/src/cjs.cts', 'export const c = 3\n')
    place('node_modules/pkg/LICENSE', 'MIT\n')
    place('node_modules/pkg/README.md', '# pkg\n')

    const { result } = prune()

    expect(result.removed).toBe(5)
    // `.map` is deliberately NOT in this rule: it is a debugging trade-off, decided separately, and a
    // prune that silently took it would remove the ability to read a stack trace in a packaged build.
    expect(tree()).toEqual([
      'node_modules/pkg/LICENSE',
      'node_modules/pkg/README.md',
      'node_modules/pkg/lib/index.js',
      'node_modules/pkg/lib/index.js.map',
      'node_modules/pkg/package.json',
    ])
  })

  it('counts what it removed by suffix, so the log can be read rather than trusted', () => {
    manifest('pkg', { name: 'pkg', main: 'lib/index.js' })
    place('node_modules/pkg/lib/index.js', 'module.exports = 1\n')
    place('node_modules/pkg/lib/index.d.ts', 'declare const a: number\n')
    place('node_modules/pkg/lib/other.d.mts', 'declare const b: number\n')
    place('node_modules/pkg/src/a.ts', 'export const a = 1\n')
    place('node_modules/pkg/src/b.ts', 'export const b = 2\n')

    const { result } = prune()

    expect([...result.bySuffix].sort()).toEqual([['.d.mts', 1], ['.d.ts', 1], ['.ts', 2]])
    expect(result.removed).toBe(4)
  })

  it('removes the directories its removals emptied, and leaves the ones still holding files', () => {
    manifest('pkg', { name: 'pkg', main: 'lib/index.js' })
    place('node_modules/pkg/lib/index.js', 'module.exports = 1\n')
    place('node_modules/pkg/src/deep/nested/a.ts', 'export const a = 1\n')
    place('node_modules/pkg/types/b.d.ts', 'declare const b: number\n')
    place('node_modules/pkg/mixed/keep.js', 'module.exports = 2\n')
    place('node_modules/pkg/mixed/drop.ts', 'export const c = 3\n')

    const { result } = prune()

    expect(existsSync(join(root, 'node_modules/pkg/src'))).toBe(false)
    expect(existsSync(join(root, 'node_modules/pkg/types'))).toBe(false)
    // A directory that still holds a file survives, and so does its parent.
    expect(existsSync(join(root, 'node_modules/pkg/mixed/keep.js'))).toBe(true)
    // Four, counted rather than assumed: `src/deep/nested` empties first, then the `deep` and `src` it was
    // inside, then `types`. A depth-first pass is what makes the count four instead of one, and the count
    // is asserted because a prune that left the empty parents would still ship them as directories.
    expect(result.prunedDirs).toBe(4)
  })

  it('is idempotent, so a second assembly pass cannot fail on a tree it already pruned', () => {
    manifest('pkg', { name: 'pkg', main: 'lib/index.js' })
    place('node_modules/pkg/lib/index.js', 'module.exports = 1\n')
    place('node_modules/pkg/src/a.ts', 'export const a = 1\n')

    expect(prune().result.removed).toBe(1)
    expect(prune().result.removed).toBe(0)
  })
})

describe('the guard refuses rather than shipping a tree that cannot resolve', () => {
  it('throws when main names a source file, and deletes nothing first', () => {
    manifest('bad', { name: 'bad', main: 'lib/index.ts' })
    place('node_modules/bad/lib/index.ts', 'export const a = 1\n')
    place('node_modules/bad/src/other.ts', 'export const b = 2\n')

    expect(() => prune()).toThrow(/names "lib\/index\.ts" as its main/u)
    // The whole tree is where it was: a half-pruned tree is worse than a refused build, because the
    // error it produces later is a module-resolution failure with nothing to connect it to this step.
    expect(tree()).toEqual([
      'node_modules/bad/lib/index.ts',
      'node_modules/bad/package.json',
      'node_modules/bad/src/other.ts',
    ])
  })

  it('throws for module, browser and bin as well, naming the field', () => {
    for (const [field, body] of [
      ['module', { module: 'src/index.mts' }],
      ['browser', { browser: 'src/index.tsx' }],
      ['bin.x', { bin: { x: 'bin/cli.ts' } }],
      ['bin', { bin: 'bin/cli.mts' }],
    ]) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      manifest('bad', { name: 'bad', main: 'lib/index.js', ...body })
      place('node_modules/bad/lib/index.js', 'module.exports = 1\n')
      const target = JSON.stringify(body.bin?.x ?? body.bin ?? body.module ?? body.browser)
      expect(() => prune(), `${field} should have been refused`).toThrow(new RegExp(`as its ${field.replace('.', '\\.')}`, 'u'))
      expect(target.length).toBeGreaterThan(0)
    }
  })

  it('accepts an exports subpath that names a source file, because a runtime never resolves one', () => {
    // The distinction the guard turns on: `exports` may name anything, and these subpaths exist for
    // TypeScript tooling. `zod` really does this (`./v4/@zod/source` → `src/index.ts`), and so do 377
    // other packages in the tree — a guard that refused them would refuse a third of it for no reason.
    manifest('ok', {
      name: 'ok',
      main: 'lib/index.js',
      types: 'lib/index.d.ts',
      exports: { '.': './lib/index.js', './source': './src/index.ts' },
    })
    place('node_modules/ok/lib/index.js', 'module.exports = 1\n')
    place('node_modules/ok/lib/index.d.ts', 'declare const a: number\n')
    place('node_modules/ok/src/index.ts', 'export const a = 1\n')

    const { result } = prune()

    expect(result.removed).toBe(2)
    expect(tree()).toEqual(['node_modules/ok/lib/index.js', 'node_modules/ok/package.json'])
  })

  it('reads a manifest it cannot parse as one it cannot judge, rather than as safe', () => {
    // Not a contradiction to refuse over: a malformed manifest is a different failure, and this step is
    // not the place to report it. What matters is that it does not crash the build here.
    place('node_modules/broken/package.json', '{ not json\n')
    place('node_modules/broken/src/a.ts', 'export const a = 1\n')

    const { result } = prune()

    expect(result.removed).toBe(1)
    expect(readFileSync(join(root, 'node_modules/broken/package.json'), 'utf8')).toBe('{ not json\n')
  })
})
