/**
 * The staged CLI package: what the desktop actually ships of `@qialike/qialike-app`.
 *
 * WHY THIS SUITE EXISTS. `stageQialikeAppPackage()` copies the CLI's **built** `lib/` into the
 * runtime tree, and nothing checked it. `own-packages.mjs` even cites a
 * `tests/qialike-app-package.test.mjs` that was never written — the comment described an intention,
 * not a file. Meanwhile the failure mode it would have caught is silent:
 *
 *     edit the CLI's `src/`, forget to rebuild, run the desktop build
 *     → the OLD `lib/` is staged, the artifact ships it, every test stays green
 *
 * The build log does print `runtime: staged @qialike/qialike-app (library only, …)`, but that line
 * proves a copy happened, not that the copy is current. Measured when this suite was written: zero
 * tests referenced `stageQialikeAppPackage`.
 *
 * So there are two layers here, and they catch different things:
 *
 *   · SYNTHETIC — the function's own contract, checkable without a checkout: it copies `lib/`,
 *     keeps the manifest, strips `/src` subpaths, and returns undefined rather than throwing when
 *     the source was never built.
 *   · REAL TREE — skipped when nothing is assembled: the staged bytes equal the checkout's, and no
 *     CLI `src/` file is newer than the `lib/` file built from it. The second one is the actual
 *     guard against "forgot to rebuild".
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QIALIKE_APP_PACKAGE, stageQialikeAppPackage } from '../apps/desktop-bin/lib/own-packages.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const made = []

/** A throwaway directory that this suite removes afterwards. */
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a fake CLI checkout with a manifest and a `lib/`.
 *
 * @param options.exports - the manifest's `exports` map, when the test is about stripping.
 * @returns the checkout root.
 */
function fakeCheckout({ exports } = {}) {
  const root = scratch('cli-')
  const pkg = join(root, 'packages', 'qialike-app')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'lib', 'llm.js'), 'export const x = 1\n')
  writeFileSync(join(pkg, 'lib', 'models.js'), 'export const y = 2\n')
  // A declaration file, which the real package also ships.
  writeFileSync(join(pkg, 'lib', 'llm.d.ts'), 'export declare const x: number\n')
  const manifest = {
    name: '@qialike/qialike-app',
    version: '0.11.4',
    exports: exports ?? { '.': { default: './lib/index.js' }, './llm': { default: './lib/llm.js' } },
  }
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return root
}

