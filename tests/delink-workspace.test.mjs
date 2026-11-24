/**
 * De-linking the assembled runtime tree.
 *
 * WHY THIS IS WORTH A SUITE. `delinkWorkspace` runs last in `pnpm run build` and turns
 * pnpm's development layout — real directories in `packages/`, reached through symlinks —
 * into the resolved layout: one real directory per package, at the path a Node resolver
 * looks in. Everything downstream of it changes shape at once. The NSIS installer
 * dereferences symlinks, so before this step one package (`schemastery`, 135 links) was
 * materialised 135 times: the installer payload was 2,317 MB of a 573 MB tree, 207,549
 * files instead of 38,877, with 295-character paths past Windows' 260-character limit.
 *
 * The three ways it can be wrong are all silent in production:
 *
 *   · **a link is missed** — one surviving symlink is one package the installer duplicates
 *     again, and nothing at runtime would look wrong;
 *   · **a member is not moved** — the package stays unreachable through `node_modules`, so
 *     the Host fails at boot with a module-resolution error far from this step;
 *   · **two members share a name** — one silently wins, and a wrong module is the hardest
 *     kind of failure to trace back here.
 *
 * The fixtures are built on disk rather than mocked, because what is being tested is how
 * the function treats real symlinks and real directories.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { delinkWorkspace } from '../apps/desktop-bin/lib/runtime-tree.mjs'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qialike-delink-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a package's manifest and one built file, and return its directory. */
function makePackage(dirName, name, extra = {}) {
  const dir = join(root, 'packages', dirName)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', ...extra }, null, 2)}\n`)
  writeFileSync(join(dir, 'lib', 'index.js'), `export const who = ${JSON.stringify(name)}\n`)
  return dir
}

/**
 * Link a package into a `node_modules` directory the way pnpm does.
 *
 * `junction` on Windows: a directory symlink there needs elevation or Developer Mode,
 * while a junction does not — and the fixture still exercises the same link kinds the
 * build produces, because `delinkWorkspace` moves the *target* rather than following the
 * link, so it treats a junction and a directory symlink identically.
 *
 * An absolute target keeps the fixture readable. The build's own links are relative, and
 * a relative fixture would only be testing `path.relative` arithmetic.
 */
function linkPackage(linkPath, targetDir) {
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Every reparse point under a tree. */
function symlinksUnder(dir) {
  const found = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) { found.push(p); continue }
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return found
}