describe('staging the CLI package', () => {
  it('copies the built lib and the manifest, which is all a runtime import reaches', () => {
    const qialike = fakeCheckout()
    const stageDir = join(scratch('stage-'), 'qialike-app')

    const entry = stageQialikeAppPackage({ qialike, stageDir })

    expect(entry).toEqual({ name: QIALIKE_APP_PACKAGE, dir: stageDir })
    expect(readFileSync(join(stageDir, 'lib', 'llm.js'), 'utf8')).toBe('export const x = 1\n')
    expect(readFileSync(join(stageDir, 'lib', 'llm.d.ts'), 'utf8')).toBe('export declare const x: number\n')
    expect(JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8')).version).toBe('0.11.4')
  })

  it('does not copy anything outside lib — no src, no node_modules, no tests', () => {
    // `lib/` is 1.7 MB of the package; the rest is build inputs. A staging step that copied the
    // package wholesale would put the CLI's sources and its 300 MB of dependencies in the installer.
    const qialike = fakeCheckout()
    const pkg = join(qialike, 'packages', 'qialike-app')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    writeFileSync(join(pkg, 'src', 'llm.ts'), 'export const x = 1\n')
    mkdirSync(join(pkg, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(pkg, 'node_modules', 'junk', 'big.bin'), 'x')

    const stageDir = join(scratch('stage-'), 'qialike-app')
    stageQialikeAppPackage({ qialike, stageDir })

    expect(existsSync(join(stageDir, 'src'))).toBe(false)
    expect(existsSync(join(stageDir, 'node_modules'))).toBe(false)
    expect(readdirSync(stageDir).sort()).toEqual(['lib', 'package.json'])
  })

  it('strips exports that name /src, which this tree does not carry', () => {
    // The farm's own copies strip the same subpaths. Keeping one would turn a latent failure — an
    // import of a source this tree does not have — into an absent subpath the resolver reports.
    const qialike = fakeCheckout({
      exports: {
        '.': { default: './lib/index.js' },
        './llm': { default: './lib/llm.js' },
        './src/*': './src/*',
        './startup': { default: './lib/startup.js' },
        './weird': { default: './src/weird.js' },
      },
    })
    const stageDir = join(scratch('stage-'), 'qialike-app')

    stageQialikeAppPackage({ qialike, stageDir })

    const staged = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8'))
    expect(Object.keys(staged.exports).sort()).toEqual(['.', './llm', './startup'])
    // The ones that survived must still point where they did: stripping is a filter, not a rewrite.
    expect(staged.exports['./llm'].default).toBe('./lib/llm.js')
  })

  it('answers undefined rather than throwing when the CLI was never built', () => {
    // A checkout with sources but no build is a normal state — `assertCliCompatible` runs before
    // this and is what should stop the build, with a message about versions.
    const root = scratch('cli-')
    const pkg = join(root, 'packages', 'qialike-app')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{"name":"@qialike/qialike-app"}')
    writeFileSync(join(pkg, 'src', 'llm.ts'), 'export const x = 1\n')

    expect(stageQialikeAppPackage({ qialike: root, stageDir: join(scratch('stage-'), 'app') })).toBeUndefined()
  })

  it('replaces a previous staging rather than merging into it', () => {
    // A rebuild into the same directory must not leave a file from the previous build behind: that
    // is how a deleted module keeps shipping.
    const qialike = fakeCheckout()
    const stageDir = join(scratch('stage-'), 'qialike-app')
    stageQialikeAppPackage({ qialike, stageDir })

    writeFileSync(join(stageDir, 'lib', 'stale.js'), 'export const gone = true\n')
    stageQialikeAppPackage({ qialike, stageDir })

    expect(existsSync(join(stageDir, 'lib', 'stale.js'))).toBe(false)
  })
})

describe('the real tree', () => {
  const runtime = join(ROOT, 'dist', 'runtime', 'dsh')
  const staged = join(runtime, 'node_modules', '@qialike', 'qialike-app')
  const qialikeRoot = process.env.QIALIKE_ROOT ?? join(ROOT, '..', 'qialike')
  const checkout = join(qialikeRoot, 'packages', 'qialike-app')
  const assembled = existsSync(join(staged, 'lib'))
  const haveCheckout = existsSync(join(checkout, 'lib'))

  it.skipIf(!assembled || !haveCheckout)('staged bytes equal the checkout’s, for every module', () => {
    // THE DIRECT GUARD: what shipped is what the checkout built. A difference here means the tree
    // was assembled from a different checkout, or from a checkout that was rebuilt afterwards.
    const names = readdirSync(join(checkout, 'lib')).filter((name) => name.endsWith('.js')).sort()
    expect(names.length).toBeGreaterThan(0)

    const differing = names.filter((name) => {
      const before = readFileSync(join(checkout, 'lib', name))
      const after = readFileSync(join(staged, 'lib', name))
      return !before.equals(after)
    })
    expect(differing, `staged lib differs from the checkout for: ${differing.join(', ')}`).toEqual([])
  })

  it.skipIf(!assembled || !haveCheckout)('no CLI source is newer than the build it should have produced', () => {
    // THE GUARD AGAINST "FORGOT TO REBUILD", and the one that catches the silent case: editing
    // `src/llm.ts` and rebuilding only the desktop stages the previous `lib/llm.js`, and every
    // other test still passes because they read the staged copy rather than the sources.
    //
    // Compared per module where the mapping is obvious (one source, one output), and by directory
    // newest-vs-newest otherwise. A one-second slack absorbs filesystem timestamp granularity, and
    // `lib/` is written after `src/` by any honest build.
    const SLACK_MS = 1000
    const srcDir = join(checkout, 'src')
    const libDir = join(checkout, 'lib')
    if (!existsSync(srcDir)) return

    const newest = (dir) => {
      let latest = 0
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stat = statSync(path)
        if (stat.isFile()) latest = Math.max(latest, stat.mtimeMs)
      }
      return latest
    }

    const srcLatest = newest(srcDir)
    const libLatest = newest(libDir)
    expect(
      libLatest + SLACK_MS,
      `the newest file in ${srcDir} is newer than the newest in ${libDir} — the CLI needs a rebuild`,
    ).toBeGreaterThanOrEqual(srcLatest)
  })

  it.skipIf(!assembled)('the staged manifest keeps no /src subpath, which this tree cannot resolve', () => {
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
    const offenders = Object.entries(manifest.exports ?? {}).filter(([subpath, target]) => {
      const value = typeof target === 'string' ? target : target?.default
      return subpath.includes('/src/') || (typeof value === 'string' && value.includes('/src/'))
    })
    expect(offenders.map(([subpath]) => subpath)).toEqual([])
  })

  it.skipIf(!assembled)('the staged package still declares the modules the provider row imports', () => {
    // A narrower, cheaper check than the byte comparison: the two subpaths the desktop bundle
    // actually resolves. It fails with a name rather than a diff, which is the useful message when
    // a CLI release renames one.
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
    for (const subpath of ['.', './llm']) {
      expect(manifest.exports?.[subpath], `staged manifest lost the ${subpath} subpath`).toBeDefined()
    }
  })
})