describe('delinkWorkspace', () => {
  it('moves each member to its node_modules path and leaves no links', () => {
    makePackage('-pkg-a', 'pkg-a')
    const scoped = makePackage('-scope-pkg-b', '@scope/pkg-b')
    linkPackage(join(root, 'node_modules', 'pkg-a'), join(root, 'packages', '-pkg-a'))
    linkPackage(join(root, 'node_modules', '@scope', 'pkg-b'), scoped)

    const result = delinkWorkspace({ runtimeDir: root })

    expect(result.moved).toBe(2)
    // `removedLinks` counts the links the SECOND pass deleted — the nested ones. A
    // root-level link is not "removed" but *replaced*: the move takes its place, so
    // counting it as removed would double-count the same path. That distinction is why
    // this asserts zero here and the nested-link case below asserts a count.
    expect(result.removedLinks).toBe(0)
    // Real directories, not links — this is the whole point: NSIS has nothing to dereference.
    expect(lstatSync(join(root, 'node_modules', 'pkg-a')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(root, 'node_modules', '@scope', 'pkg-b')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(root, 'node_modules', 'pkg-a', 'lib', 'index.js'), 'utf8')).toContain('"pkg-a"')
    // And the package's content arrived intact, not just its directory.
    expect(JSON.parse(readFileSync(join(root, 'node_modules', '@scope', 'pkg-b', 'package.json'), 'utf8')).name)
      .toBe('@scope/pkg-b')
  })

  it('counts and removes the nested links, which are the ones that used to recurse', () => {
    // The 955-link layer in the real tree, and the recursive copies it caused: one of those
    // nested links is what made `schemastery` materialise 135 times in the installer.
    makePackage('-pkg-a', 'pkg-a')
    linkPackage(join(root, 'node_modules', 'pkg-a'), join(root, 'packages', '-pkg-a'))
    linkPackage(join(root, 'node_modules', 'pkg-a', 'node_modules', 'dep'), join(root, 'packages', '-pkg-a'))

    const result = delinkWorkspace({ runtimeDir: root })
    expect(result.moved).toBe(1)
    expect(result.removedLinks).toBe(1)
    expect(symlinksUnder(root)).toEqual([])
  })

  it('leaves the tree with zero symlinks, which is what the installer needs', () => {
    makePackage('-pkg-a', 'pkg-a')
    linkPackage(join(root, 'node_modules', 'pkg-a'), join(root, 'packages', '-pkg-a'))
    // A nested link, which is the shape that recursed: a member needing its own dependency.
    linkPackage(join(root, 'node_modules', 'pkg-a', 'node_modules', 'dep'), join(root, 'packages', '-pkg-a'))

    delinkWorkspace({ runtimeDir: root })
    expect(symlinksUnder(root)).toEqual([])
  })

  it('removes the emptied packages/ directory and the nested node_modules that held only links', () => {
    makePackage('-pkg-a', 'pkg-a')
    linkPackage(join(root, 'node_modules', 'pkg-a'), join(root, 'packages', '-pkg-a'))
    // A deep chain of link-only node_modules, as the real tree has (depth 6).
    linkPackage(join(root, 'node_modules', 'pkg-a', 'node_modules', 'l1', 'node_modules', 'l2'), join(root, 'packages', '-pkg-a'))

    const result = delinkWorkspace({ runtimeDir: root })

    // `packages/` is gone: every member moved out of it, so it is empty.
    expect(existsSync(join(root, 'packages'))).toBe(false)
    // The nested node_modules that held only links is gone too, which is what stops the
    // recursive copies from lengthening every path beneath them.
    expect(existsSync(join(root, 'node_modules', 'pkg-a', 'node_modules'))).toBe(false)
    expect(result.prunedDirs).toBeGreaterThan(0)
    // The member itself survived the pruning.
    expect(existsSync(join(root, 'node_modules', 'pkg-a', 'lib', 'index.js'))).toBe(true)
  })

  it('keeps a nested package that is real rather than a link', () => {
    // The conflict case that must survive: if two versions of one name exist, the nested
    // one is a real directory and pruning must not touch it. Asserted because the pruning
    // walks the whole tree and "remove empty directories" is one condition away from
    // "remove the directories I just moved things into".
    makePackage('-pkg-a', 'pkg-a')
    linkPackage(join(root, 'node_modules', 'pkg-a'), join(root, 'packages', '-pkg-a'))
    const nestedReal = join(root, 'node_modules', 'pkg-a', 'node_modules', 'dep')
    mkdirSync(join(nestedReal, 'lib'), { recursive: true })
    writeFileSync(join(nestedReal, 'package.json'), '{ "name": "dep", "version": "2.0.0" }\n')
    writeFileSync(join(nestedReal, 'lib', 'index.js'), 'export const v = 2\n')

    delinkWorkspace({ runtimeDir: root })

    expect(existsSync(join(nestedReal, 'lib', 'index.js'))).toBe(true)
  })

  it('refuses two members claiming one name instead of letting one win', () => {
    // Silently keeping one would ship a wrong module, and the failure would surface as a
    // runtime error a long way from the build step that caused it.
    makePackage('-dup-one', 'dup')
    makePackage('-dup-two', 'dup')
    linkPackage(join(root, 'node_modules', 'dup'), join(root, 'packages', '-dup-one'))

    expect(() => delinkWorkspace({ runtimeDir: root })).toThrow(/two runtime-tree members claim the package name "dup"/u)
  })

  it('refuses a member with no name, which has no node_modules path to hoist to', () => {
    const dir = join(root, 'packages', '-nameless')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ "version": "1.0.0" }\n')

    expect(() => delinkWorkspace({ runtimeDir: root })).toThrow(/declares no usable "name"/u)
  })

  it('is a no-op on a tree that was never a workspace', () => {
    // Reached when the step runs against an already-flat tree, and it must not throw:
    // a second call in a build script should be harmless, not a failure.
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    expect(delinkWorkspace({ runtimeDir: root })).toEqual({ moved: 0, removedLinks: 0, prunedDirs: 0 })
  })
})
